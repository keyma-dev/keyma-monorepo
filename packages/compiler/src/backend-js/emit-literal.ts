import { isRaw, mkRaw, type Raw } from "@keyma/core/util";

// Re-export the raw-fragment marker; the module emitters and domain packs import `raw`/`Raw`
// from this module as the backend's literal-emission surface.
export { mkRaw, type Raw };

/**
 * Render a JS object/array literal with support for {@link Raw} fragments, which are
 * emitted as code rather than JSON. Plain values use JSON encoding. Indentation
 * mirrors `JSON.stringify(_, null, 4)` so the output reads naturally.
 */
export function emitLiteral(value: unknown, indent = 0): string {
    const pad = "    ".repeat(indent);
    const padInner = "    ".repeat(indent + 1);

    if (isRaw(value)) return value.__raw;

    if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        const items = value.map((v) => padInner + emitLiteral(v, indent + 1));
        return `[\n${items.join(",\n")}\n${pad}]`;
    }

    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return "{}";
        const lines = entries.map(([k, v]) => `${padInner}${JSON.stringify(k)}: ${emitLiteral(v, indent + 1)}`);
        return `{\n${lines.join(",\n")}\n${pad}}`;
    }

    return JSON.stringify(value);
}
