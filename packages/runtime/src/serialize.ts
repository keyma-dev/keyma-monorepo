// JSON wire codec — `serialize` walks a record's fields and applies the canonical cross-runtime
// conversions (dateTime → epoch-ms int, bytes → base64 string, embedded/instance → inline
// recurse). Target-free and visibility-blind: there is no `SerializeTarget` and no private/
// ephemeral filtering — private-field exclusion is purely the compile-time client/server bundle
// split (client classes don't declare private fields), and `@Ephemeral` is a serialization
// no-op. Shared by the binary codec's parity and reused per-value by the RPC marshaller.

import type { ClassMeta, FieldType, ClassRef } from "./fields.js";
import { bytesToBase64 } from "./base64.js";
import { allFields, allRefs, targetOf } from "./fields.js";

export function serialize(
    meta: ClassMeta,
    value: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const refs = allRefs(meta); // own + inherited targets (real inheritance)
    for (const field of allFields(meta)) {
        if (field.name in value) {
            out[field.name] = serializeValue(value[field.name], field.type, refs);
        }
    }
    return out;
}

export type Refs = ReadonlyMap<string, ClassRef> | undefined;

/** Serialize a single typed value to its JSON wire form. Exported for the RPC marshaller, which
 *  encodes positional call args/returns of arbitrary value types (including `instance`). */
export function serializeValue(value: unknown, type: FieldType, refs: Refs): unknown {
    if (type.kind === "dateTime" && value instanceof Date) {
        // epoch-ms int — the canonical cross-runtime wire format (shared with Python/C++).
        return value.getTime();
    }
    if (type.kind === "bytes" && value instanceof Uint8Array) {
        // base64 string — the canonical cross-runtime wire format for `bytes`.
        return bytesToBase64(value);
    }
    if (
        (type.kind === "embedded" || type.kind === "instance") &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date)
    ) {
        // Guard arrays/Dates (also `typeof === "object"`) so a type-violating value passes through
        // verbatim rather than being iterated into `{}` — matching deserialize's guard.
        const sub = refs?.get(targetOf(type)!);
        if (sub !== undefined) {
            return serialize(sub.metadata, value as Record<string, unknown>);
        }
        return value;
    }
    if (type.kind === "array" && Array.isArray(value)) {
        return value.map((el) => serializeValue(el, type.of, refs));
    }
    return value;
}
