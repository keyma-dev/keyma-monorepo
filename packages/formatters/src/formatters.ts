import { Formatter } from "@keyma/dsl";

// Built-in formatters. Each is a `Formatter(name, factory)` whose factory returns
// the implementation `(value) => …`. The Keyma compiler reads these factories,
// lowers their bodies to IR, and emits a formatter registry consumed at runtime.
// Bodies use the portable expression subset (string methods, regex literals,
// conditionals, arrow callbacks) so they re-emit in any target language.
//
// Each `value` is typed `string` (the type these formatters operate on); the
// compiler emits a runtime guard from that type, so a non-string raises rather than
// being passed through silently.

// ─── String normalisation ─────────────────────────────────────────────────────

export const trim = Formatter("trim", () =>
    (value: string) => value.trim(),
);

export const lowercase = Formatter("lowercase", () =>
    (value: string) => value.toLowerCase(),
);

export const uppercase = Formatter("uppercase", () =>
    (value: string) => value.toUpperCase(),
);

export const capitalize = Formatter("capitalize", () =>
    (value: string) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase(),
);

export const titleCase = Formatter("titleCase", () =>
    (value: string) => value.toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()),
);

export const normalizeWhitespace = Formatter("normalizeWhitespace", () =>
    (value: string) => value.trim().replace(/\s+/g, " "),
);

export const stripNonDigits = Formatter("stripNonDigits", () =>
    (value: string) => value.replace(/\D+/g, ""),
);

// ─── Contact normalisation ──────────────────────────────────────────────────────

export const normalizeEmail = Formatter("normalizeEmail", () =>
    (value: string) => value.trim().toLowerCase(),
);

export const normalizeUrl = Formatter("normalizeUrl", () =>
    (value: string) => value.trim().replace(/\/+$/, ""),
);

export const normalizePhone = Formatter("normalizePhone", () =>
    (value: string) => "+" + value.replace(/\D+/g, ""),
);

// ─── Slugs & truncation ──────────────────────────────────────────────────────

export const slugify = Formatter("slugify", () =>
    (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, ""),
);

export const truncate = Formatter("truncate", (maxLength: number) =>
    (value: string) => (value.length > maxLength ? value.slice(0, maxLength) : value),
);
