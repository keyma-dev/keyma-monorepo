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
} from "@keyma/runtime-js";
import { __, cardinality, P, t } from "./gremlin.js";
import type { GraphTraversal, GraphTraversalSource } from "./gremlin.js";
import { applyOrder, applyRange, applyWhere, translateSort } from "./filter.js";
import { toProps, type PropEntry, type SchemaMap } from "./props.js";
import { hasPopulate, selectFields } from "./projection.js";
import { emitProjected, parseProjectedRow } from "./read.js";
import { ensureIndexes } from "./indexes.js";
import { runTraverse } from "./traverse.js";
import type { LabelFns } from "./traverse-steps.js";
import { GremlinAdapterInternal, GremlinAdapterInvalidQuery } from "./errors.js";

export interface GremlinAdapterOptions {
    /** Override how a schema maps to its vertex label. Defaults to `schema.name`. */
    label?: (schema: SchemaMetadata) => string;
    /** Override how an edge schema maps to its Gremlin edge label. Must agree
     *  with what traversals use; defaults to `schema.name`. */
    edgeLabel?: (schema: SchemaMetadata) => string;
    /** Override the id generator used when a record is created without an `id`.
     *  Supplied as the element's `T.id`. Defaults to `crypto.randomUUID()` so
     *  ids are consistent strings on backends that honor user-supplied ids
     *  (TinkerGraph, Neptune). */
    generateId?: () => string;
}

/** A Keyma database adapter backed by Apache TinkerPop / Gremlin. Talks to any
 *  Gremlin-enabled store (TinkerGraph, Neptune, JanusGraph, …) through a
 *  connected `GraphTraversalSource` using bytecode GLV. Non-edge schemas map to
 *  vertices; `@Edge` schemas map to real edges and drive `traverse()`. */
export class GremlinAdapter implements KeymaDatabaseAdapter {
    readonly capabilities: AdapterCapabilities = {
        traverse: { maxDepth: 50, emitPaths: true, heterogeneous: true },
    };

    private readonly schemas = new Map<string, SchemaMetadata>();
    private readonly label: (schema: SchemaMetadata) => string;
    private readonly edgeLabel: (schema: SchemaMetadata) => string;
    private readonly generateId: () => string;

    constructor(
        private readonly g: GraphTraversalSource,
        opts: GremlinAdapterOptions = {},
    ) {
        this.label = opts.label ?? ((s) => s.name);
        this.edgeLabel = opts.edgeLabel ?? ((s) => s.name);
        this.generateId = opts.generateId ?? (() => randomUUID());
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
        await ensureIndexes(this.g, schema);
    }

    async create(
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        projection?: AdapterProjection,
    ): Promise<Record<string, unknown>> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        const id = schema.edge !== undefined
            ? await this.insertEdge(schema, data, schemas)
            : await this.insertVertex(schema, data, schemas);
        const fetched = await this.fetchById(schema, id, projection);
        if (fetched === null) {
            throw new GremlinAdapterInternal("Created record not found post-insert");
        }
        return fetched;
    }

    private async insertVertex(
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        schemas: SchemaMap,
    ): Promise<unknown> {
        const idVal = data["id"] ?? this.generateId();
        let trav: GraphTraversal = this.g.addV(this.label(schema)).property(t.id, idVal);
        const { props } = toProps(data, schema, schemas, { excludeId: true, multiProperty: true });
        trav = applyProps(trav, props);
        const res = await trav.id().next();
        return res.value;
    }

    private async insertEdge(
        schema: SchemaMetadata,
        data: Record<string, unknown>,
        schemas: SchemaMap,
    ): Promise<unknown> {
        const meta = schema.edge!;
        const fromId = data[meta.fromField];
        const toId = data[meta.toField];
        if (fromId === undefined || toId === undefined) {
            throw new GremlinAdapterInvalidQuery(
                `Edge "${schema.name}" requires "${meta.fromField}" and "${meta.toField}" endpoint ids`,
            );
        }
        const idVal = data["id"] ?? this.generateId();
        // Edges cannot carry multi-properties; arrays are JSON-encoded.
        const { props } = toProps(data, schema, schemas, { excludeId: true, multiProperty: false });
        let trav: GraphTraversal = this.g
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
        const base = applyWhere(this.base(schema), where, schema, schemas).limit(1);
        const res = await emitProjected(base, schema, projection, schemas).next();
        if (res.done === true || res.value === undefined || res.value === null) return null;
        return parseProjectedRow(res.value, schema, projection, schemas);
    }

    async list(
        schema: SchemaMetadata,
        query: ListQuery,
    ): Promise<Record<string, unknown>[]> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        let trav = applyWhere(this.base(schema), query.where, schema, schemas);

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
        let trav = applyWhere(this.base(schema), where, schema, schemas).limit(1);

        const { props, nulls } = toProps(data, schema, schemas, {
            excludeId: true,
            multiProperty: !isEdge,
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
        const fetched = await this.fetchById(schema, res.value, projection);
        if (fetched === null) {
            throw new GremlinAdapterInternal("Updated record not found post-update");
        }
        return fetched;
    }

    async delete(schema: SchemaMetadata, where: Record<string, unknown>): Promise<void> {
        this.register(schema);
        const schemas = this.cachedSchemas();
        const trav = applyWhere(this.base(schema), where, schema, schemas).limit(1);
        await trav.drop().iterate();
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

        const result = await runTraverse(this.g, ctx, spec, this.cachedSchemas(), this.labelFns());
        if (spec.emit === "nodes" && projection !== undefined) {
            return this.hydrateNodes(result as Record<string, unknown>[], ctx.terminalSchema, projection);
        }
        return result;
    }

    // ── internals ───────────────────────────────────────────────────────────

    private base(schema: SchemaMetadata): GraphTraversal {
        return schema.edge !== undefined
            ? this.g.E().hasLabel(this.edgeLabel(schema))
            : this.g.V().hasLabel(this.label(schema));
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
        const base = this.g.V().hasLabel(this.label(schema)).hasId(P.within(...ids));
        const rows = (await emitProjected(base, schema, projection, schemas).toList()) as unknown[];
        const byId = new Map<unknown, Record<string, unknown>>();
        for (const row of rows) {
            const rec = parseProjectedRow(row, schema, projection, schemas);
            byId.set(rec["id"], rec);
        }
        return recs.map((r) => byId.get(r["id"]) ?? selectFields(r, projection));
    }
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
