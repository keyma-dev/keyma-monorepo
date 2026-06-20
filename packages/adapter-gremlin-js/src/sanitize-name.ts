const NON_WORD = /[^A-Za-z0-9_]/g;

/**
 * Default schema-`name` → Gremlin vertex/edge label formatter.
 *
 * Deterministic and valid: graph labels travel as plain tokens, so any character
 * outside `[A-Za-z0-9_]` (whitespace and punctuation, including a `schemaPrefix`'s
 * separators) collapses to `_`. Case is preserved. Override with
 * `GremlinAdapterOptions.label` / `edgeLabel` for a different convention.
 */
export function sanitizeLabel(name: string): string {
    const out = name.replace(NON_WORD, "_");
    if (out.length === 0) {
        throw new Error(`Cannot derive a Gremlin label from "${name}"`);
    }
    return out;
}
