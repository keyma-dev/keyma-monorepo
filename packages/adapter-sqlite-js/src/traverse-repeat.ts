import { sql } from "kysely";
import type {
    AdapterProjection,
    AdapterTraversalContext,
    AdapterTraversalResult,
    SchemaMetadata,
    TraversalSpec,
} from "@keyma/runtime-js";
import type { AnyDb, SchemaMap } from "./kysely.js";
import type { TableNameFn } from "./adapter.js";
import { SqliteAdapterInvalidQuery } from "./errors.js";
import { toRecord, valueToSqlite } from "./record.js";
import { findFieldType } from "./filter.js";

export async function runRepeatTraversal(
    db: AnyDb,
    ctx: AdapterTraversalContext,
    spec: TraversalSpec,
    _projection: AdapterProjection | undefined,
    schemas: SchemaMap,
    tableName: TableNameFn,
): Promise<AdapterTraversalResult> {
    const repeat = spec.repeat;
    if (repeat === undefined) {
        throw new SqliteAdapterInvalidQuery("repeat traversal requires spec.repeat");
    }
    if (repeat.direction === "both") {
        throw new SqliteAdapterInvalidQuery(
            'repeat traversal with direction "both" is not yet implemented',
        );
    }

    const edgeSchema = ctx.edges.get(repeat.via);
    if (edgeSchema === undefined || edgeSchema.edge === undefined) {
        throw new SqliteAdapterInvalidQuery(`Edge schema "${repeat.via}" not registered`);
    }
    const edgeMeta = edgeSchema.edge;

    const fromField = repeat.direction === "out" ? edgeMeta.fromField : edgeMeta.toField;
    const toField = repeat.direction === "out" ? edgeMeta.toField : edgeMeta.fromField;

    const startTable = tableName(ctx.startSchema);
    const edgeTable = tableName(edgeSchema);
    const terminalTable = tableName(ctx.terminalSchema);

    const depthMax = spec.depth?.max ?? 1;
    const depthMin = spec.depth?.min ?? 1;

    const emit = spec.emit ?? "nodes";
    if (emit === "paths") {
        return runPathsFallback(db, ctx, spec, schemas, tableName);
    }

    // Build the base-case WHERE for start.
    const startWhere = buildPlainWhere(spec.start.where, ctx.startSchema, schemas);
    // Build the optional edgeWhere as an AND-chain.
    const edgeWhereFrag = buildPlainWhere(repeat.edgeWhere ?? {}, edgeSchema, schemas, "e");
    const edgeWhereSql = edgeWhereFrag === null ? sql`` : sql` AND ${edgeWhereFrag}`;

    // The recursive CTE.
    // Note: SQLite's `json_insert(path, '$[#]', val)` appends to a JSON array.
    // `json_each(path)` lets us check for cycle membership.
    const cte = sql`
WITH RECURSIVE _traversal(id, depth, path, last_edge_id) AS (
    SELECT ${sql.ref("id")}, 0, json_array(${sql.ref("id")}), NULL
    FROM ${sql.ref(startTable)}
    ${startWhere === null ? sql`` : sql`WHERE ${startWhere}`}
  UNION ALL
    SELECT n2.${sql.ref("id")}, t.depth + 1, json_insert(t.path, '$[#]', n2.${sql.ref("id")}), e.${sql.ref("id")}
    FROM _traversal t
    INNER JOIN ${sql.ref(edgeTable)} e ON e.${sql.ref(fromField)} = t.${sql.ref("id")}${edgeWhereSql}
    INNER JOIN ${sql.ref(terminalTable)} n2 ON n2.${sql.ref("id")} = e.${sql.ref(toField)}
    WHERE t.depth < ${sql.val(depthMax)}
      AND NOT EXISTS (SELECT 1 FROM json_each(t.path) WHERE value = n2.${sql.ref("id")})
)`;

    if (emit === "edges") {
        // SELECT distinct edges traversed at depths [depthMin..depthMax].
        // last_edge_id is NULL at depth 0; depthMin >= 1 ensures we skip it.
        const minEdgeDepth = Math.max(1, depthMin);
        const wholeSql = sql`${cte}
SELECT e.*
FROM _traversal t
INNER JOIN ${sql.ref(edgeTable)} e ON e.${sql.ref("id")} = t.last_edge_id
WHERE t.depth BETWEEN ${sql.val(minEdgeDepth)} AND ${sql.val(depthMax)}
GROUP BY e.${sql.ref("id")}
ORDER BY e.${sql.ref("id")}
${optionsClause(spec)}`;
        const result = await wholeSql.execute(db);
        return (result.rows as Record<string, unknown>[]).map((r) => toRecord(r, edgeSchema, schemas));
    }

    // emit nodes (default).
    const specWhereFrag = spec.where !== undefined
        ? buildPlainWhere(spec.where, ctx.terminalSchema, schemas, "n")
        : null;
    const specWhereSql = specWhereFrag === null ? sql`` : sql` AND ${specWhereFrag}`;

    const wholeSql = sql`${cte}
SELECT n.*
FROM _traversal t
INNER JOIN ${sql.ref(terminalTable)} n ON n.${sql.ref("id")} = t.${sql.ref("id")}
WHERE t.depth BETWEEN ${sql.val(depthMin)} AND ${sql.val(depthMax)}${specWhereSql}
GROUP BY n.${sql.ref("id")}
ORDER BY n.${sql.ref("id")}
${optionsClause(spec)}`;
    const result = await wholeSql.execute(db);
    return (result.rows as Record<string, unknown>[]).map((r) => toRecord(r, ctx.terminalSchema, schemas));
}

