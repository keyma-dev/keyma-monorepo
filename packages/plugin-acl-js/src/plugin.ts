import {
    type KeymaAction,
    type AdapterProjection,
    type KeymaDatabaseAdapter,
    type KeymaServerPlugin,
    type PluginServerHandle,
    type RequestContext,
    type SchemaMetadata,
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

export function createAclPlugin(options: AclPluginOptions): CreateAclPluginResult {
    const adapter: KeymaDatabaseAdapter = options.adapter;
    const stripWrites = options.stripWrites ?? false;
    const admin = new KeymaAclAdmin(adapter);

    const plugin: KeymaServerPlugin = {
        name: PLUGIN_NAME,

        async init(server: PluginServerHandle) {
            for (const name of RESERVED_SCHEMA_NAMES) {
                if (server.schemas.some((s) => s.name === name)) {
                    throw new Error(
                        `${PLUGIN_NAME}: schema "${name}" is registered on the host KeymaServer. ` +
                            `Remove it — the plugin manages its own ACL storage. ` +
                            `Use the returned 'admin' handle (KeymaAclAdmin) for rules, roles, and role assignments.`,
                    );
                }
            }
            await adapter.ensureSchema(ACL_RULE_SCHEMA);
            await adapter.ensureSchema(ACL_ROLE_SCHEMA);
            await adapter.ensureSchema(ACL_ROLE_ASSIGNMENT_SCHEMA);
        },

        async beforeOperation(ctx, op) {
            // Traverse bypasses transformFilter (the server doesn't fold filter
            // hooks for it), so enforce at least "traverse" permission here.
            if (op.op !== "traverse") return;
            if (ctx.identity?.isSystem === true) return;
            const applicable = filterApplicable(
                await loadRulesFor(adapter, ctx),
                op.schema,
                "traverse",
            );
            const { allows } = partition(applicable);
            if (allows.length === 0) {
                throw new AclDenied(`No ACL rule grants traverse on ${op.schema}`);
            }
        },

        async transformFilter(ctx, schema, where, action) {
            if (ctx.identity?.isSystem === true) return undefined;
            const rules = filterApplicable(
                await loadRulesFor(adapter, ctx),
                schema.name,
                action,
            );
            const { allows, denies } = partition(rules);

            if (allows.length === 0) {
                throw new AclDenied(`No ACL rule grants ${action} on ${schema.name}`);
            }

            const allowFilters: Record<string, unknown>[] = [];
            const extraFields = new Set<string>();
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
                    `No applicable ACL rule resolves for ${action} on ${schema.name}`,
                );
            }

            const denyFilters: Record<string, unknown>[] = [];
            for (const r of denies) {
                if (r.where === undefined) {
                    // Unconditional deny → throw immediately.
                    throw new AclDenied(`Deny rule blocks ${action} on ${schema.name}`);
                }
                const sub = substituteFilter(r.where, ctx);
                if (sub === undefined) continue;
                denyFilters.push(sub);
                for (const f of fieldsReferenced(sub)) extraFields.add(f);
            }

            const allowOr = combineOr(allowFilters);
            const denyNor = denyFilters.length > 0 ? combineNor(denyFilters) : undefined;
            const merged = combineAnd([where, allowOr, denyNor]);

            // Stash predicate field references so transformProjection can ensure
            // the adapter receives them.
            if (extraFields.size > 0) {
                rememberPredicateFields(ctx, schema, extraFields);
            }

            return merged;
        },

        async transformProjection(ctx, schema, projection, action) {
            if (ctx.identity?.isSystem === true) return undefined;
            if (action === "create") {
                // Creates don't have predicate-based visibility; only field
                // restrictions matter. Apply read-side trim so the response
                // honors field-level perms.
                return applyReadTrim(ctx, schema, projection, "read", adapter);
            }
            const rules = filterApplicable(
                await loadRulesFor(adapter, ctx),
                schema.name,
                readSideAction(action),
            );
            const allowed = allowedReadFields(rules);
            let result: AdapterProjection = projection;
            if (allowed !== undefined) {
                result = trimProjection(result, allowed);
            }
            const predicateFields = getPredicateFields(ctx, schema);
            if (predicateFields !== undefined && predicateFields.size > 0) {
                const { projection: aug, added } = augmentProjectionForPredicate(
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
        },

        async checkWrite(ctx, schema, data, action) {
            if (ctx.identity?.isSystem === true) return undefined;
            const rules = filterApplicable(
                await loadRulesFor(adapter, ctx),
                schema.name,
                action,
            );
            const { allows } = partition(rules);
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
            if (stripWrites) {
                const out: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(data)) {
                    if (!forbidden.includes(k)) out[k] = v;
                }
                return out;
            }
            throw new AclFieldForbidden(forbidden);
        },

        transformResult(ctx, schema, records) {
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
        },
    };

    return { plugin, admin };
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
    return { allows, denies };
}

/** Pick the action whose rules govern field-level read perms for a given
 *  operation. Reads/lists/traverses use their own; writes use "read" since
 *  the response is what the caller sees regardless of the write op. */
function readSideAction(action: KeymaAction): KeymaAction {
    if (action === "list" || action === "read" || action === "traverse") return action;
    return "read";
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
