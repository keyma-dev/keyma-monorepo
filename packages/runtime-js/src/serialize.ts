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
    if (
        type.kind === "embedded" &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date)
    ) {
        // Guard arrays/Dates (which are also `typeof === "object"`) so a type-violating
        // value on an embedded field passes through verbatim rather than being iterated
        // into `{}` — matching deserialize's embedded guard and the Python backend.
        const subClass = refs?.get(type.schema);
        if (subClass !== undefined) {
            return serialize(subClass.schema, value as Record<string, unknown>, opts);
        }
        return value;
    }
    if (type.kind === "array" && Array.isArray(value)) {
        return value.map((el) => serializeValue(el, type.of, refs, opts));
    }
    return value;
}
