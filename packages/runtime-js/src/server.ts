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
    ProjectionSpec,
    TraversalSpec,
} from "./protocol.js";
import { validate, type ValidatorRegistry } from "./validate.js";
import { format, type FormatterRegistry } from "./format.js";

type ServerOptions = {
    schemas: SchemaMetadata[];
    adapter: KeymaDatabaseAdapter;
    validators?: ValidatorRegistry;
    formatters?: FormatterRegistry;
};

export class KeymaServer {
    private readonly schemaMap: Map<string, SchemaMetadata>;

    constructor(private readonly opts: ServerOptions) {
        this.schemaMap = new Map(opts.schemas.map((s) => [s.name, s]));
    }

    async ensureSchemas(): Promise<void> {
        for (const schema of this.opts.schemas) {
            await this.opts.adapter.ensureSchema(schema);
        }
    }

    async handle(request: KeymaRequest): Promise<KeymaBatchResponse> {
        const results: Record<string, KeymaLeafResult> = {};
        for (const [key, op] of Object.entries(request.operations)) {
            results[key] = await this.handleOne(op);
        }
        return { results };
    }

    private async handleOne(op: KeymaOperation): Promise<KeymaLeafResult> {
        const schema = this.schemaMap.get(op.schema);
        if (schema === undefined) {
            return fail(`Unknown schema: ${op.schema}`, "SCHEMA_NOT_FOUND");
        }

        switch (op.op) {
            case "list":
                return this.handleList(schema, op);
            case "read":
                return this.handleRead(schema, op);
            case "create":
                return this.handleCreate(schema, op);
            case "update":
                return this.handleUpdate(schema, op);
            case "delete":
                return this.handleDelete(schema, op);
            case "traverse":
                return this.handleTraverse(schema, op);
        }
    }

    private async handleTraverse(
        terminalSchema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "traverse" }>,
    ): Promise<KeymaLeafResult> {
        if (this.opts.adapter.traverse === undefined) {
            return fail(
                "Database adapter does not support traverse operations",
                "UNSUPPORTED",
            );
        }
        const startSchema = this.schemaMap.get(op.spec.start.schema);
        if (startSchema === undefined) {
            return fail(`Unknown start schema: ${op.spec.start.schema}`, "SCHEMA_NOT_FOUND");
        }

        const edges = new Map<string, SchemaMetadata>();
        const nodes = new Map<string, SchemaMetadata>();
        const referencedEdgeNames = collectEdgeNames(op.spec);
        for (const name of referencedEdgeNames) {
            const s = this.schemaMap.get(name);
            if (s === undefined) {
                return fail(`Unknown edge schema: ${name}`, "SCHEMA_NOT_FOUND");
            }
            if (s.edge === undefined) {
                return fail(`Schema "${name}" is not an edge schema`, "NOT_AN_EDGE");
            }
            edges.set(name, s);
            // Track endpoint node schemas (looked up by sourceName, which matches
            // how the frontend records edge.from / edge.to).
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
        const projection = this.buildAdapterProjection(terminalSchema, op.project);
        const records = await this.opts.adapter.traverse(ctx, op.spec, projection);
        return { ok: true, data: records };
    }

    /** Lookup helper for resolving edge-endpoint schemas, which are stored by
     *  sourceName (TS class name) rather than the database `name`. */
    private findBySourceName(sourceName: string): SchemaMetadata | undefined {
        for (const s of this.opts.schemas) {
            if (s.sourceName === sourceName) return s;
        }
        return undefined;
    }

    private async handleList(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "list" }>,
    ): Promise<KeymaLeafResult> {
        const query: ListQuery = {
            where: op.where ?? {},
            sort: op.options?.sort ?? {},
            projection: this.buildAdapterProjection(schema, op.project),
        };
        if (op.options?.skip !== undefined) query.skip = op.options.skip;
        if (op.options?.limit !== undefined) query.limit = op.options.limit;
        const records = await this.opts.adapter.list(schema, query);
        return { ok: true, data: records };
    }

    private async handleRead(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "read" }>,
    ): Promise<KeymaLeafResult> {
        const projection = this.buildAdapterProjection(schema, op.project);
        const record = await this.opts.adapter.read(schema, op.where, projection);
        if (record === null) {
            return fail("Not found", "NOT_FOUND");
        }
        return { ok: true, data: record };
    }

    private async handleCreate(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "create" }>,
    ): Promise<KeymaLeafResult> {
        const data = { ...op.data };
        await format(schema, data, "save", this.opts.formatters);
        const writableSchema: SchemaMetadata = {
            ...schema,
            fields: schema.fields.filter((f) => f.readonly !== true),
        };
        const errors = await validate(writableSchema, data, this.opts.validators);
        if (errors.length > 0) {
            return failValidation(errors);
        }
        const projection = this.buildAdapterProjection(schema, op.project);
        const created = await this.opts.adapter.create(schema, data, projection);
        return { ok: true, data: created };
    }

    private async handleUpdate(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "update" }>,
    ): Promise<KeymaLeafResult> {
        const data = { ...op.data };
        await format(schema, data, "save", this.opts.formatters);
        const projection = this.buildAdapterProjection(schema, op.project);
        const updated = await this.opts.adapter.update(schema, op.where, data, projection);
        return { ok: true, data: updated };
    }

    private async handleDelete(
        schema: SchemaMetadata,
        op: Extract<KeymaOperation, { op: "delete" }>,
    ): Promise<KeymaLeafResult> {
        await this.opts.adapter.delete(schema, op.where);
        return { ok: true, data: null };
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

        for (const [key, sub] of entries) {
            const field = schema.fields.find((f) => f.name === key);
            const type = field !== undefined ? coreType(field.type) : undefined;

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

function fail(error: string, code: string): KeymaLeafResult {
    return { ok: false, error, code };
}

function collectEdgeNames(spec: TraversalSpec): Set<string> {
    const names = new Set<string>();
    if (spec.steps !== undefined) {
        for (const s of spec.steps) names.add(s.via);
    }
    if (spec.repeat !== undefined) names.add(spec.repeat.via);
    return names;
}

function failValidation(errors: ValidationError[]): KeymaLeafResult {
    return { ok: false, error: "Validation failed", code: "VALIDATION_FAILED", errors };
}
