/**
 * Opaque marker type passed to @Format(). The compiler reads these from the AST;
 * the runtime value is irrelevant since @Format is a no-op decorator.
 */
export type FormatterMarker = { readonly __formatterKind: string };

function marker(kind: string, extra?: Record<string, unknown>): FormatterMarker {
    return { __formatterKind: kind, ...extra } as FormatterMarker;
}

// --- Case and whitespace ---

/** Remove leading and trailing whitespace. */
export const trim: FormatterMarker = marker("trim");

/** Normalize runs of whitespace to a single space and trim. */
export const normalizeWhitespace: FormatterMarker = marker("normalizeWhitespace");

/** Convert to lowercase. */
export const lowercase: FormatterMarker = marker("lowercase");

/** Convert to uppercase. */
export const uppercase: FormatterMarker = marker("uppercase");

/** Convert to Title Case. */
export const titleCase: FormatterMarker = marker("titleCase");

/** Capitalize the first letter. */
export const capitalize: FormatterMarker = marker("capitalize");

// --- Domain-specific normalization ---

/** Remove all non-digit characters. */
export const stripNonDigits: FormatterMarker = marker("stripNonDigits");

/** Normalize an email address: lowercase + trim. */
export const normalizeEmail: FormatterMarker = marker("normalizeEmail");

/** Canonicalize a phone number to E.164 format. */
export function normalizePhone(options?: { region?: string }): FormatterMarker {
    return marker("normalizePhone", options?.region ? { region: options.region } : {});
}

/** Normalize a URL: lowercase host, strip default port, etc. */
export const normalizeUrl: FormatterMarker = marker("normalizeUrl");

/** Convert to a URL-safe slug. */
export const slugify: FormatterMarker = marker("slugify");

/** Truncate to at most maxLength characters. */
export function truncate(maxLength: number): FormatterMarker {
    return marker("truncate", { maxLength });
}

// --- Escape hatch ---

/** Custom named formatter (must be registered in keyma.config.ts). */
export function customFormatter(name: string): FormatterMarker {
    return marker("custom", { name });
}
