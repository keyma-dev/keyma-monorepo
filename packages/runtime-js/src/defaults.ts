import type { SchemaMetadata } from "./types.js";

/**
 * Apply field defaults to a create payload, filling only keys that are absent (or
 * `undefined`). Literal and named-generator (`now`/`uuid`) defaults are applied;
 * `expression` defaults are not evaluated at runtime. Mutates and returns `data`.
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
        } else if (def.kind === "generator") {
            data[field.name] = def.name === "now" ? new Date() : generateUuid();
        }
        // `expression` defaults are intentionally not evaluated at runtime.
    }
    return data;
}

function generateUuid(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
        const r = Math.floor(Math.random() * 16);
        const v = ch === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
