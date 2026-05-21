import { sql } from "kysely";
import type {
    AdapterProjection,
    AdapterTraversalContext,
    AdapterTraversalResult,
    EdgeMetadata,
    SchemaMetadata,
    TraversalDirection,
    TraversalSpec,
    TraversalStep,
} from "@keyma/runtime-js";
import type { AnyDb, SchemaMap } from "./kysely.js";
import type { TableNameFn } from "./adapter.js";
import { buildExpression } from "./filter.js";
import { toRecord } from "./record.js";
import { SqliteAdapterInvalidQuery } from "./errors.js";

type StepResolution = {
    edge: SchemaMetadata;
    edgeMeta: EdgeMetadata;
    nextNode: SchemaMetadata;
    direction: TraversalDirection;
};

export async function runStepsTraversal(
    db: AnyDb,
    ctx: AdapterTraversalContext,
    spec: TraversalSpec,
    _projection: AdapterProjection | undefined,
    schemas: SchemaMap,
    tableName: TableNameFn,
): Promise<AdapterTraversalResult> {
    const steps = spec.steps ?? [];
    if (steps.length === 0) {
        throw new SqliteAdapterInvalidQuery("steps traversal requires at least one step");
    }

    // Resolve each step to its edge metadata and next node schema.
    const resolutions: StepResolution[] = [];
    let currentNode = ctx.startSchema;
    for (const step of steps) {
        const r = resolveStep(step, ctx, currentNode);
        resolutions.push(r);
        currentNode = r.nextNode;
    }
    const terminalSchema = resolutions[resolutions.length - 1]!.nextNode;
    const lastIdx = resolutions.length - 1;

    const startTable = tableName(ctx.startSchema);
    const startAlias = "n_start";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let qb: any = db.selectFrom(`${startTable} as ${startAlias}`);

    // Start where.
    const startWhere = spec.start.where;
    if (Object.keys(startWhere).length > 0) {
        qb = qb.where((eb: any) =>
            buildExpression(eb, startWhere, ctx.startSchema, schemas, startAlias),
        );
    }

    let prevAlias = startAlias;
    for (let i = 0; i < resolutions.length; i++) {
        const r = resolutions[i]!;
        const step = steps[i]!;
        const edgeAlias = "e" + i;
        const nodeAlias = "n" + i;
        const edgeTable = tableName(r.edge);
        const nodeTable = tableName(r.nextNode);

        const joinExpr = edgeJoinExpr(r, prevAlias, edgeAlias);
        const edgeWhere = step.edgeWhere;
        const nodeWhere = step.nodeWhere;

        // Edge JOIN — use Kysely's `.innerJoin(alias, callback)` with a JoinBuilder.
        qb = qb.innerJoin(`${edgeTable} as ${edgeAlias}`, (j: any) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let jb: any = j.on(joinExpr);
            if (edgeWhere !== undefined && Object.keys(edgeWhere).length > 0) {
                jb = jb.on((eb: any) =>
                    buildExpression(eb, edgeWhere, r.edge, schemas, edgeAlias),
                );
            }
            return jb;
        });

        // Node JOIN.
        const nodeIdMatch = nodeJoinExpr(r, edgeAlias, nodeAlias);
        qb = qb.innerJoin(`${nodeTable} as ${nodeAlias}`, (j: any) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let jb: any = j.on(nodeIdMatch);
            if (nodeWhere !== undefined && Object.keys(nodeWhere).length > 0) {
                jb = jb.on((eb: any) =>
                    buildExpression(eb, nodeWhere, r.nextNode, schemas, nodeAlias),
                );
            }
            return jb;
        });

        prevAlias = nodeAlias;
    }

    // Spec-level where applies to the terminal node.
    if (spec.where !== undefined && Object.keys(spec.where).length > 0) {
        const lastNodeAlias = "n" + lastIdx;
        qb = qb.where((eb: any) =>
            buildExpression(eb, spec.where!, terminalSchema, schemas, lastNodeAlias),
        );
    }

    // SELECT shape varies by emit.
    const emit = spec.emit ?? "nodes";
    if (emit === "edges") {
        const edgeAlias = "e" + lastIdx;
        qb = qb.select(
            edgeColumns(resolutions[lastIdx]!.edge, edgeAlias),
        );
        applyListOptionsRaw(qb, schemas, undefined, edgeAlias, spec);
    } else if (emit === "paths") {
        // For each row, build per-hop JSON objects. We'll assemble the shape
        // `{ nodes: [...], edges: [...] }` in TS after reading.
        const exprs: unknown[] = [];
        exprs.push(jsonObjectExpr(ctx.startSchema, startAlias).as("_n_start"));
        for (let i = 0; i < resolutions.length; i++) {
            exprs.push(jsonObjectExpr(resolutions[i]!.edge, "e" + i).as("_e" + i));
            exprs.push(jsonObjectExpr(resolutions[i]!.nextNode, "n" + i).as("_n" + i));
        }
        qb = qb.select(exprs);
    } else {
        // emit nodes (default)
        const lastNodeAlias = "n" + lastIdx;
        qb = qb.select(nodeColumns(terminalSchema, lastNodeAlias));
    }

    // Sort/skip/limit applies to the emitted result set.
    qb = applyOptions(qb, spec, terminalSchema, resolutions);

    const rows = await qb.execute();

    if (emit === "edges") {
        const edgeSchema = resolutions[lastIdx]!.edge;
        return (rows as Record<string, unknown>[]).map((r) => toRecord(r, edgeSchema, schemas));
    }
    if (emit === "paths") {
        return assemblePaths(rows as Record<string, unknown>[], ctx.startSchema, resolutions, schemas);
    }
    return (rows as Record<string, unknown>[]).map((r) => toRecord(r, terminalSchema, schemas));
}

