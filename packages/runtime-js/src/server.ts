import type {
    SchemaMetadata,
    FieldType,
    ValidationError,
} from "./types.js";
import type {
    KeymaDatabaseAdapter,
    ListQuery,
    AdapterProjection,
    AdapterFieldSpec,
    PopulateSpec,
    AdapterTraversalContext,
} from "./adapter.js";
import type {
    KeymaOperation,
    KeymaRequest,
    KeymaBatchResponse,
    KeymaLeafResult,
    KeymaLeafFailure,
    ProjectionSpec,
    TraversalSpec,
} from "./protocol.js";
import { validate, type ValidatorRegistry } from "./validate.js";
import { format, type FormatterRegistry } from "./format.js";
import {
    type KeymaAction,
    type KeymaServerPlugin,
    type PluginServerHandle,
    type RequestContext,
} from "./plugin.js";
import { KeymaError, KeymaRuntimeError } from "./errors.js";

type ServerOptions = {
    schemas: SchemaMetadata[];
    adapter: KeymaDatabaseAdapter;
    validators?: ValidatorRegistry;
    formatters?: FormatterRegistry;
    plugins?: KeymaServerPlugin[];
};

export class KeymaServer {
    private readonly schemaMap: Map<string, SchemaMetadata>;
    private readonly plugins: readonly KeymaServerPlugin[];
    private initialized = false;

    constructor(private readonly opts: ServerOptions) {
        this.schemaMap = new Map(opts.schemas.map((s) => [s.name, s]));
        this.plugins = opts.plugins ?? [];
    }

    async ensureSchemas(): Promise<void> {
        await this.ensureInitialized();
        for (const schema of this.opts.schemas) {
            // Ephemeral schemas are never persisted — no collection/table to ensure.
            if (schema.ephemeral) continue;
            await this.opts.adapter.ensureSchema(schema);
        }
    }

    async handle(
        request: KeymaRequest,
        context: RequestContext = {},
    ): Promise<KeymaBatchResponse> {
        await this.ensureInitialized();
        const results: Record<string, KeymaLeafResult> = {};
        for (const [key, op] of Object.entries(request.operations)) {
            results[key] = await this.handleOne(op, context);
        }
        return { results };
    }

    // Resolves a client-supplied schema name. Private schemas are treated as
    // non-existent unless the caller is the in-process system identity —
    // returning a distinct error would let attackers probe for private names.
    private resolveSchema(name: string, context: RequestContext): SchemaMetadata {
        const schema = this.schemaMap.get(name);
        if (
            schema === undefined ||
            (schema.visibility === "private" && context.identity?.isSystem !== true)
        ) {
            throw new KeymaRuntimeError("SCHEMA_NOT_FOUND", `Unknown schema: ${name}`);
        }
        return schema;
    }

    /** Release adapter-owned resources (connections). Symmetric with
     *  `ensureSchemas()`; safe to call even if the adapter manages no connection. */
    async close(): Promise<void> {
        await this.opts.adapter.close?.();
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        await this.opts.adapter.connect?.();
        const handle: PluginServerHandle = {
            schemas: this.opts.schemas,
            adapter: this.opts.adapter,
            schema: (name) => this.schemaMap.get(name),
            addSchema: async (schema) => {
                this.schemaMap.set(schema.name, schema);
                // Ephemeral schemas are never persisted — skip table/collection creation.
                if (schema.ephemeral) return;
                // Ensure the adapter creates necessary tables/collections for the new schema
                await this.opts.adapter.ensureSchema(schema);
            },
        };
        for (const p of this.plugins) {
            if (p.init !== undefined) await p.init(handle);
        }
    }