/** Build a raw SQL fragment for a WHERE clause from a Keyma where object.
 *  This is a parallel of `filter.ts`'s builder but emits raw SQL rather than
 *  Kysely expressions, since we're hand-rolling the CTE. Supports the same
 *  operator set. Returns `null` for an empty where. */
function buildPlainWhere(
    where: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
    alias?: string,
): ReturnType<typeof sql> | null {
    const keys = Object.keys(where);
    if (keys.length === 0) return null;
    const frags: ReturnType<typeof sql>[] = [];
    for (const [key, value] of Object.entries(where)) {
        if (key === "$and" || key === "$or" || key === "$nor") {
            if (!Array.isArray(value)) {
                throw new SqliteAdapterInvalidQuery(`${key} expects an array of sub-filters`);
            }
            const subs = value
                .map((sub) => {
                    if (sub === null || typeof sub !== "object") {
                        throw new SqliteAdapterInvalidQuery(`${key} sub-filter must be an object`);
                    }
                    return buildPlainWhere(sub as Record<string, unknown>, schema, schemas, alias);
                })
                .filter((s): s is ReturnType<typeof sql> => s !== null);
            if (subs.length === 0) continue;
            const joiner = key === "$and" ? sql` AND ` : sql` OR `;
            const combined = sql`(${sql.join(subs, joiner)})`;
            frags.push(key === "$nor" ? sql`NOT ${combined}` : combined);
            continue;
        }
        const colRef = alias !== undefined ? sql.ref(`${alias}.${key}`) : sql.ref(key);
        const fieldType = findFieldType(schema, key);
        frags.push(buildFieldFragment(colRef, value, fieldType, schemas));
    }
    if (frags.length === 0) return null;
    return sql`(${sql.join(frags, sql` AND `)})`;
}

function buildFieldFragment(
    colRef: ReturnType<typeof sql.ref>,
    value: unknown,
    fieldType: ReturnType<typeof findFieldType>,
    schemas: SchemaMap,
): ReturnType<typeof sql> {
    if (value === null) return sql`${colRef} IS NULL`;
    if (isOperatorObject(value)) {
        const frags: ReturnType<typeof sql>[] = [];
        for (const [op, operand] of Object.entries(value)) {
            frags.push(buildOpFragment(colRef, op, operand, fieldType, schemas));
        }
        if (frags.length === 1) return frags[0]!;
        return sql`(${sql.join(frags, sql` AND `)})`;
    }
    return sql`${colRef} = ${sql.val(valueToSqlite(value, fieldType, schemas))}`;
}

const COMPARISON_OPS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"]);

function isOperatorObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (value instanceof Date) return false;
    if (value instanceof Uint8Array) return false;
    for (const k of Object.keys(value)) {
        if (!COMPARISON_OPS.has(k)) return false;
    }
    return Object.keys(value).length > 0;
}

function buildOpFragment(
    colRef: ReturnType<typeof sql.ref>,
    op: string,
    operand: unknown,
    fieldType: ReturnType<typeof findFieldType>,
    schemas: SchemaMap,
): ReturnType<typeof sql> {
    switch (op) {
        case "$eq":
            if (operand === null) return sql`${colRef} IS NULL`;
            return sql`${colRef} = ${sql.val(valueToSqlite(operand, fieldType, schemas))}`;
        case "$ne":
            if (operand === null) return sql`${colRef} IS NOT NULL`;
            return sql`${colRef} <> ${sql.val(valueToSqlite(operand, fieldType, schemas))}`;
        case "$gt":
            return sql`${colRef} > ${sql.val(valueToSqlite(operand, fieldType, schemas))}`;
        case "$gte":
            return sql`${colRef} >= ${sql.val(valueToSqlite(operand, fieldType, schemas))}`;
        case "$lt":
            return sql`${colRef} < ${sql.val(valueToSqlite(operand, fieldType, schemas))}`;
        case "$lte":
            return sql`${colRef} <= ${sql.val(valueToSqlite(operand, fieldType, schemas))}`;
        case "$in":
            if (!Array.isArray(operand)) {
                throw new SqliteAdapterInvalidQuery("$in expects an array operand");
            }
            if (operand.length === 0) return sql`1 = 0`;
            return sql`${colRef} IN (${sql.join(
                operand.map((v) => sql.val(valueToSqlite(v, fieldType, schemas))),
                sql`, `,
            )})`;
        case "$nin":
            if (!Array.isArray(operand)) {
                throw new SqliteAdapterInvalidQuery("$nin expects an array operand");
            }
            if (operand.length === 0) return sql`1 = 1`;
            return sql`${colRef} NOT IN (${sql.join(
                operand.map((v) => sql.val(valueToSqlite(v, fieldType, schemas))),
                sql`, `,
            )})`;
        default:
            throw new SqliteAdapterInvalidQuery(`Unknown filter operator "${op}"`);
    }
}

function optionsClause(spec: TraversalSpec): ReturnType<typeof sql> {
    const opts = spec.options ?? {};
    const parts: ReturnType<typeof sql>[] = [];
    if (opts.limit !== undefined) parts.push(sql`LIMIT ${sql.val(opts.limit)}`);
    if (opts.skip !== undefined) parts.push(sql`OFFSET ${sql.val(opts.skip)}`);
    if (parts.length === 0) return sql``;
    return sql`${sql.join(parts, sql` `)}`;
}

/** For emit:"paths" in repeat mode, fall back to running one steps-pipeline
 *  per depth in [depthMin..depthMax] and concatenating the results. Same
 *  approach as the Mongo adapter's path fallback. */
async function runPathsFallback(
    db: AnyDb,
    ctx: AdapterTraversalContext,
    spec: TraversalSpec,
    schemas: SchemaMap,
    tableName: TableNameFn,
): Promise<AdapterTraversalResult> {
    const { runStepsTraversal } = await import("./traverse-steps.js");
    const repeat = spec.repeat!;
    const depthMax = spec.depth?.max ?? 1;
    const depthMin = spec.depth?.min ?? 1;
    const all: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }[] = [];
    for (let d = depthMin; d <= depthMax; d++) {
        const steps = Array.from({ length: d }, () => ({
            via: repeat.via,
            direction: repeat.direction,
            ...(repeat.edgeWhere !== undefined ? { edgeWhere: repeat.edgeWhere } : {}),
        }));
        const subSpec: TraversalSpec = {
            start: spec.start,
            steps,
            emit: "paths",
            ...(spec.where !== undefined ? { where: spec.where } : {}),
        };
        const partial = await runStepsTraversal(db, ctx, subSpec, undefined, schemas, tableName);
        const pathsAtDepth = partial as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }[];
        for (const p of pathsAtDepth) all.push(p);
    }
    return all;
}
