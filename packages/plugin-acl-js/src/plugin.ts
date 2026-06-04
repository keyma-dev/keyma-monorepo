import {
	type KeymaAction,
	type AdapterProjection,
	type KeymaDatabaseAdapter,
	type KeymaServerPlugin,
	type PluginServerHandle,
	type RequestContext,
	type SchemaMetadata, KeymaOperation, type KeymaWriteAction
} from "@keyma/runtime-js";
import { AclDenied, AclFieldForbidden, ACL_PLUGIN_NAME } from "./errors.js";
import type { AclPluginOptions, AclRule } from "./types.js";
import {
	ACL_ROLE_ASSIGNMENT_SCHEMA,
	ACL_ROLE_ASSIGNMENT_SCHEMA_NAME,
	ACL_ROLE_SCHEMA,
	ACL_ROLE_SCHEMA_NAME,
	ACL_RULE_SCHEMA,
	ACL_RULE_SCHEMA_NAME,
} from "./schemas.js";
import {
	filterApplicable,
	getPredicateFields,
	getStripFields,
	loadRulesFor,
	rememberPredicateFields,
	rememberStripFields,
} from "./rule-loader.js";
import {
	combineAnd,
	combineNor,
	combineOr,
	substituteFilter,
} from "./filter-merge.js";
import {
	allowedReadFields,
	allowedWriteFields,
	augmentProjectionForPredicate,
	fieldsReferenced,
	trimProjection,
} from "./field-check.js";
import { KeymaAclAdmin } from "./admin.js";

const PLUGIN_NAME = ACL_PLUGIN_NAME;

const RESERVED_SCHEMA_NAMES: readonly string[] = [
	ACL_RULE_SCHEMA_NAME,
	ACL_ROLE_SCHEMA_NAME,
	ACL_ROLE_ASSIGNMENT_SCHEMA_NAME,
];

export type CreateAclPluginResult = {
	plugin: KeymaServerPlugin;
	admin: KeymaAclAdmin;
};

export class AclServerPlugin implements KeymaServerPlugin {
	readonly name = PLUGIN_NAME;
	private adapter!: KeymaDatabaseAdapter;

	constructor(private options: AclPluginOptions) {

	}

	/** Called once after the server is constructed. */
	async init(server: PluginServerHandle) {

		this.adapter = server.adapter;

		for (const name of RESERVED_SCHEMA_NAMES) {
			if (server.schemas.some((s) => s.name === name)) {
				throw new Error(
					`${PLUGIN_NAME}: schema "${name}" is already registered on the host KeymaServer. `
				);
			}
		}
		await server.addSchema(ACL_RULE_SCHEMA);
		await server.addSchema(ACL_ROLE_SCHEMA);
		await server.addSchema(ACL_ROLE_ASSIGNMENT_SCHEMA);
	}

	/**
	 * Observe or early-reject the operation. Throw a KeymaPluginError to abort.
	 */
	async beforeOperation(
		ctx: RequestContext,
		op: KeymaOperation,
	) {
		if (ctx.identity?.isSystem === true) return;
		if (op.op === "traverse") return; // transformOperation handles traversals
	}

	/** Rewrite the where clause for list/read/update/delete. Return undefined
	 *  to leave unchanged. The returned filter may use top-level logical
	 *  operators `$and` / `$or` / `$nor` (each carrying an array of sub-filter
	 *  objects) to combine clauses; adapters translate these recursively. */
	async transformFilter(
		ctx: RequestContext,
		schema: SchemaMetadata,
		where: Record<string, unknown>,
		action: KeymaAction,
	) {
		if (ctx.identity?.isSystem === true) return undefined;
		const rules = filterApplicable(
			await loadRulesFor(this.adapter, ctx),
			schema.name,
			action,
		);
		
		const extraFields = new Set<string>();
		const merged = await this.mergeFilters(ctx, schema.name, where, action, rules, extraFields);

		// Stash predicate field references so transformProjection can ensure
		// the adapter receives them.
		if (extraFields.size > 0) {
			rememberPredicateFields(ctx, schema, extraFields);
		}

		return merged;
	}