    private async handleOne(
        op: KeymaOperation,
        context: RequestContext,
    ): Promise<KeymaLeafResult> {
        let result: KeymaLeafResult;
        try {
            for (const p of this.plugins) {
                if (p.transformOperation !== undefined) {
                    const next = await p.transformOperation(context, op);
                    if (next !== undefined) op = next;
                }
            }
            const schema = this.resolveSchema(op.schema, context);
            // Ephemeral schemas are never persisted and cannot be queried through
            // the server — they exist only for validation/serialization.
            if (schema.ephemeral) {
                throw new KeymaRuntimeError(
                    "NOT_PERSISTED",
                    `Schema "${op.schema}" is ephemeral and cannot be queried`,
                );
            }
            for (const p of this.plugins) {
                if (p.beforeOperation !== undefined) await p.beforeOperation(context, op);
            }
            switch (op.op) {
                case "list":
                    result = await this.handleList(schema, op, context);
                    break;
                case "read":
                    result = await this.handleRead(schema, op, context);
                    break;
                case "create":
                    result = await this.handleCreate(schema, op, context);
                    break;
                case "update":
                    result = await this.handleUpdate(schema, op, context);
                    break;
                case "delete":
                    result = await this.handleDelete(schema, op, context);
                    break;
                case "traverse":
                    result = await this.handleTraverse(schema, op, context);
                    break;
                case "count":
                    result = await this.handleCount(schema, op, context);
                    break;
            }
        } catch (err) {
            result = errorToResult(err);
        }

        for (const p of this.plugins) {
            if (p.afterOperation === undefined) continue;
            try {
                await p.afterOperation(context, op, result);
            } catch {
                // afterOperation errors must not change the response.
            }
        }
        return result;
    }

