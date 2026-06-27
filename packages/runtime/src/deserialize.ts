// JSON wire decoder — the inverse of `serialize`. Reverses the canonical conversions (epoch-ms
// int → Date, base64 string → bytes) and hydrates embedded/instance/reference values into
// generated class instances via the static `fromValue` factory. Target-free, like `serialize`.

import type { ClassMeta, FieldType } from "./fields.js";
import type { Refs } from "./serialize.js";
import { base64ToBytes } from "./base64.js";
import { allFields, allRefs, targetOf } from "./fields.js";

export function deserialize(
    meta: ClassMeta,
    value: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const refs = allRefs(meta); // own + inherited targets (real inheritance)
    for (const field of allFields(meta)) {
        if (field.name in value) {
            out[field.name] = deserializeValue(value[field.name], field.type, refs);
        }
    }
    return out;
}

/** Deserialize a single typed value from its JSON wire form. Exported for the RPC marshaller. */
export function deserializeValue(value: unknown, type: FieldType, refs: Refs): unknown {
    if (type.kind === "dateTime" && typeof value === "number") {
        return new Date(value);
    }
    if (type.kind === "bytes" && typeof value === "string") {
        return base64ToBytes(value);
    }

    if (type.kind === "embedded" || type.kind === "instance") {
        if (value === null || value === undefined) return value;
        if (typeof value !== "object" || Array.isArray(value)) return value;
        const sub = refs?.get(targetOf(type)!);
        if (sub !== undefined) {
            return sub.fromValue(deserialize(sub.metadata, value as Record<string, unknown>));
        }
        return value;
    }

    if (type.kind === "reference") {
        if (value === null || value === undefined) return undefined;
        const sub = refs?.get(type.target);
        if (sub === undefined) return value;
        if (typeof value === "string" || typeof value === "number") {
            // Bare id — hydrate a stub instance carrying only `id`.
            return sub.fromValue({ id: value });
        }
        if (typeof value === "object" && !Array.isArray(value)) {
            // Server-populated (dereferenced) — recursively deserialize then hydrate.
            return sub.fromValue(deserialize(sub.metadata, value as Record<string, unknown>));
        }
        return value;
    }

    if (type.kind === "array" && Array.isArray(value)) {
        return value.map((el) => deserializeValue(el, type.of, refs));
    }

    return value;
}
