import type { FieldType, SchemaMetadata } from "@keyma/runtime-js";
import { valueToBson, type SchemaMap } from "./record.js";

const QUERY_OPS = new Set([
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

function findFieldType(schema: SchemaMetadata, name: string): FieldType | undefined {
    return schema.fields.find((f) => f.name === name)?.type;
}

function translateValue(value: unknown, type: FieldType | undefined, schemas: SchemaMap): unknown {
    if (type === undefined) return value;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length > 0 && entries.every(([k]) => QUERY_OPS.has(k))) {
            const out: Record<string, unknown> = {};
            for (const [op, inner] of entries) {
                if (op === "$in" || op === "$nin") {
                    out[op] = Array.isArray(inner)
                        ? inner.map((v) => valueToBson(v, type, schemas))
                        : inner;
                } else {
                    out[op] = valueToBson(inner, type, schemas);
                }
            }
            return out;
        }
    }
    return valueToBson(value, type, schemas);
}

/** Translate a Keyma `where` clause into a MongoDB filter. Renames `id` → `_id`
 *  and converts literal values into their BSON representation per schema field
 *  type (BigInt → Binary, Decimal → Decimal128, etc). Passes MongoDB-style
 *  comparison operators ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin) through.
 *
 *  Top-level logical operators `$and` / `$or` / `$nor` are also accepted; each
 *  carries an array of sub-filter objects that are recursively translated
 *  against the same schema. These typically come from server plugins (e.g.
 *  `@keyma/plugin-acl-js`) merging the client's filter with policy clauses. */
export function translateWhere(
    where: Record<string, unknown>,
    schema: SchemaMetadata,
    schemas: SchemaMap,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(where)) {
        if (LOGICAL_OPS.has(key)) {
            if (!Array.isArray(value)) {
                throw new Error(`${key} expects an array of sub-filters`);
            }
            out[key] = value.map((sub) => {
                if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
                    throw new Error(`${key} sub-filter must be an object`);
                }
                return translateWhere(sub as Record<string, unknown>, schema, schemas);
            });
            continue;
        }
        const dbKey = key === "id" ? "_id" : key;
        const type = findFieldType(schema, key);
        out[dbKey] = translateValue(value, type, schemas);
    }
    return out;
}

/** Translate a Keyma `sort` map (`{ field: 1 | -1 }`) into a MongoDB sort spec,
 *  renaming `id` → `_id`. */
export function translateSort(sort: Record<string, 1 | -1>): Record<string, 1 | -1> {
    const out: Record<string, 1 | -1> = {};
    for (const [key, dir] of Object.entries(sort)) {
        out[key === "id" ? "_id" : key] = dir;
    }
    return out;
}
