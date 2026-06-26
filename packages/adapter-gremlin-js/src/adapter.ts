import { randomUUID } from "node:crypto";
import type {
    AdapterCapabilities,
    AdapterProjection,
    AdapterTraversalContext,
    AdapterTraversalResult,
    KeymaDatabaseAdapter,
    ListQuery,
    SchemaMetadata,
    TraversalSpec,
} from "@keyma/runtime/schema";
import { __, AnonymousTraversalSource, cardinality, P, t } from "./gremlin.js";
import type {
    DriverRemoteConnectionInstance,
    GraphTraversal,
    GraphTraversalSource,
    GremlinConnectionFactory,
} from "./gremlin.js";
import { applyOrder, applyRange, applyWhere, translateSort } from "./filter.js";
import { toProps, type PropEntry, type SchemaMap } from "./props.js";
import { hasPopulate, selectFields } from "./projection.js";
import { emitProjected, parseProjectedRow } from "./read.js";
import { ensureIndexes } from "./indexes.js";
import { runTraverse } from "./traverse.js";
import type { LabelFns } from "./traverse-steps.js";
import { sanitizeLabel } from "./sanitize-name.js";
import { GremlinAdapterInternal, GremlinAdapterInvalidQuery } from "./errors.js";

export interface GremlinAdapterOptions {
    /** Override how a schema maps to its vertex label. Defaults to the schema's
     *  `name` sanitized to a valid label (see `sanitizeLabel`). */
    label?: (schema: SchemaMetadata) => string;
    /** Override how an edge schema maps to its Gremlin edge label. Must agree
     *  with what traversals use; defaults to the schema's `name` sanitized
     *  (see `sanitizeLabel`). */
    edgeLabel?: (schema: SchemaMetadata) => string;
    /** Override the id generator used when a record is created without an `id`.
     *  Supplied as the element's `T.id`. Defaults to `crypto.randomUUID()` so
     *  ids are consistent strings on backends that honor user-supplied ids
     *  (TinkerGraph, Neptune). */
    generateId?: () => string;
    /** Proactively rebuild the connection once it has been open this many
     *  milliseconds. Use this for Neptune, where SigV4-signed connection
     *  headers expire — set it below the credential lifetime so a fresh
     *  connection is minted before requests start failing. Omit to keep a
     *  single connection until it errors. */
    maxConnectionAgeMs?: number;
}

/** A Keyma database adapter backed by Apache TinkerPop / Gremlin. Talks to any
 *  Gremlin-enabled store (TinkerGraph, Neptune, JanusGraph, …) through a
 *  `GraphTraversalSource` using bytecode GLV. Non-edge schemas map to vertices;
 *  `@Edge` schemas map to real edges and drive `traverse()`.
 *
 *  The adapter owns its connection: a `GremlinConnectionFactory` builds a
 *  `DriverRemoteConnection` on first use, and the adapter rebuilds it on a
 *  detected connection-level failure (retrying the operation once) and after
 *  the optional `maxConnectionAgeMs` elapses. Consumers never manage the socket
 *  themselves — and Neptune consumers re-sign credentials inside the factory. */
export class GremlinAdapter implements KeymaDatabaseAdapter {
    readonly capabilities: AdapterCapabilities = {
        traverse: { maxDepth: 50, emitPaths: true, heterogeneous: true },
    };

    private readonly schemas = new Map<string, SchemaMetadata>();
    private readonly label: (schema: SchemaMetadata) => string;
    private readonly edgeLabel: (schema: SchemaMetadata) => string;
    private readonly generateId: () => string;
    private readonly maxConnectionAgeMs: number | undefined;

    // Owned connection state, built lazily from the factory.
    private conn: DriverRemoteConnectionInstance | undefined;
    private gSource: GraphTraversalSource | undefined;
    private connectedAt = 0;
    private connecting: Promise<GraphTraversalSource> | undefined;

