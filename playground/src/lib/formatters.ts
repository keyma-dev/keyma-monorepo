import type { FormatterFn } from "@keyma/dsl";

/**
 * Ensure a path-like string has exactly one leading slash. Uses only
 * required-tier string intrinsics (`startsWith`) + concatenation so it lowers
 * to both the JS and Python backends.
 */
export function ensureLeadingSlash(): FormatterFn<string> {
    return (value) => (value.startsWith("/") ? value : "/" + value);
}
