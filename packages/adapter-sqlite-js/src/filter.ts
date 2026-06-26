import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import type { FieldType, SchemaMetadata } from "@keyma/runtime/schema";
import { SqliteAdapterInvalidQuery } from "./errors.js";
import { valueToSqlite } from "./record.js";
import type { SchemaMap } from "./kysely.js";

const COMPARISON_OPS = new Set([
    "$eq",
    "$ne",
    "$gt",
    "$gte",
    "$lt",
    "$lte",
    "$in",
    "$nin",
]);
const LOGICAL_OPS = new Set(["$and", "$or", "$nor"]);

type AnyEB = ExpressionBuilder<Record<string, Record<string, unknown>>, string>;

/** Compose the WHERE clause onto the given Kysely query-like builder. Works
 *  for select / update / delete builders since they share `.where(cb)`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function translateWhereInto<QB extends { where: (cb: (eb: any) => Expression<SqlBool>) => QB }>(
    qb: QB,
    where: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
    columnPrefix?: string,
): QB {
    if (Object.keys(where).length === 0) return qb;
    return qb.where((eb) => buildExpression(eb as AnyEB, where, schema, schemas, columnPrefix));
}

export function buildExpression(
    eb: AnyEB,
    where: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
    columnPrefix?: string,
): Expression<SqlBool> {
    const conditions: Expression<SqlBool>[] = [];
    for (const [key, value] of Object.entries(where)) {
        if (LOGICAL_OPS.has(key)) {
            if (!Array.isArray(value)) {
                throw new SqliteAdapterInvalidQuery(`${key} expects an array of sub-filters`);
            }
            const subs = value.map((sub) => {
                if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
                    throw new SqliteAdapterInvalidQuery(`${key} sub-filter must be an object`);
                }
                return buildExpression(eb, sub as Record<string, unknown>, schema, schemas, columnPrefix);
            });
            if (key === "$and") conditions.push(eb.and(subs));
            else if (key === "$or") conditions.push(eb.or(subs));
            else conditions.push(eb.not(eb.or(subs)));
            continue;
        }
        const fieldType = findFieldType(schema, key);
        const colRef = columnPrefix !== undefined ? `${columnPrefix}.${key}` : key;
        conditions.push(buildFieldCondition(eb, colRef, value, fieldType, schemas));
    }
    if (conditions.length === 0) return eb.val(true) as unknown as Expression<SqlBool>;
    if (conditions.length === 1) return conditions[0]!;
    return eb.and(conditions);
}

function buildFieldCondition(
    eb: AnyEB,
    col: string,
    value: unknown,
    fieldType: FieldType | undefined,
    schemas: SchemaMap,
): Expression<SqlBool> {
    if (value === null) {
        return eb(eb.ref(col), "is", null) as Expression<SqlBool>;
    }
    if (isOperatorObject(value)) {
        const ops: Expression<SqlBool>[] = [];
        for (const [opKey, opVal] of Object.entries(value)) {
            ops.push(buildOpCondition(eb, col, opKey, opVal, fieldType, schemas));
        }
        if (ops.length === 1) return ops[0]!;
        return eb.and(ops);
    }
    return eb(eb.ref(col), "=", valueToSqlite(value, fieldType, schemas)) as Expression<SqlBool>;
}

function buildOpCondition(
    eb: AnyEB,
    col: string,
    op: string,
    operand: unknown,
    fieldType: FieldType | undefined,
    schemas: SchemaMap,
): Expression<SqlBool> {
    if (!COMPARISON_OPS.has(op)) {
        throw new SqliteAdapterInvalidQuery(`Unknown filter operator "${op}"`);
    }
    const ref = eb.ref(col);
    switch (op) {
        case "$eq":
            if (operand === null) {
                return eb(ref, "is", null) as Expression<SqlBool>;
            }
            return eb(ref, "=", valueToSqlite(operand, fieldType, schemas)) as Expression<SqlBool>;
        case "$ne":
            if (operand === null) {
                return eb(ref, "is not", null) as Expression<SqlBool>;
            }
            return eb(ref, "<>", valueToSqlite(operand, fieldType, schemas)) as Expression<SqlBool>;
        case "$gt":
            return eb(ref, ">", valueToSqlite(operand, fieldType, schemas)) as Expression<SqlBool>;
        case "$gte":
            return eb(ref, ">=", valueToSqlite(operand, fieldType, schemas)) as Expression<SqlBool>;
        case "$lt":
            return eb(ref, "<", valueToSqlite(operand, fieldType, schemas)) as Expression<SqlBool>;
        case "$lte":
            return eb(ref, "<=", valueToSqlite(operand, fieldType, schemas)) as Expression<SqlBool>;
        case "$in": {
            if (!Array.isArray(operand)) {
                throw new SqliteAdapterInvalidQuery("$in expects an array operand");
            }
            if (operand.length === 0) {
                return eb.val(false) as unknown as Expression<SqlBool>;
            }
            const values = operand.map((v) => valueToSqlite(v, fieldType, schemas));
            return eb(ref, "in", values) as Expression<SqlBool>;
        }
        case "$nin": {
            if (!Array.isArray(operand)) {
                throw new SqliteAdapterInvalidQuery("$nin expects an array operand");
            }
            if (operand.length === 0) {
                return eb.val(true) as unknown as Expression<SqlBool>;
            }
            const values = operand.map((v) => valueToSqlite(v, fieldType, schemas));
            return eb(ref, "not in", values) as Expression<SqlBool>;
        }
        default:
            throw new SqliteAdapterInvalidQuery(`Unhandled operator "${op}"`);
    }
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (value instanceof Date) return false;
    if (value instanceof Uint8Array) return false;
    for (const k of Object.keys(value)) {
        if (!COMPARISON_OPS.has(k)) return false;
    }
    return Object.keys(value).length > 0;
}

export function findFieldType(
    schema: SchemaMetadata,
    name: string,
): FieldType | undefined {
    const field = schema.fields.find((f) => f.name === name);
    return field?.type;
}
