import { sql } from "kysely";
import type {
    AdapterFieldSpec,
    AdapterProjection,
    FieldType,
    PopulateNode,
    PopulateSpec,
    SchemaMetadata,
} from "@keyma/runtime/schema";
import { SqliteAdapterInvalidQuery } from "./errors.js";
import type { SchemaMap } from "./kysely.js";
import type { TableNameFn } from "./adapter.js";

export function needsPopulate(projection: AdapterProjection | undefined): boolean {
    return (
        projection?.populate !== undefined
        && Object.keys(projection.populate).length > 0
    );
}

/** Add SELECT columns + LEFT JOINs to a select query builder. Mutates type
 *  via successive method calls; returns the new builder. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyProjection<QB extends any>(
    qb: QB,
    schema: SchemaMetadata,
    schemas: SchemaMap,
    projection: AdapterProjection | undefined,
    tableName: TableNameFn,
): QB {
    const table = tableName(schema);
    // Determine which fields to select. If projection.fields is missing or
    // empty, select every non-ephemeral field.
    const fieldNames = baseFieldNames(schema, projection?.fields);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let out: any = qb;
    const selectExprs: unknown[] = [];
    for (const name of fieldNames) {
        // Strip out fields that are being replaced by a populated reference —
        // we'll add those as json_object expressions below.
        if (projection?.populate !== undefined && name in projection.populate) continue;
        selectExprs.push(sql.ref(`${table}.${name}`).as(name));
    }

    if (projection?.populate !== undefined) {
        for (const [field, node] of Object.entries(projection.populate)) {
            const meta = schema.fields.find((f) => f.name === field);
            if (meta === undefined) {
                throw new SqliteAdapterInvalidQuery(
                    `populate target "${field}" not found on schema "${schema.name}"`,
                );
            }
            const refKind = coreType(meta.type);
            if (refKind.kind !== "reference") {
                throw new SqliteAdapterInvalidQuery(
                    `populate target "${field}" must be a reference, got ${refKind.kind}`,
                );
            }
            const alias = "_p_" + field;
            const refTable = tableName(node.schema);
            out = out.leftJoin(
                `${refTable} as ${alias}`,
                `${alias}.id`,
                `${table}.${field}`,
            );
            const jsonExpr = jsonObjectExpr(alias, node, schemas);
            selectExprs.push(jsonExpr.as(field));
        }
    }

    out = out.select(selectExprs);
    return out as QB;
}

/** Compute the list of column names to select for a schema, optionally filtered
 *  through `projection.fields`. Only top-level field selection is supported —
 *  nested AdapterFieldSpec values are ignored for SQLite (the field is included
 *  whole, just like the Mongo adapter for non-embedded paths). */
function baseFieldNames(
    schema: SchemaMetadata,
    fields: { [k: string]: AdapterFieldSpec } | undefined,
): string[] {
    if (fields === undefined) {
        return schema.fields
            .filter((f) => f.ephemeral !== true)
            .map((f) => f.name);
    }
    const keys = Object.keys(fields);
    if (keys.length === 0) return [];
    // Always include id so the row is keyable; the Mongo adapter does
    // similarly via excluding _id only when not asked for.
    if (!keys.includes("id")) keys.push("id");
    return keys;
}

function coreType(t: FieldType): FieldType {
    if (t.kind === "array") return coreType(t.of);
    return t;
}

/** Build a `json_object('k1', alias.col1, 'k2', alias.col2, …)` SQL fragment
 *  for one populated reference. Recurses for nested populate via a correlated
 *  scalar subquery — for the MVP we don't support populate-within-populate,
 *  but the structure is here in case we add it later. */
function jsonObjectExpr(
    alias: string,
    node: PopulateNode,
    _schemas: SchemaMap,
): ReturnType<typeof sql> {
    const subSchema = node.schema;
    const names = baseFieldNames(subSchema, node.projection?.fields);
    if (names.length === 0) {
        return sql`json_object()`;
    }
    const fragments: ReturnType<typeof sql>[] = [];
    for (const name of names) {
        // Pair = literal key + alias.column
        fragments.push(sql`${sql.lit(name)}, ${sql.ref(`${alias}.${name}`)}`);
    }
    // `CASE WHEN <alias>.id IS NULL THEN NULL ELSE json_object(...) END`
    // so populated columns surface as null when the LEFT JOIN didn't find a row.
    return sql`CASE WHEN ${sql.ref(`${alias}.id`)} IS NULL THEN NULL ELSE json_object(${sql.join(fragments, sql`, `)}) END`;
}

// Re-exports for callers
export type { PopulateSpec };
