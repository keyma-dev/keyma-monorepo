import { sql } from "kysely";
import type {
    AdapterCapabilities,
    AdapterProjection,
    AdapterTraversalContext,
    AdapterTraversalResult,
    KeymaDatabaseAdapter,
    ListQuery,
    SchemaMetadata,
    TraversalSpec,
} from "@keyma/runtime-js";
import { buildCreateTable } from "./ddl.js";
import { buildIndexStatements } from "./indexes.js";
import { translateWhereInto } from "./filter.js";
import { fromRecord, toRecord } from "./record.js";
import { applyListOptions } from "./list-options.js";
import { applyProjection, needsPopulate } from "./projection.js";
import { runTraverse } from "./traverse.js";
import { sanitizeTableName } from "./sanitize-name.js";
import { SqliteAdapterInternal } from "./errors.js";
import type { AnyDb, SchemaMap } from "./kysely.js";

export interface SqliteAdapterOptions {
    /** Override how a schema maps to its SQL table name. Defaults to the schema's
     *  `name` sanitized to a valid SQL identifier (see `sanitizeTableName`). */
    tableName?: (schema: SchemaMetadata) => string;
    /** Override the id generator used when a record is inserted without an
     *  `id`. Defaults to `crypto.randomUUID()`. */
    generateId?: () => string;
}

export type TableNameFn = (schema: SchemaMetadata) => string;

export class SqliteAdapter implements KeymaDatabaseAdapter {
    readonly capabilities: AdapterCapabilities = {
        traverse: { maxDepth: 100, emitPaths: true, heterogeneous: true },
    };

    private readonly schemas = new Map<string, SchemaMetadata>();
    private readonly tableName: TableNameFn;
    private readonly generateId: () => string;

    constructor(
        private readonly db: AnyDb,
        opts: SqliteAdapterOptions = {},
    ) {
        this.tableName = opts.tableName ?? ((s) => sanitizeTableName(s.name));
        this.generateId = opts.generateId ?? (() => crypto.randomUUID());
    }

    private register(schema: SchemaMetadata): void {
        this.schemas.set(schema.name, schema);
    }

    private cachedSchemas(): SchemaMap {
        return this.schemas;
    }

    async ensureSchema(schema: SchemaMetadata): Promise<void> {
        this.register(schema);
        const ddl = buildCreateTable(schema);
        await sql.raw(ddl).execute(this.db);
        for (const stmt of buildIndexStatements(schema)) {
            await sql.raw(stmt).execute(this.db);
        }
    }

    async create(
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        this.register(schema);
        const withId = { ...data };
        if (withId["id"] === undefined) withId["id"] = this.generateId();
        const row = fromRecord(withId, schema, this.cachedSchemas());
        await this.db.insertInto(this.tableName(schema)).values(row).execute();
        const result = await this.fetchOne(schema, { id: withId["id"] }, projection);
        if (result === null) {
            throw new SqliteAdapterInternal("Created record not found post-insert");
        }
        return result;
    }

    async read(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        this.register(schema);
        return this.fetchOne(schema, where, projection);
    }

    async list(
        schema: SchemaMetadata,
        query: ListQuery,
    ): Promise<Record<string, unknown>[]> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        const table = this.tableName(schema);
        let qb = this.db.selectFrom(table);
        qb = translateWhereInto(qb, query.where, schema, schemas, table);
        qb = applyProjection(qb, schema, schemas, query.projection, this.tableName);
        qb = applyListOptions(qb, schema, query);
        const rows = await qb.execute();
        return rows.map((r) => decodeRow(r as Record<string, unknown>, schema, schemas, query.projection));
    }

    async count(schema: SchemaMetadata, where?: Record<string, unknown>): Promise<number> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        const table = this.tableName(schema);
        let qb = this.db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("count"));
        if (where !== undefined && Object.keys(where).length > 0) {
            qb = translateWhereInto(qb, where, schema, schemas, table) as typeof qb;
        }
        const row = await qb.executeTakeFirstOrThrow();
        return Number(row.count);
    }

    async update(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        // Drop the `id` field from update payload — primary keys aren't updated
        // through this path.
        const cleaned = { ...data };
        delete cleaned["id"];
        const set = fromRecord(cleaned, schema, schemas);
        if (Object.keys(set).length === 0) {
            // No-op update — still need to return the matched row.
            const existing = await this.fetchOne(schema, where, projection);
            if (existing === null) {
                throw new SqliteAdapterInternal("Update target not found");
            }
            return existing;
        }
        let qb = this.db.updateTable(this.tableName(schema)).set(set);
        qb = translateWhereInto(qb, where, schema, schemas);
        const result = await qb.executeTakeFirst();
        if (result.numUpdatedRows === 0n) {
            throw new SqliteAdapterInternal("Update target not found");
        }
        const fetched = await this.fetchOne(schema, where, projection);
        if (fetched === null) {
            throw new SqliteAdapterInternal("Updated record not found post-update");
        }
        return fetched;
    }

    async delete(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
    ): Promise<void> {
        this.register(schema);
        let qb = this.db.deleteFrom(this.tableName(schema));
        qb = translateWhereInto(qb, where, schema, this.cachedSchemas());
        await qb.execute();
    }

    async traverse(
        ctx: AdapterTraversalContext,
        spec: TraversalSpec,
        projection?: AdapterProjection,
    ): Promise<AdapterTraversalResult> {
        for (const s of ctx.edges.values()) this.register(s);
        for (const s of ctx.nodes.values()) this.register(s);
        this.register(ctx.startSchema);
        this.register(ctx.terminalSchema);
        return runTraverse(
            this.db,
            ctx,
            spec,
            projection,
            this.cachedSchemas(),
            this.tableName,
        );
    }

    private async fetchOne(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        const schemas = this.cachedSchemas();
        const table = this.tableName(schema);
        let qb = this.db.selectFrom(table);
        qb = translateWhereInto(qb, where, schema, schemas, table);
        qb = applyProjection(qb, schema, schemas, projection, this.tableName);
        const row = await qb.limit(1).executeTakeFirst();
        if (row === undefined) return null;
        return decodeRow(row as Record<string, unknown>, schema, schemas, projection);
    }
}

/** Decode a row, handling populated reference fields that arrived as JSON
 *  strings from `json_object(...)` columns. */
function decodeRow(
    row: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
    projection: AdapterProjection | undefined,
): Record<string, unknown> {
    const out = toRecord(row, schema, schemas);
    if (projection?.populate === undefined || !needsPopulate(projection)) return out;
    for (const [field, node] of Object.entries(projection.populate)) {
        const v = row[field];
        if (v === undefined || v === null) continue;
        const sub = node.schema;
        if (typeof v === "string") {
            try {
                const parsed = JSON.parse(v) as Record<string, unknown> | null;
                if (parsed === null) {
                    out[field] = null;
                } else {
                    out[field] = toRecord(parsed, sub, schemas);
                }
            } catch {
                // Fall through; leave as-is.
                out[field] = v;
            }
        } else if (typeof v === "object") {
            out[field] = toRecord(v as Record<string, unknown>, sub, schemas);
        }
    }
    return out;
}
