import { Formatter } from "@keyma/dsl";

// Built-in formatters. Each is a `Formatter(name, factory)` whose factory returns
// the implementation `(value) => ...`. The Keyma compiler reads these factories,
// lowers their bodies to IR, and emits a formatter registry consumed at runtime.
// Bodies are restricted to the portable expression subset (string methods, regex
// literals, conditionals, arrow callbacks) so they re-emit in any target language.
// Non-string values pass through unchanged.

// ─── String normalisation ─────────────────────────────────────────────────────

export const trim = Formatter("trim", () =>
    (value: unknown) => (typeof value === "string" ? value.trim() : value),
);

export const lowercase = Formatter("lowercase", () =>
    (value: unknown) => (typeof value === "string" ? value.toLowerCase() : value),
);

export const uppercase = Formatter("uppercase", () =>
    (value: unknown) => (typeof value === "string" ? value.toUpperCase() : value),
);

export const capitalize = Formatter("capitalize", () =>
    (value: unknown) => (typeof value === "string" ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value),
);

export const titleCase = Formatter("titleCase", () =>
    (value: unknown) => (typeof value === "string" ? value.toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()) : value),
);

export const normalizeWhitespace = Formatter("normalizeWhitespace", () =>
    (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value),
);

export const stripNonDigits = Formatter("stripNonDigits", () =>
    (value: unknown) => (typeof value === "string" ? value.replace(/\D+/g, "") : value),
);

// ─── Contact normalisation ──────────────────────────────────────────────────────

export const normalizeEmail = Formatter("normalizeEmail", () =>
    (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : value),
);

export const normalizeUrl = Formatter("normalizeUrl", () =>
    (value: unknown) => (typeof value === "string" ? value.trim().replace(/\/+$/, "") : value),
);

export const normalizePhone = Formatter("normalizePhone", () =>
    (value: unknown) => (typeof value === "string" ? "+" + value.replace(/\D+/g, "") : value),
);

// ─── Slugs & truncation ──────────────────────────────────────────────────────

export const slugify = Formatter("slugify", () =>
    (value: unknown) => (typeof value === "string"
        ? value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "")
        : value),
);

export const truncate = Formatter("truncate", (maxLength: number) =>
    (value: unknown) => (typeof value === "string" && value.length > maxLength ? value.slice(0, maxLength) : value),
);