    private async handleTraverse(
        terminalSchema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "traverse" }>,
        context: RequestContext,
    ): Promise<KeymaLeafResult> {
        if (this.opts.adapter.traverse === undefined) {
            throw new KeymaRuntimeError(
                "UNSUPPORTED",
                "Database adapter does not support traverse operations",
            );
        }
        const startSchema = this.resolveSchema(op.spec.start.schema, context);

        const edges = new Map<string, SchemaMetadata>();
        const nodes = new Map<string, SchemaMetadata>();
        const referencedEdgeNames = collectEdgeNames(op.spec);
        for (const name of referencedEdgeNames) {
            const s = this.resolveSchema(name, context);
            if (s.edge === undefined) {
                throw new KeymaRuntimeError(
                    "NOT_AN_EDGE",
                    `Schema "${name}" is not an edge schema`,
                );
            }
            edges.set(name, s);
            for (const endpoint of [s.edge.from, s.edge.to]) {
                const node = this.findBySourceName(endpoint);
                if (node !== undefined) nodes.set(node.name, node);
            }
        }
        nodes.set(startSchema.name, startSchema);
        nodes.set(terminalSchema.name, terminalSchema);

        const ctx: AdapterTraversalContext = {
            terminalSchema,
            startSchema,
            edges,
            nodes,
        };
        let projection = this.buildAdapterProjection(terminalSchema, op.project);
        projection = await this.runProjectionHooks(context, terminalSchema, projection, "traverse");
        const records = await this.opts.adapter.traverse(ctx, op.spec, projection);
        // Traversal results may be records or paths; only run record hooks for
        // the plain-records shape. Path-shaped results are passed through.
        if (Array.isArray(records) && records.every((r) => isPlainRecord(r))) {
            const out = await this.runResultHooks(
                context,
                terminalSchema,
                records as Record<string, unknown>[],
                "traverse",
            );
            return { ok: true, data: out };
        }
        return { ok: true, data: records };
    }

    private findBySourceName(sourceName: string): SchemaMetadata | undefined {
        for (const s of this.opts.schemas) {
            if (s.sourceName === sourceName) return s;
        }
        return undefined;
    }

    private async handleList(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "list" }>,
        context: RequestContext,
    ): Promise<KeymaLeafResult> {
        const where = await this.runFilterHooks(context, schema, op.where ?? {}, "list");
        let projection = this.buildAdapterProjection(schema, op.project);
        projection = await this.runProjectionHooks(context, schema, projection, "list");
        const query: ListQuery = {
            where,
            sort: op.options?.sort ?? {},
            projection,
        };
        if (op.options?.skip !== undefined) query.skip = op.options.skip;
        if (op.options?.limit !== undefined) query.limit = op.options.limit;
        const records = await this.opts.adapter.list(schema, query);
        const out = await this.runResultHooks(context, schema, records, "list");
        return { ok: true, data: out };
    }

    private async handleRead(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "read" }>,
        context: RequestContext,
    ): Promise<KeymaLeafResult> {
        const where = await this.runFilterHooks(context, schema, op.where, "read");
        let projection = this.buildAdapterProjection(schema, op.project);
        projection = await this.runProjectionHooks(context, schema, projection, "read");
        const record = await this.opts.adapter.read(schema, where, projection);
        if (record === null) {
            throw new KeymaRuntimeError("NOT_FOUND", "Not found");
        }
        const out = await this.runResultHooks(context, schema, [record], "read");
        return { ok: true, data: out[0] ?? record };
    }

    private async handleCreate(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "create" }>,
        context: RequestContext,
    ): Promise<KeymaLeafResult> {
        let data = extractEdgeEndpointIds(schema, { ...op.data });
        await format(schema, data, "save", this.opts.formatters);
        const writableSchema: SchemaMetadata = {
            ...schema,
            fields: schema.fields.filter((f) => f.name !== 'id'),
        };
        const errors = await validate(writableSchema, data, this.opts.validators);
        if (errors.length > 0) {
            throw new ValidationFailedError(errors);
        }
        data = await this.runWriteHooks(context, schema, data, "create");
        let projection = this.buildAdapterProjection(schema, op.project);
        projection = await this.runProjectionHooks(context, schema, projection, "create");
        const created = await this.opts.adapter.create(schema, data, projection);
        const out = await this.runResultHooks(context, schema, [created], "create");
        return { ok: true, data: out[0] ?? created };
    }

    private async handleUpdate(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "update" }>,
        context: RequestContext,
    ): Promise<KeymaLeafResult> {
        let data = extractEdgeEndpointIds(schema, { ...op.data });
        await format(schema, data, "save", this.opts.formatters);
        const errors = await validate(schema, data, this.opts.validators);
        if (errors.length > 0) {
            throw new ValidationFailedError(errors);
        }
        data = await this.runWriteHooks(context, schema, data, "update");
        const where = await this.runFilterHooks(context, schema, op.where, "update");
        let projection = this.buildAdapterProjection(schema, op.project);
        projection = await this.runProjectionHooks(context, schema, projection, "update");
        const updated = await this.opts.adapter.update(schema, where, data, projection);
        const out = await this.runResultHooks(context, schema, [updated], "update");
        return { ok: true, data: out[0] ?? updated };
    }

    private async handleDelete(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "delete" }>,
        context: RequestContext,
    ): Promise<KeymaLeafResult> {
        const where = await this.runFilterHooks(context, schema, op.where, "delete");
        await this.opts.adapter.delete(schema, where);
        return { ok: true, data: null };
    }

    private async handleCount(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "count" }>,
        context: RequestContext,
    ): Promise<KeymaLeafResult> {
        const where = await this.runFilterHooks(context, schema, op.where ?? {}, "count");
        let n: number = await this.opts.adapter.count(schema, where);
        return { ok: true, data: n };
    }

    // ── Hook folds ───────────────────────────────────────────────────────────

    private async runFilterHooks(
        context: RequestContext,
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        action: KeymaAction,
    ): Promise<Record<string, unknown>> {
        let acc = where;
        for (const p of this.plugins) {
            if (p.transformFilter === undefined) continue;
            const next = await p.transformFilter(context, schema, acc, action);
            if (next !== undefined) acc = next;
        }
        return acc;
    }

    private async runProjectionHooks(
        context: RequestContext,
        schema: SchemaMetadata,
        projection: AdapterProjection,
        action: KeymaAction,
    ): Promise<AdapterProjection> {
        let acc = projection;
        for (const p of this.plugins) {
            if (p.transformProjection === undefined) continue;
            const next = await p.transformProjection(context, schema, acc, action);
            if (next !== undefined) acc = next;
        }
        return acc;
    }

    private async runWriteHooks(
        context: RequestContext,
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        action: "create" | "update",
    ): Promise<Record<string, unknown>> {
        let acc = data;
        for (const p of this.plugins) {
            if (p.checkWrite === undefined) continue;
            const next = await p.checkWrite(context, schema, acc, action);
            if (next !== undefined) acc = next;
        }
        return acc;
    }

    private async runResultHooks(
        context: RequestContext,
        schema: SchemaMetadata,
        records: Record<string, unknown>[],
        action: KeymaAction,
    ): Promise<Record<string, unknown>[]> {
        let acc = records;
        for (const p of this.plugins) {
            if (p.transformResult === undefined) continue;
            const next = await p.transformResult(context, schema, acc, action);
            if (next !== undefined) acc = next;
        }
        return acc;
    }

    // ── Projection builder ───────────────────────────────────────────────────
    //
    // Translates a client ProjectionSpec into an AdapterProjection the adapter
    // can execute directly. Private fields are stripped here (security boundary);
    // the adapter receives only what the client is allowed to see.

    private buildAdapterProjection(
        schema: SchemaMetadata,
        spec: ProjectionSpec | undefined,
    ): AdapterProjection {
        const fields: { [key: string]: AdapterFieldSpec } = {};
        const populate: PopulateSpec = {};

        const entries: Array<[string, 1 | ProjectionSpec]> =
            spec !== undefined
                ? (Object.entries(spec) as Array<[string, 1 | ProjectionSpec]>).filter(
                      ([key]) => schema.fields.find((f) => f.name === key)?.visibility !== "private",
                  )
                : schema.fields
                      .filter((f) => f.visibility !== "private")
                      .map((f): [string, 1] => [f.name, 1]);

        const edge = schema.edge;

        for (const [key, sub] of entries) {
            const field = schema.fields.find((f) => f.name === key);
            const type = field !== undefined ? coreType(field.type) : undefined;

            // Edge endpoints always materialize as objects: `{ id }` by default,
            // or the requested sub-projection (id is always included so the
            // object keeps its identity). `edge.from`/`to` are node sourceNames.
            if (edge !== undefined && (key === edge.fromField || key === edge.toField)) {
                const targetSourceName = key === edge.fromField ? edge.from : edge.to;
                const referenced = this.findBySourceName(targetSourceName);
                if (referenced !== undefined) {
                    const nested =
                        sub === 1
                            ? { fields: { id: 1 as const } }
                            : withIdField(this.buildAdapterProjection(referenced, sub as ProjectionSpec));
                    populate[key] = { schema: referenced, projection: nested };
                    continue;
                }
            }

            if (type?.kind === "reference" && sub !== 1) {
                const referenced = this.schemaMap.get(type.schema);
                if (referenced !== undefined) {
                    const nestedProjection = this.buildAdapterProjection(
                        referenced,
                        sub as ProjectionSpec,
                    );
                    populate[key] = { schema: referenced, projection: nestedProjection };
                    continue;
                }
            }

            if (type?.kind === "embedded" && sub !== 1) {
                fields[key] = buildEmbeddedSpec(sub as ProjectionSpec);
                continue;
            }

            fields[key] = 1;
        }

        const result: AdapterProjection = {};
        if (Object.keys(fields).length > 0) result.fields = fields;
        if (Object.keys(populate).length > 0) result.populate = populate;
        return result;
    }
}

