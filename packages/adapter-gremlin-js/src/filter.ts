import type { FieldType, SchemaMetadata } from "@keyma/runtime-js";
import { P, __, order as gorder, t } from "./gremlin.js";
import type { GraphTraversal } from "./gremlin.js";
import { findFieldType, valueToGremlin } from "./props.js";
import { GremlinAdapterInvalidQuery } from "./errors.js";

const QUERY_OPS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"]);
const LOGICAL_OPS = new Set(["$and", "$or", "$nor"]);

function isOperatorObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return entries.length > 0 && entries.every(([k]) => QUERY_OPS.has(k));
}

/** Build the Gremlin predicate(s) for a single field value (literal or operator
 *  object). Returns one or more predicates that must all hold (AND). */
function predicatesFor(value: unknown, type: FieldType | undefined): unknown[] {
    if (isOperatorObject(value)) {
        const out: unknown[] = [];
        for (const [op, raw] of Object.entries(value)) {
            switch (op) {
                case "$eq":
                    out.push(P.eq(valueToGremlin(raw, type)));
                    break;
                case "$ne":
                    out.push(P.neq(valueToGremlin(raw, type)));
                    break;
                case "$gt":
                    out.push(P.gt(valueToGremlin(raw, type)));
                    break;
                case "$gte":
                    out.push(P.gte(valueToGremlin(raw, type)));
                    break;
                case "$lt":
                    out.push(P.lt(valueToGremlin(raw, type)));
                    break;
                case "$lte":
                    out.push(P.lte(valueToGremlin(raw, type)));
                    break;
                case "$in":
                    out.push(P.within(...asArray(raw).map((v) => valueToGremlin(v, type))));
                    break;
                case "$nin":
                    out.push(P.without(...asArray(raw).map((v) => valueToGremlin(v, type))));
                    break;
            }
        }
        return out;
    }
    return [P.eq(valueToGremlin(value, type))];
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [value];
}

/** Apply a Keyma `where` clause as filter steps onto an existing traversal
 *  (vertex or edge). The traversal is returned for chaining. `id` filters
 *  compile to `hasId(...)`; logical `$and`/`$or`/`$nor` use anonymous
 *  sub-traversals. Mirrors the operator surface of the MongoDB adapter. */
export function applyWhere(
    trav: GraphTraversal,
    where: Record<string, unknown> | undefined,
    schema: SchemaMetadata,
    schemas: ReadonlyMap<string, SchemaMetadata>,
): GraphTraversal {
    if (where === undefined) return trav;
    let t2 = trav;
    for (const [key, value] of Object.entries(where)) {
        if (LOGICAL_OPS.has(key)) {
            t2 = applyLogical(t2, key, value, schema, schemas);
            continue;
        }
        const type = findFieldType(schema, key);
        for (const pred of predicatesFor(value, type)) {
            t2 = key === "id" ? t2.hasId(pred) : t2.has(key, pred);
        }
    }
    return t2;
}

function applyLogical(
    trav: GraphTraversal,
    op: string,
    value: unknown,
    schema: SchemaMetadata,
    schemas: ReadonlyMap<string, SchemaMetadata>,
): GraphTraversal {
    if (!Array.isArray(value)) {
        throw new GremlinAdapterInvalidQuery(`${op} expects an array of sub-filters`);
    }
    const subs = value.map((sub) => {
        if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
            throw new GremlinAdapterInvalidQuery(`${op} sub-filter must be an object`);
        }
        return applyWhere(__.identity(), sub as Record<string, unknown>, schema, schemas);
    });
    if (op === "$and") {
        return trav.and(...subs);
    }
    if (op === "$or") {
        return trav.or(...subs);
    }
    // $nor — none of the sub-filters may match.
    return trav.not(__.or(...subs));
}

export type SortEntry = { key: string; desc: boolean };

/** Translate a Keyma `sort` map into ordered `(key, direction)` entries. `id`
 *  is mapped to the `T.id` token. */
export function translateSort(sort: Record<string, 1 | -1> | undefined): SortEntry[] {
    if (sort === undefined) return [];
    return Object.entries(sort).map(([key, dir]) => ({ key, desc: dir === -1 }));
}

/** Apply ordered sort entries onto a traversal as `order().by(...)`. */
export function applyOrder(trav: GraphTraversal, entries: SortEntry[]): GraphTraversal {
    if (entries.length === 0) return trav;
    let t2 = trav.order();
    for (const e of entries) {
        const dir = e.desc ? gorder.desc : gorder.asc;
        t2 = e.key === "id" ? t2.by(t.id, dir) : t2.by(e.key, dir);
    }
    return t2;
}
