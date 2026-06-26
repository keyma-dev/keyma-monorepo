import type { SchemaMetadata } from "./types.js";

export type { SchemaDefaultsFn } from "./types.js";

/**
 * Apply field defaults to a create payload, filling only keys that are absent (or
 * `undefined`). Literal defaults are read from the schema metadata. Expression
 * defaults (`= (() => new Date())()`, `= myFn()`) are applied by the schema's own
 * `applyDefaults` initializer — re-emitted runnable code attached directly to the
 * frozen metadata, which evaluates each expression per record and guards its own
 * absent check. Mutates and returns `data`.
 */
export function applyDefaults(
    schema: SchemaMetadata,
    data: Record<string, unknown>,
): Record<string, unknown> {
    for (const field of schema.fields) {
        const def = field.default;
        if (def === undefined) continue;
        if (field.name in data && data[field.name] !== undefined) continue;

        if (def.kind === "literal") {
            data[field.name] = Array.isArray(def.value) ? [...def.value] : def.value;
        }
        // `expression` defaults are applied by the schema's applyDefaults below.
    }
    schema.applyDefaults?.(data);
    return data;
}
