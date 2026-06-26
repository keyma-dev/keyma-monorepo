// Reference value normalization.
//
// A `Reference<T>` field is stored as the referenced document's BARE id. Callers
// may supply a reference value in three forms: an id string, an `{ id }` object,
// or a full model instance. Before such a value is persisted (or sent on the
// wire) it is collapsed to the bare id so the "references are stored as ids"
// invariant holds regardless of input form. `deserialize` already accepts both
// the bare id and a populated object on the read path, so only the write (`data`)
// and filter (`where`) paths need this.

import type { FieldType, SchemaMetadata } from "./types.js";
import { allFields } from "./fields.js";

const SCALAR_OPS = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"] as const;
const ARRAY_OPS = ["$in", "$nin"] as const;

/** Collapse a single reference value to its bare id.
 *  - `null` / `undefined` pass through (absence is meaningful — e.g. clearing a ref),
 *  - a bare id (string / non-object primitive) passes through,
 *  - an `{ id }` object or a full model instance becomes `value.id`
 *    (even if `value.id` is undefined — surfacing bad input instead of silently
 *    persisting the wrapper object),
 *  - an array is left untouched here (array-aware callers map over it). */
export function normalizeReferenceValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    if (Array.isArray(value)) return value;
    if ("id" in (value as Record<string, unknown>)) {
        return (value as { id: unknown }).id;
    }
    return value;
}

/** A MongoDB-style operator object (`{ $in: [...] }`, `{ $eq: x }`, …). Detected
 *  by any `$`-prefixed key, so a pathological `{ id, $op }` is treated as an
 *  operator object (operands normalized) rather than collapsed by `id`. */
function isQueryOperatorObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).some((k) => k.startsWith("$"))
    );
}

/** Normalize the value of a single reference field. Handles operator objects
 *  (normalize each operand), arrays (element-wise), and scalar references. */
export function normalizeReferenceFieldValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (isQueryOperatorObject(value)) {
        const out: Record<string, unknown> = { ...value };
        for (const op of SCALAR_OPS) {
            if (op in out) out[op] = normalizeReferenceValue(out[op]);
        }
        for (const op of ARRAY_OPS) {
            const arr = out[op];
            if (Array.isArray(arr)) out[op] = arr.map(normalizeReferenceValue);
        }
        return out;
    }
    if (Array.isArray(value)) return value.map(normalizeReferenceValue);
    return normalizeReferenceValue(value);
}

/** Unwrap an `array` field type to its element type. */
export function coreFieldType(type: FieldType): FieldType {
    return type.kind === "array" ? coreFieldType(type.of) : type;
}

/** Collapse every reference-typed field in a `where`/`data` record to bare id(s).
 *  Non-reference fields (including embedded objects) are passed through untouched.
 *  Returns a new object; does not mutate `record`. Must run AFTER `Input<>`
 *  substitution, since the value behind a placeholder is only known at request
 *  time and may itself be an `{ id }` object or a full instance. */
export function normalizeReferenceIds(
    record: Record<string, unknown>,
    schema: SchemaMetadata,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...record };
    for (const field of allFields(schema)) {
        if (!(field.name in out)) continue;
        if (coreFieldType(field.type).kind !== "reference") continue;
        out[field.name] = normalizeReferenceFieldValue(out[field.name]);
    }
    return out;
}
