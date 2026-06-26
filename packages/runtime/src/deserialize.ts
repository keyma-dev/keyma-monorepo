import type { SchemaMetadata, FieldType, SchemaClass } from "./types.js";
import { base64ToBytes } from "./base64.js";
import { allFields, allRefs } from "./fields.js";

export function deserialize(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const refs = allRefs(schema); // own + inherited targets (real inheritance)
    for (const field of allFields(schema)) {
        if (field.name in value) {
            out[field.name] = deserializeValue(value[field.name], field.type, refs);
        }
    }
    return out;
}

function deserializeValue(
    value: unknown,
    type: FieldType,
    refs: ReadonlyMap<string, SchemaClass> | undefined,
): unknown {
    if (type.kind === "dateTime" && typeof value === "number") {
        // epoch-ms int64 on the wire → Date.
        return new Date(value);
    }
    if (type.kind === "bytes" && typeof value === "string") {
        // base64 string on the wire → Uint8Array.
        return base64ToBytes(value);
    }

    if (type.kind === "embedded") {
        if (value === null || value === undefined) return value;
        if (typeof value !== "object" || Array.isArray(value)) return value;
        const subClass = refs?.get(type.schema);
        if (subClass !== undefined) {
            const sub = deserialize(subClass.schema, value as Record<string, unknown>);
            return new (subClass as new (v?: unknown) => unknown)(sub);
        }
        return value;
    }

    if (type.kind === "reference") {
        if (value === null || value === undefined) return undefined;
        const subClass = refs?.get(type.schema);
        if (subClass === undefined) return value;
        if (typeof value === "string") {
            // Bare ID — construct a stub instance with only id set
            return new (subClass as new (v?: unknown) => unknown)({ id: value });
        }
        if (typeof value === "object" && !Array.isArray(value)) {
            // Server-populated (dereferenced) — recursively deserialize then construct
            const sub = deserialize(subClass.schema, value as Record<string, unknown>);
            return new (subClass as new (v?: unknown) => unknown)(sub);
        }
        return value;
    }

    if (type.kind === "array" && Array.isArray(value)) {
        return value.map((el) => deserializeValue(el, type.of, refs));
    }

    return value;
}
