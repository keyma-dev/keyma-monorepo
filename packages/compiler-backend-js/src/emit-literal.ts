/**
 * A marker wrapping a raw JS code fragment to be emitted verbatim (not JSON-encoded)
 * inside an object/array literal — e.g. a validator factory call `minLength(2)`, a
 * `new Map([...])`, or an `applyDefaults` arrow. Produced by the schema-data builder
 * and rendered by {@link emitLiteral}.
 */
export type Raw = { readonly __raw: string };

export function raw(code: string): Raw {
    return { __raw: code };
}

function isRaw(v: unknown): v is Raw {
    return typeof v === "object" && v !== null && "__raw" in v && typeof (v as Raw).__raw === "string";
}

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