    constructor(
        private readonly factory: GremlinConnectionFactory,
        opts: GremlinAdapterOptions = {},
    ) {
        this.label = opts.label ?? ((s) => sanitizeLabel(s.name));
        this.edgeLabel = opts.edgeLabel ?? ((s) => sanitizeLabel(s.name));
        this.generateId = opts.generateId ?? (() => randomUUID());
        this.maxConnectionAgeMs = opts.maxConnectionAgeMs;
    }

    /** Resolve the live traversal source, building (once) on first use and
     *  rebuilding when past `maxConnectionAgeMs`. Concurrent first-use callers
     *  share a single in-flight connect. */
    private async source(): Promise<GraphTraversalSource> {
        if (this.gSource !== undefined && !this.isStale()) return this.gSource;
        if (this.gSource !== undefined) await this.dispose();
        if (this.connecting !== undefined) return this.connecting;
        this.connecting = (async () => {
            const conn = await this.factory();
            const g = AnonymousTraversalSource.traversal().withRemote(conn) as GraphTraversalSource;
            this.conn = conn;
            this.gSource = g;
            this.connectedAt = Date.now();
            return g;
        })();
        try {
            return await this.connecting;
        } finally {
            this.connecting = undefined;
        }
    }

    private isStale(): boolean {
        return (
            this.maxConnectionAgeMs !== undefined &&
            Date.now() - this.connectedAt >= this.maxConnectionAgeMs
        );
    }

    /** Close the current connection and clear cached state so the next
     *  `source()` rebuilds via the factory. */
    private async dispose(): Promise<void> {
        const conn = this.conn;
        this.conn = undefined;
        this.gSource = undefined;
        this.connectedAt = 0;
        if (conn !== undefined) {
            try {
                await conn.close();
            } catch {
                // A connection we are discarding failing to close cleanly is
                // not actionable — the rebuild proceeds regardless.
            }
        }
    }

    /** Run an operation against the live source, rebuilding the connection and
     *  retrying once if it fails with a connection-level error. */
    private async run<T>(fn: (g: GraphTraversalSource) => Promise<T>): Promise<T> {
        const g = await this.source();
        try {
            return await fn(g);
        } catch (e) {
            if (!isConnectionError(e)) throw e;
            await this.dispose();
            return fn(await this.source());
        }
    }

    /** Eagerly establish the connection. Idempotent. */
    async connect(): Promise<void> {
        await this.source();
    }

    /** Close the owned connection and release cached state. */
    async close(): Promise<void> {
        await this.dispose();
    }

    private register(schema: SchemaMetadata): void {
        this.schemas.set(schema.name, schema);
    }

    private cachedSchemas(): SchemaMap {
        return this.schemas;
    }

    private labelFns(): LabelFns {
        return { vertexLabel: (s) => this.label(s), edgeLabel: (s) => this.edgeLabel(s) };
    }

    async ensureSchema(schema: SchemaMetadata): Promise<void> {
        this.register(schema);
        await this.run((g) => ensureIndexes(g, schema));
    }

    async create(
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        // Resolve the id once, outside the retry, so a rebuilt-connection retry
        // re-inserts with the same id rather than minting a fresh one.
        const idVal = data["id"] ?? this.generateId();
        const id = await this.run((g) => schema.edge !== undefined
            ? this.insertEdge(g, schema, data, schemas, idVal)
            : this.insertVertex(g, schema, data, schemas, idVal));
        const fetched = await this.fetchById(schema, id, projection);
        if (fetched === null) {
            throw new GremlinAdapterInternal("Created record not found post-insert");
        }
        return fetched;
    }

    private async insertVertex(
        g: GraphTraversalSource,
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        schemas: SchemaMap,
        idVal: unknown,
    ): Promise<unknown> {
        let trav: GraphTraversal = g.addV(this.label(schema)).property(t.id, idVal);
        const { props } = toProps(data, schema, schemas, { excludeId: true, multiProperty: true });
        trav = applyProps(trav, props);
        const res = await trav.id().next();
        return res.value;
    }