/** Replace edge endpoint node objects with their `id` for the adapter. Edge
 *  create/update input carries `{ from: nodeObj, to: nodeObj }`; adapters expect
 *  bare ids. No-op for non-edge schemas or endpoints already given as ids. */
function extractEdgeEndpointIds(
    schema: SchemaMetadata,
    data: Record<string, unknown>,
): Record<string, unknown> {
    const edge = schema.edge;
    if (edge === undefined) return data;
    for (const fieldName of [edge.fromField, edge.toField]) {
        const v = data[fieldName];
        if (v !== null && typeof v === "object" && !Array.isArray(v) && "id" in v) {
            data[fieldName] = (v as { id: unknown }).id;
        }
    }
    return data;
}

/** Ensure a populate sub-projection includes the `id` field so the resolved
 *  endpoint object always carries its identity. */
function withIdField(projection: AdapterProjection): AdapterProjection {
    return { ...projection, fields: { ...(projection.fields ?? {}), id: 1 } };
}

function buildEmbeddedSpec(spec: ProjectionSpec): { [key: string]: AdapterFieldSpec } {
    const result: { [key: string]: AdapterFieldSpec } = {};
    for (const [key, sub] of Object.entries(spec)) {
        result[key] = sub === 1 ? 1 : buildEmbeddedSpec(sub as ProjectionSpec);
    }
    return result;
}

function coreType(type: FieldType): FieldType {
    if (type.kind === "nullable" || type.kind === "array") return coreType(type.of);
    return type;
}

function collectEdgeNames(spec: TraversalSpec): Set<string> {
    const names = new Set<string>();
    if (spec.steps !== undefined) {
        for (const s of spec.steps) names.add(s.via);
    }
    if (spec.repeat !== undefined) names.add(spec.repeat.via);
    return names;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v) && !("nodes" in v && "edges" in v);
}

class ValidationFailedError extends KeymaRuntimeError {
    constructor(public readonly errors: ValidationError[]) {
        super("VALIDATION_FAILED", "Validation failed");
    }
    override toFailureExtras(): Record<string, unknown> {
        return { errors: this.errors };
    }
}

function errorToResult(err: unknown): KeymaLeafFailure {
    if (err instanceof KeymaError) {
        const out: KeymaLeafFailure = {
            ok: false,
            error: err.message,
            code: err.code,
            source: err.source,
        };
        if (err.origin) out.origin = err.origin;
        Object.assign(out, err.toFailureExtras());
        return out;
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, code: "INTERNAL_ERROR", source: "runtime" };
}
