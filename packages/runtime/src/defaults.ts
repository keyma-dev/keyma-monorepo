import type { SchemaMetadata } from "./types.js";
import { allSchemaFields } from "./schema-fields.js";

export type { SchemaDefaultsFn } from "./types.js";

/**
 * Apply field defaults to a create payload, filling only keys that are absent (or `undefined`).
 * Literal defaults are read from the schema metadata. Expression defaults (`= (() => new Date())()`,
 * `= myFn()`) are applied by the schema's own `applyDefaults` initializer — re-emitted runnable
 * code attached directly to the frozen metadata, which evaluates each expression per record and
 * guards its own absent check. Mutates and returns `data`.
 */
export function applyDefaults(
    schema: SchemaMetadata,
    data: Record<string, unknown>,
): Record<string, unknown> {
    // Literal defaults: `allSchemaFields` already covers own + inherited fields.
    for (const field of allSchemaFields(schema)) {
        const def = field.default;
        if (def === undefined) continue;
        if (field.name in data && data[field.name] !== undefined) continue;

        if (def.kind === "literal") {
            data[field.name] = Array.isArray(def.value) ? [...def.value] : def.value;
        }
        // `expression` defaults are applied by each schema's own applyDefaults below.
    }
    // Expression defaults ride in each schema's own `applyDefaults` initializer (own fields only,
    // real inheritance). Walk the base chain parent-first so an ancestor's expression defaults run
    // before the leaf's, mirroring the C++ runtime's recursive apply_defaults.
    const chain: SchemaMetadata[] = [];
    const seen = new Set<string>();
    for (let s: SchemaMetadata | undefined = schema; s !== undefined && !seen.has(s.name); s = s.base) {
        seen.add(s.name);
        chain.push(s);
    }
    for (let i = chain.length - 1; i >= 0; i--) chain[i]!.applyDefaults?.(data);
    return data;
}
