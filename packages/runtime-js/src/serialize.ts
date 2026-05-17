import type { SchemaMetadata, FieldType, SchemaClass } from "./types.js";

export type SerializeTarget = "client" | "server" | "database";

export function serialize(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
    opts: { target: SerializeTarget }
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of schema.fields) {
        if (opts.target === "client" && field.visibility === "private") continue;
        if (opts.target === "database" && field.ephemeral) continue;
        if (field.name in value) {
            out[field.name] = serializeValue(value[field.name], field.type, schema.refs, opts);
        }
    }
    return out;
}

function serializeValue(
    value: unknown,
    type: FieldType,
    refs: ReadonlyMap<string, SchemaClass> | undefined,
    opts: { target: SerializeTarget },
): unknown {
    if (type.kind === "dateTime" && value instanceof Date) {
        return value.toISOString();
    }
    if (type.kind === "embedded" && value !== null && typeof value === "object") {
        const subClass = refs?.get(type.schema);
        if (subClass !== undefined) {
            return serialize(subClass.schema, value as Record<string, unknown>, opts);
        }
        return value;
    }
    if (type.kind === "nullable") {
        if (value === null || value === undefined) return value;
        return serializeValue(value, type.of, refs, opts);
    }
    if (type.kind === "array" && Array.isArray(value)) {
        return value.map((el) => serializeValue(el, type.of, refs, opts));
    }
    return value;
}