    private async insertEdge(
        g: GraphTraversalSource,
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        schemas: SchemaMap,
        idVal: unknown,
    ): Promise<unknown> {
        const meta = schema.edge!;
        const fromId = data[meta.fromField];
        const toId = data[meta.toField];
        if (fromId === undefined || toId === undefined) {
            throw new GremlinAdapterInvalidQuery(
                `Edge "${schema.name}" requires "${meta.fromField}" and "${meta.toField}" endpoint ids`,
            );
        }
        // Edges cannot carry multi-properties; arrays are JSON-encoded.
        const { props } = toProps(data, schema, schemas, {
            excludeId: true,
            multiProperty: false,
            excludeFields: [meta.fromField, meta.toField],
        });
        let trav: GraphTraversal = g
            .V(fromId)
            .addE(this.edgeLabel(schema))
            .to(__.V(toId))
            .property(t.id, idVal);
        trav = applyProps(trav, props);
        const res = await trav.id().next();
        if (res.done === true || res.value === undefined) {
            throw new GremlinAdapterInternal(
                `Edge endpoints not found (from=${String(fromId)}, to=${String(toId)})`,
            );
        }
        return res.value;
    }

    async read(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        return this.run(async (g) => {
            const base = applyWhere(this.base(g, schema), where, schema, schemas).limit(1);
            const res = await emitProjected(base, schema, projection, schemas).next();
            if (res.done === true || res.value === undefined || res.value === null) return null;
            return parseProjectedRow(res.value, schema, projection, schemas);
        });
    }

