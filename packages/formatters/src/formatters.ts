import type { FormatterFn } from "@keyma/dsl";

// Built-in formatters. Each is a plain factory function returning a `FormatterFn`
// — `(value) => value`. The Keyma compiler resolves each from its `@Format(...)`
// call site, reads the factory params and the returned function's body, lowers them
// to IR, and re-emits the implementation directly into the generated schema. Bodies
// use the portable expression subset (string methods, regex literals, conditionals,
// arrow callbacks) so they re-emit in any target language.
//
// Each `value` is typed `string` via `FormatterFn<string>`; the compiler emits a
// runtime guard from that type, so a non-string raises rather than being passed
// through silently.

// ─── String normalisation ─────────────────────────────────────────────────────

export function trim(): FormatterFn<string> {
    return (value) => value.trim();
}

export function lowercase(): FormatterFn<string> {
    return (value) => value.toLowerCase();
}

export function uppercase(): FormatterFn<string> {
    return (value) => value.toUpperCase();
}

export function capitalize(): FormatterFn<string> {
    return (value) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function titleCase(): FormatterFn<string> {
    return (value) => value.toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());
}

export function normalizeWhitespace(): FormatterFn<string> {
    return (value) => value.trim().replace(/\s+/g, " ");
}

export function stripNonDigits(): FormatterFn<string> {
    return (value) => value.replace(/\D+/g, "");
}

// ─── Contact normalisation ──────────────────────────────────────────────────────

export function normalizeEmail(): FormatterFn<string> {
    return (value) => value.trim().toLowerCase();
}

export function normalizeUrl(): FormatterFn<string> {
    return (value) => value.trim().replace(/\/+$/, "");
}

export function normalizePhone(): FormatterFn<string> {
    return (value) => "+" + value.replace(/\D+/g, "");
}

// ─── Slugs & truncation ──────────────────────────────────────────────────────

export function slugify(): FormatterFn<string> {
    return (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

export function truncate(maxLength: number): FormatterFn<string> {
    return (value) => (value.length > maxLength ? value.slice(0, maxLength) : value);
}
