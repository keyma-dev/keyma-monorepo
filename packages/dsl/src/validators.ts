/**
 * Opaque marker type passed to @Validate(). The compiler reads these from the AST;
 * the runtime value is irrelevant since @Validate is a no-op decorator.
 */
export type ValidatorMarker = { readonly __validatorKind: string };

function marker(kind: string, extra?: Record<string, unknown>): ValidatorMarker {
    return { __validatorKind: kind, ...extra } as ValidatorMarker;
}

// --- Presence ---

/** Field must be present and non-empty. */
export const isRequired: ValidatorMarker = marker("required");

// --- String size ---

/** Minimum string length. */
export function minLength(value: number): ValidatorMarker { return marker("minLength", { value }); }

/** Maximum string length. */
export function maxLength(value: number): ValidatorMarker { return marker("maxLength", { value }); }

/** Exact string length. */
export function length(value: number): ValidatorMarker { return marker("length", { value }); }

// --- Numeric bounds ---

/** Minimum numeric value (inclusive). */
export function min(value: number): ValidatorMarker { return marker("min", { value }); }

/** Maximum numeric value (inclusive). */
export function max(value: number): ValidatorMarker { return marker("max", { value }); }

/** Value must be a multiple of n. */
export function multipleOf(value: number): ValidatorMarker { return marker("multipleOf", { value }); }

/** Value must be strictly greater than zero. */
export const isPositive: ValidatorMarker = marker("positive");

/** Value must be greater than or equal to zero. */
export const isNonNegative: ValidatorMarker = marker("nonNegative");

/** Value must be strictly less than zero. */
export const isNegative: ValidatorMarker = marker("negative");

/** Value must be less than or equal to zero. */
export const isNonPositive: ValidatorMarker = marker("nonPositive");

/** Value must be a whole number. Promotes `number` fields to IR `integer` kind. */
export const isInteger: ValidatorMarker = marker("integer");

// --- Temporal bounds (ISO 8601 strings) ---

/** Field value must be on or after this date. */
export function minDate(value: string): ValidatorMarker { return marker("minDate", { value }); }

/** Field value must be on or before this date. */
export function maxDate(value: string): ValidatorMarker { return marker("maxDate", { value }); }

// --- Array bounds ---

/** Array must have at least n items. */
export function minItems(value: number): ValidatorMarker { return marker("minItems", { value }); }

/** Array must have at most n items. */
export function maxItems(value: number): ValidatorMarker { return marker("maxItems", { value }); }

/** Array items must be unique. */
export const uniqueItems: ValidatorMarker = marker("uniqueItems");

// --- String content ---

/** Value must match the given regular expression. */
export function pattern(re: RegExp | string): ValidatorMarker {
    const src = re instanceof RegExp ? re.source : re;
    const flags = re instanceof RegExp ? re.flags : undefined;
    return marker("pattern", flags ? { pattern: src, flags } : { pattern: src });
}

/** Value must be a valid email address. */
export const isEmailAddress: ValidatorMarker = marker("emailAddress");

/** Value must be a valid URL. Optionally restrict to specific protocols. */
export function isUrl(options?: { protocols?: string[] }): ValidatorMarker {
    return marker("url", options?.protocols ? { protocols: options.protocols } : {});
}

/** Value must be a valid UUID. Implemented as a pattern validator. */
export const isUuid: ValidatorMarker = marker("pattern", {
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    flags: "i",
});

/** Value must be a valid phone number. */
export function isPhoneNumber(options?: { region?: string }): ValidatorMarker {
    return marker("phoneNumber", options?.region ? { region: options.region } : {});
}

/** Value must be a valid IP address. */
export function isIpAddress(options?: { version?: "v4" | "v6" }): ValidatorMarker {
    return marker("ipAddress", options?.version ? { version: options.version } : {});
}

// --- Enumerations ---

/** Value must be one of the listed values. */
export function oneOf(values: (string | number)[]): ValidatorMarker {
    return marker("oneOf", { values });
}

// --- Escape hatch ---

/** Custom named validator (must be registered in keyma.config.ts). */
export function customValidator(name: string): ValidatorMarker {
    return marker("custom", { name });
}
