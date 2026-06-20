const NON_WORD = /[^A-Za-z0-9_]/g;
const LEADING_DIGIT = /^[0-9]/;

/**
 * Default schema-`name` → SQLite table-name formatter.
 *
 * Deterministic and valid: coerces the authored name (including any configured
 * `schemaPrefix`) to a plain SQL identifier `[A-Za-z_][A-Za-z0-9_]*` — non-word
 * characters collapse to `_`, and a leading digit is prefixed with `_`. Case is
 * preserved. Override with `SqliteAdapterOptions.tableName` for a different
 * convention.
 */
export function sanitizeTableName(name: string): string {
    let out = name.replace(NON_WORD, "_");
    if (out.length === 0) {
        throw new Error(`Cannot derive a SQLite table name from "${name}"`);
    }
    if (LEADING_DIGIT.test(out)) out = `_${out}`;
    return out;
}