function resolveStep(
    step: TraversalStep,
    ctx: AdapterTraversalContext,
    currentNode: SchemaMetadata,
): StepResolution {
    const edge = ctx.edges.get(step.via);
    if (edge === undefined || edge.edge === undefined) {
        throw new SqliteAdapterInvalidQuery(`Edge schema "${step.via}" not registered`);
    }
    const edgeMeta = edge.edge;
    let nextSourceName: string;
    if (step.direction === "out") {
        nextSourceName = edgeMeta.to;
    } else if (step.direction === "in") {
        nextSourceName = edgeMeta.from;
    } else {
        // "both" — only valid on self-loop edges (from === to).
        if (edgeMeta.from !== edgeMeta.to) {
            throw new SqliteAdapterInvalidQuery(
                `direction "both" requires a self-loop edge (from === to); "${step.via}" connects ${edgeMeta.from} → ${edgeMeta.to}`,
            );
        }
        nextSourceName = edgeMeta.to;
    }
    const nextNode = nodeBySourceName(ctx, nextSourceName);
    if (nextNode === undefined) {
        throw new SqliteAdapterInvalidQuery(`Node schema "${nextSourceName}" not registered`);
    }
    void currentNode; // currently unused but kept for symmetry with Mongo
    return { edge, edgeMeta, nextNode, direction: step.direction };
}

function nodeBySourceName(
    ctx: AdapterTraversalContext,
    sourceName: string,
): SchemaMetadata | undefined {
    for (const node of ctx.nodes.values()) {
        if (node.sourceName === sourceName) return node;
    }
    return undefined;
}

/** JOIN condition that anchors the edge row to the previous-hop node id. */
function edgeJoinExpr(
    r: StepResolution,
    prevAlias: string,
    edgeAlias: string,
): ReturnType<typeof sql> {
    const meta = r.edgeMeta;
    if (r.direction === "out") {
        return sql`${sql.ref(`${edgeAlias}.${meta.fromField}`)} = ${sql.ref(`${prevAlias}.id`)}`;
    }
    if (r.direction === "in") {
        return sql`${sql.ref(`${edgeAlias}.${meta.toField}`)} = ${sql.ref(`${prevAlias}.id`)}`;
    }
    // both — self-loop only (verified in resolveStep)
    return sql`(${sql.ref(`${edgeAlias}.${meta.fromField}`)} = ${sql.ref(`${prevAlias}.id`)} OR ${sql.ref(`${edgeAlias}.${meta.toField}`)} = ${sql.ref(`${prevAlias}.id`)})`;
}

