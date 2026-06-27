import { isRaw, mkRaw, type Raw } from "@keyma/core/util";

// Re-export the raw-fragment marker; a domain's class-data builder imports `raw` from this
// module as the backend's literal-emission surface.
export { mkRaw, type Raw };

/**
 * Render a Python dict/list literal with support for {@link Raw} fragments (emitted
 * as code, e.g. a `min_length(2)` factory call or a `lambda`). Booleans/None use
 * Python spelling. Indentation uses 4 spaces per level.
 */
export function emitLiteral(value: unknown, indent = 0): string {
    const pad = "    ".repeat(indent);
    const padInner = "    ".repeat(indent + 1);

    if (isRaw(value)) return value.__raw;
    if (value === null || value === undefined) return "None";
    if (value === true) return "True";
    if (value === false) return "False";

    if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        const items = value.map((v) => padInner + emitLiteral(v, indent + 1));
        return `[\n${items.join(",\n")}\n${pad}]`;
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return "{}";
        const lines = entries.map(([k, v]) => `${padInner}${JSON.stringify(k)}: ${emitLiteral(v, indent + 1)}`);
        return `{\n${lines.join(",\n")}\n${pad}}`;
    }

    return JSON.stringify(value);
}