	/**
	 * Trim the projection. Return undefined to leave unchanged.
	 */
	async transformProjection(
		ctx: RequestContext,
		schema: SchemaMetadata,
		projection: AdapterProjection,
		action: KeymaAction,
	) {
		if (ctx.identity?.isSystem === true) return undefined;
		let result = await this.recursiveTransformProjection(ctx, schema, projection, action);
		if (result === undefined) result = projection;

		const predicateFields = getPredicateFields(ctx, schema);
		if (predicateFields !== undefined && predicateFields.size > 0) {
			const {projection: aug, added} = augmentProjectionForPredicate(
				result,
				predicateFields,
				schema,
			);
			result = aug;
			// Only fields the plugin had to ADD get stripped on the way out;
			// anything the caller explicitly projected stays in the response.
			rememberStripFields(ctx, schema, added);
		}
		return result;
	}

	private async recursiveTransformProjection(
		ctx: RequestContext,
		schema: SchemaMetadata,
		projection: AdapterProjection,
		action: KeymaAction,
	): Promise<AdapterProjection | undefined> {
		if (action === "create") {
			return applyReadTrim(ctx, schema, projection, "read", this.adapter);
		}
		const rules = filterApplicable(
			await loadRulesFor(this.adapter, ctx),
			schema.name,
			action,
		);
		const allowed = allowedReadFields(rules);
		let result: AdapterProjection = projection;
		if (allowed !== undefined) {
			result = trimProjection(result, allowed);
		}

		// Recursively handle populate
		if (result.populate) {
			const nextPopulate: Record<string, any> = {};
			for (const [field, spec] of Object.entries(result.populate)) {
				const transformed = await this.recursiveTransformProjection(
					ctx,
					spec.schema,
					spec.projection ?? {},
					"list", // populated sub-queries are usually lists/reads
				);
				nextPopulate[field] = {
					...spec,
					projection: transformed,
				};

				// Also inject filters for the populated schema
				const subRules = filterApplicable(
					await loadRulesFor(this.adapter, ctx),
					spec.schema.name,
					"list",
				);
				const extraFields = new Set<string>();
				const mergedWhere = await this.mergeFilters(
					ctx,
					spec.schema.name,
					(spec as any).where ?? {},
					"list",
					subRules,
					extraFields,
				);
				(nextPopulate[field] as any).where = mergedWhere;
				
				if (extraFields.size > 0 && transformed) {
					// We need to ensure extraFields are projected in the sub-query too
					const {projection: aug, added} = augmentProjectionForPredicate(
						transformed,
						extraFields,
						spec.schema,
					);
					nextPopulate[field].projection = aug;
					rememberStripFields(ctx, spec.schema, added);
				}
			}
			result = { ...result, populate: nextPopulate };
		}

		return result;
	}