/** JOIN condition that anchors the next-hop node id to the edge's other end. */
function nodeJoinExpr(
    r: StepResolution,
    edgeAlias: string,
    nodeAlias: string,
): ReturnType<typeof sql> {
    const meta = r.edgeMeta;
    if (r.direction === "out") {
        return sql`${sql.ref(`${nodeAlias}.id`)} = ${sql.ref(`${edgeAlias}.${meta.toField}`)}`;
    }
    if (r.direction === "in") {
        return sql`${sql.ref(`${nodeAlias}.id`)} = ${sql.ref(`${edgeAlias}.${meta.fromField}`)}`;
    }
    // both — pick the side that isn't the previous node.
    // We can't reference the previous alias here because Kysely's onRef joins
    // run independently. Use a CASE on the edge row's endpoint:
    // node.id matches the endpoint NOT equal to the start-of-edge.
    // For a self-loop with direction both, fromField and toField both reference
    // the same node table, so picking either end gives one of two edge rows.
    return sql`(${sql.ref(`${nodeAlias}.id`)} = ${sql.ref(`${edgeAlias}.${meta.fromField}`)} OR ${sql.ref(`${nodeAlias}.id`)} = ${sql.ref(`${edgeAlias}.${meta.toField}`)})`;
}

function nodeColumns(schema: SchemaMetadata, alias: string): unknown[] {
    const out: unknown[] = [];
    for (const f of schema.fields) {
        if (f.computed === true || f.ephemeral === true) continue;
        out.push(sql.ref(`${alias}.${f.name}`).as(f.name));
    }
    return out;
}

function edgeColumns(schema: SchemaMetadata, alias: string): unknown[] {
    return nodeColumns(schema, alias);
}

/** Build a `json_object('field1', alias.col1, …)` SQL fragment for a row. */
function jsonObjectExpr(schema: SchemaMetadata, alias: string): ReturnType<typeof sql> {
    const fragments: ReturnType<typeof sql>[] = [];
    for (const f of schema.fields) {
        if (f.computed === true || f.ephemeral === true) continue;
        fragments.push(sql`${sql.lit(f.name)}, ${sql.ref(`${alias}.${f.name}`)}`);
    }
    if (fragments.length === 0) return sql`json_object()`;
    return sql`json_object(${sql.join(fragments, sql`, `)})`;
}

function applyOptions(
    qb: any,
    spec: TraversalSpec,
    terminalSchema: SchemaMetadata,
    resolutions: StepResolution[],
): any {
    const emit = spec.emit ?? "nodes";
    const lastIdx = resolutions.length - 1;
    const sortAlias = emit === "edges" ? "e" + lastIdx : "n" + lastIdx;
    const options = spec.options ?? {};
    const sortKeys = Object.keys(options.sort ?? {});

    let out = qb;
    let hasIdSort = false;
    if (options.sort !== undefined) {
        for (const k of sortKeys) {
            const dir = options.sort[k];
            if (dir === undefined) continue;
            if (k === "id") hasIdSort = true;
            out = out.orderBy(`${sortAlias}.${k}`, dir === -1 ? "desc" : "asc");
        }
    }
    if (!hasIdSort) {
        out = out.orderBy(`${sortAlias}.id`, "asc");
    }
    if (options.skip !== undefined) out = out.offset(options.skip);
    if (options.limit !== undefined) out = out.limit(options.limit);
    void terminalSchema;
    return out;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function applyListOptionsRaw(_qb: any, _schemas: SchemaMap, _projection: AdapterProjection | undefined, _alias: string, _spec: TraversalSpec): void {
    // placeholder for symmetry; applyOptions is the real implementation.
}

function assemblePaths(
    rows: Record<string, unknown>[],
    startSchema: SchemaMetadata,
    resolutions: StepResolution[],
    schemas: SchemaMap,
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }[] {
    return rows.map((row) => {
        const startRaw = row["_n_start"];
        const startObj = parseJsonRow(startRaw);
        const nodes: Record<string, unknown>[] = [];
        const edges: Record<string, unknown>[] = [];
        nodes.push(toRecord(startObj, startSchema, schemas));
        for (let i = 0; i < resolutions.length; i++) {
            const r = resolutions[i]!;
            const edgeObj = parseJsonRow(row["_e" + i]);
            const nodeObj = parseJsonRow(row["_n" + i]);
            edges.push(toRecord(edgeObj, r.edge, schemas));
            nodes.push(toRecord(nodeObj, r.nextNode, schemas));
        }
        return { nodes, edges };
    });
}

function parseJsonRow(value: unknown): Record<string, unknown> {
    if (value === null || value === undefined) return {};
    if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
    if (typeof value === "object") return value as Record<string, unknown>;
    return {};
}