    async list(
        schema: SchemaMetadata,
        query: ListQuery,
    ): Promise<Record<string, unknown>[]> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        return this.run(async (g) => {
            let trav = applyWhere(this.base(g, schema), query.where, schema, schemas);

            const entries = translateSort(query.sort);
            const paginating = query.skip !== undefined || query.limit !== undefined;
            // Add a deterministic id tiebreaker when slicing.
            const order = paginating && !entries.some((e) => e.key === "id")
                ? [...entries, { key: "id", desc: false }]
                : entries;
            trav = applyOrder(trav, order);
            trav = applyRange(trav, query.skip, query.limit);

            const rows = (await emitProjected(trav, schema, query.projection, schemas).toList()) as unknown[];
            return rows.map((r) => parseProjectedRow(r, schema, query.projection, schemas));
        });
    }

    async count(schema: SchemaMetadata, where?: Record<string, unknown>): Promise<number> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        return this.run(async (g) => {
            const trav = applyWhere(this.base(g, schema), where ?? {}, schema, schemas);
            const res = await trav.count().next();
            return Number(res.value ?? 0);
        });
    }

    async update(
        schema: SchemaMetadata,
        where: Record<string, unknown>,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        const isEdge = schema.edge !== undefined;
        const id = await this.run(async (g) => {
            let trav = applyWhere(this.base(g, schema), where, schema, schemas).limit(1);

            const { props, nulls } = toProps(data, schema, schemas, {
                excludeId: true,
                multiProperty: !isEdge,
                ...(isEdge && { excludeFields: [schema.edge!.fromField, schema.edge!.toField] }),
            });
            for (const key of nulls) {
                trav = trav.sideEffect(__.properties(key).drop());
            }
            for (const p of props) {
                if (p.list === true) {
                    trav = trav.sideEffect(__.properties(p.key).drop());
                    for (const elem of p.value as unknown[]) {
                        trav = trav.property(cardinality.list, p.key, elem);
                    }
                } else {
                    trav = trav.property(cardinality.single, p.key, p.value);
                }
            }
            const res = await trav.id().next();
            if (res.done === true || res.value === undefined) {
                throw new GremlinAdapterInternal("Update target not found");
            }
            return res.value;
        });
        const fetched = await this.fetchById(schema, id, projection);
        if (fetched === null) {
            throw new GremlinAdapterInternal("Updated record not found post-update");
        }
        return fetched;
    }

    async delete(schema: SchemaMetadata, where: Record<string, unknown>): Promise<void> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        await this.run(async (g) => {
            const trav = applyWhere(this.base(g, schema), where, schema, schemas).limit(1);
            await trav.drop().iterate();
        });
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

        return this.run(async (g) => {
            const result = await runTraverse(g, ctx, spec, this.cachedSchemas(), this.labelFns());
            if (spec.emit === "nodes" && projection !== undefined) {
                return this.hydrateNodes(g, result as Record<string, unknown>[], ctx.terminalSchema, projection);
            }
            return result;
        });
    }

    // ── internals ───────────────────────────────────────────────────────────

    private base(g: GraphTraversalSource, schema: SchemaMetadata): GraphTraversal {
        return schema.edge !== undefined
            ? g.E().hasLabel(this.edgeLabel(schema))
            : g.V().hasLabel(this.label(schema));
    }

    private async fetchById(
        schema: SchemaMetadata,
        id: unknown,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown> | null> {
        return this.read(schema, { id }, projection);
    }

    /** Apply projection to a materialized set of traverse terminal nodes. Field
     *  pruning is local; populate is resolved with a single batched, projected
     *  query keyed on the nodes' ids (no per-node round-trip). */
    private async hydrateNodes(
        g: GraphTraversalSource,
        recs: Record<string, unknown>[],
        schema: SchemaMetadata,
        projection: AdapterProjection,
    ): Promise<Record<string, unknown>[]> {
        if (!hasPopulate(projection)) {
            return recs.map((r) => selectFields(r, projection));
        }
        const ids = recs.map((r) => r["id"]).filter((v) => v !== undefined);
        if (ids.length === 0) return recs.map((r) => selectFields(r, projection));

        const schemas = this.cachedSchemas();
        const base = g.V().hasLabel(this.label(schema)).hasId(P.within(...ids));
        const rows = (await emitProjected(base, schema, projection, schemas).toList()) as unknown[];
        const byId = new Map<unknown, Record<string, unknown>>();
        for (const row of rows) {
            const rec = parseProjectedRow(row, schema, projection, schemas);
            byId.set(rec["id"], rec);
        }
        return recs.map((r) => byId.get(r["id"]) ?? selectFields(r, projection));
    }
}

/** Best-effort classification of a thrown error as a connection-level failure
 *  (a dropped socket, a closed/expired connection, a connect timeout) rather
 *  than a query/server error. The Gremlin driver surfaces these as generic
 *  `Error`s with no stable code, so we match on the wording the driver and the
 *  underlying `ws`/socket layers use. A false negative just means no retry; a
 *  false positive costs one connection rebuild. */
function isConnectionError(e: unknown): boolean {
    if (typeof e !== "object" || e === null) return false;
    const code = (e as { code?: unknown }).code;
    if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" || code === "ETIMEDOUT") {
        return true;
    }
    const text = `${(e as { name?: string }).name ?? ""} ${(e as { message?: string }).message ?? ""}`
        .toLowerCase();
    return (
        text.includes("websocket is not open") ||
        text.includes("not opened") ||
        text.includes("connection is closed") ||
        text.includes("connection closed") ||
        text.includes("socket hang up") ||
        text.includes("connection reset") ||
        text.includes("connection refused") ||
        text.includes("server has closed the connection") ||
        text.includes("connect timed out") ||
        text.includes("not connected")
    );
}

function applyProps(trav: GraphTraversal, props: PropEntry[]): GraphTraversal {
    let t2 = trav;
    for (const p of props) {
        if (p.list === true) {
            for (const elem of p.value as unknown[]) {
                t2 = t2.property(cardinality.list, p.key, elem);
            }
        } else {
            t2 = t2.property(p.key, p.value);
        }
    }
    return t2;
}