	/**
	 * Validate/strip a write payload for create/update/delete. Throw a KeymaPluginError
	 * for hard reject. Return data (possibly mutated) or void.
	 */
	async checkWrite?(
		ctx: RequestContext,
		schema: SchemaMetadata,
		data: Record<string, unknown>,
		action: KeymaWriteAction,
	) {
		if (ctx.identity?.isSystem === true) return undefined;
		const rules = filterApplicable(
			await loadRulesFor(this.adapter, ctx),
			schema.name,
			action,
		);
		const {allows} = partition(rules);
		if (allows.length === 0) {
			throw new AclDenied(`No ACL rule grants ${action} on ${schema.name}`);
		}
		const allowed = allowedWriteFields(rules);
		if (allowed === undefined) return undefined;
		const dataKeys = Object.keys(data);
		const forbidden = dataKeys.filter(
			(k) => !allowed.has(k) && k !== "id",
		);
		if (forbidden.length === 0) return undefined;
		if (this.options.stripWrites) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(data)) {
				if (!forbidden.includes(k)) out[k] = v;
			}
			return out;
		}
		throw new AclFieldForbidden(forbidden);
	}

	/**
	 * Post-process records leaving the server.
	 */
	async transformResult(
		ctx: RequestContext,
		schema: SchemaMetadata,
		records: Record<string, unknown>[],
		action: KeymaAction,
	) {
		if (ctx.identity?.isSystem === true) return undefined;
		const strip = getStripFields(ctx, schema);
		if (strip === undefined || strip.size === 0) return undefined;
		return records.map((r) => {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(r)) {
				if (!strip.has(k)) out[k] = v;
			}
			return out;
		});
	}

	async transformOperation(
		ctx: RequestContext,
		op: KeymaOperation,
	): Promise<KeymaOperation | undefined> {
		if (ctx.identity?.isSystem === true) return undefined;
		if (op.op === "traverse") {
			return this.transformTraverse(ctx, op);
		}
		return undefined;
	}

	/**
	 * Inject ACL `read` predicates into a traverse spec. The runtime's
	 * `handleTraverse` never runs `transformFilter`, so this is the only place
	 * row-level read rules can be enforced on traversals.
	 *
	 * Enforcement is bounded to the two node schemas the plugin can name from
	 * the spec: the start node (`spec.start`) and the terminal node
	 * (`op.schema`). Intermediate edges and hopped-through nodes are not
	 * predicate-filtered — consistent with the v1 "no joins/populated paths"
	 * scope (see README).
	 */
	private async transformTraverse(
		ctx: RequestContext,
		op: Extract<KeymaOperation, { op: "traverse" }>,
	): Promise<KeymaOperation> {
		const rules = await loadRulesFor(this.adapter, ctx);
		const spec = { ...op.spec };

		// Start node: apply "read" rules to the anchor's where clause.
		const startRules = filterApplicable(rules, spec.start.schema, "read");
		spec.start = {
			...spec.start,
			where: await this.mergeFilters(ctx, spec.start.schema, spec.start.where, "read", startRules),
		};

		// Terminal node: apply "read" rules to the emitted nodes' where clause.
		const terminalRules = filterApplicable(rules, op.schema, "read");
		spec.where = await this.mergeFilters(ctx, op.schema, spec.where ?? {}, "read", terminalRules);

		return { ...op, spec };
	}

	private async mergeFilters(
		ctx: RequestContext,
		schemaName: string,
		where: Record<string, unknown>,
		action: KeymaAction,
		rules: AclRule[],
		extraFields: Set<string> = new Set(),
	): Promise<Record<string, unknown>> {
		const {allows, denies} = partition(rules);

		if (allows.length === 0) {
			throw new AclDenied(`No ACL rule grants ${action} on ${schemaName}`);
		}

		const allowFilters: Record<string, unknown>[] = [];
		for (const r of allows) {
			if (r.where === undefined) {
				allowFilters.push({});
				continue;
			}
			const sub = substituteFilter(r.where, ctx);
			if (sub === undefined) continue;
			allowFilters.push(sub);
			for (const f of fieldsReferenced(sub)) extraFields.add(f);
		}
		if (allowFilters.length === 0) {
			throw new AclDenied(
				`No applicable ACL rule resolves for ${action} on ${schemaName}`,
			);
		}

		const denyFilters: Record<string, unknown>[] = [];
		for (const r of denies) {
			if (r.where === undefined) {
				throw new AclDenied(`Deny rule blocks ${action} on ${schemaName}`);
			}
			const sub = substituteFilter(r.where, ctx);
			if (sub === undefined) continue;
			denyFilters.push(sub);
			for (const f of fieldsReferenced(sub)) extraFields.add(f);
		}

		const allowOr = combineOr(allowFilters);
		const denyNor = denyFilters.length > 0 ? combineNor(denyFilters) : undefined;
		return combineAnd([where, allowOr, denyNor]);
	}

	/**
	 * Called after every operation regardless of outcome. Throws here are
	 * swallowed (logged) so they cannot poison the response.
	 */
	/*afterOperation?(
		ctx: RequestContext,
		op: KeymaOperation,
		result: KeymaLeafResult,
	): Promise<void> | void;*/


}

export function createAclPlugin(options: AclPluginOptions): AclServerPlugin {
	return new AclServerPlugin(options);
}

function partition(rules: ReadonlyArray<AclRule>): {
	allows: AclRule[];
	denies: AclRule[];
} {
	const allows: AclRule[] = [];
	const denies: AclRule[] = [];
	for (const r of rules) {
		if ((r.effect ?? "allow") === "deny") denies.push(r);
		else allows.push(r);
	}
	return {allows, denies};
}

async function applyReadTrim(
	ctx: RequestContext,
	schema: SchemaMetadata,
	projection: AdapterProjection,
	action: KeymaAction,
	adapter: KeymaDatabaseAdapter,
): Promise<AdapterProjection | undefined> {
	const rules = filterApplicable(
		await loadRulesFor(adapter, ctx),
		schema.name,
		action,
	);
	const allowed = allowedReadFields(rules);
	if (allowed === undefined) return undefined;
	return trimProjection(projection, allowed);
}
