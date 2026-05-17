import type { SchemaMetadata, FieldType, SchemaClass } from "./types.js";

export function deserialize(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        if (field.name in value) {
            out[field.name] = deserializeValue(value[field.name], field.type, schema.refs);
        }
    }
    return out;
}

function deserializeValue(
    value: unknown,
    type: FieldType,
    refs: ReadonlyMap<string, SchemaClass> | undefined,
): unknown {
    if (type.kind === "dateTime" && typeof value === "string") {
        return new Date(value);
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

    if (type.kind === "nullable") {
        if (value === null || value === undefined) return value;
        return deserializeValue(value, type.of, refs);
    }

    if (type.kind === "array" && Array.isArray(value)) {
        return value.map((el) => deserializeValue(el, type.of, refs));
    }

    return value;
}
