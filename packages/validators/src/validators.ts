import type { ValidatorFn, Json } from "@keyma/dsl";

// Built-in validators. Each is a plain factory function returning a `ValidatorFn`
// — `(value, field) => ValidationError | null`. The Keyma compiler resolves each
// from its `@Validate(...)` call site, reads the factory params and the returned
// function's body, lowers them to IR, and re-emits the implementation directly into
// the generated schema. Bodies use the portable expression subset (string/number/
// array ops, regex literals, conditionals, `new`).
//
// The inner `raw` parameter is typed via `ValidatorFn<T>`; the compiler emits a
// runtime guard from `T`, so a mismatched value yields a validation error rather
// than being inspected. Genuinely type-agnostic validators take `Json`.

// ─── String length ────────────────────────────────────────────────────────────

export function minLength(value: number): ValidatorFn<string> {
    return (raw, field) => (raw.length < value
        ? { field: field, code: "minLength", message: `${field} must be at least ${value} characters` }
        : null);
}

export function maxLength(value: number): ValidatorFn<string> {
    return (raw, field) => (raw.length > value
        ? { field: field, code: "maxLength", message: `${field} must be at most ${value} characters` }
        : null);
}

export function length(value: number): ValidatorFn<string> {
    return (raw, field) => (raw.length !== value
        ? { field: field, code: "length", message: `${field} must be exactly ${value} characters` }
        : null);
}

// ─── Numeric range ────────────────────────────────────────────────────────────

export function min(value: number): ValidatorFn<number> {
    return (raw, field) => (raw < value
        ? { field: field, code: "min", message: `${field} must be at least ${value}` }
        : null);
}

export function max(value: number): ValidatorFn<number> {
    return (raw, field) => (raw > value
        ? { field: field, code: "max", message: `${field} must be at most ${value}` }
        : null);
}

export function multipleOf(value: number): ValidatorFn<number> {
    return (raw, field) => (raw % value !== 0
        ? { field: field, code: "multipleOf", message: `${field} must be a multiple of ${value}` }
        : null);
}

export function isPositive(): ValidatorFn<number> {
    return (raw, field) => (raw <= 0
        ? { field: field, code: "positive", message: `${field} must be positive` }
        : null);
}

export function isNonNegative(): ValidatorFn<number> {
    return (raw, field) => (raw < 0
        ? { field: field, code: "nonNegative", message: `${field} must be non-negative` }
        : null);
}

export function isNegative(): ValidatorFn<number> {
    return (raw, field) => (raw >= 0
        ? { field: field, code: "negative", message: `${field} must be negative` }
        : null);
}

export function isNonPositive(): ValidatorFn<number> {
    return (raw, field) => (raw > 0
        ? { field: field, code: "nonPositive", message: `${field} must be non-positive` }
        : null);
}

export function isInteger(): ValidatorFn<number> {
    return (raw, field) => (raw % 1 !== 0
        ? { field: field, code: "integer", message: `${field} must be an integer` }
        : null);
}

// ─── Date range ────────────────────────────────────────────────────────────────
// Compares ISO-8601 strings lexically (which orders correctly for that format).

export function minDate(value: string): ValidatorFn<string> {
    return (raw, field) => (raw < value
        ? { field: field, code: "minDate", message: `${field} must be on or after ${value}` }
        : null);
}

export function maxDate(value: string): ValidatorFn<string> {
    return (raw, field) => (raw > value
        ? { field: field, code: "maxDate", message: `${field} must be on or before ${value}` }
        : null);
}

// ─── Array ────────────────────────────────────────────────────────────────────

export function minItems(value: number): ValidatorFn<Json[]> {
    return (raw, field) => (raw.length < value
        ? { field: field, code: "minItems", message: `${field} must have at least ${value} items` }
        : null);
}

export function maxItems(value: number): ValidatorFn<Json[]> {
    return (raw, field) => (raw.length > value
        ? { field: field, code: "maxItems", message: `${field} must have at most ${value} items` }
        : null);
}

// Shallow uniqueness (reference equality via indexOf) — sufficient for primitives.
export function hasUniqueItems(): ValidatorFn<Json[]> {
    return (raw, field) => (raw.filter((x, i) => raw.indexOf(x) !== i).length > 0
        ? { field: field, code: "uniqueItems", message: `${field} must contain unique items` }
        : null);
}

// ─── Format validators ────────────────────────────────────────────────────────

export function isEmail(): ValidatorFn<string> {
    return (raw, field) => (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)
        ? { field: field, code: "emailAddress", message: `${field} must be a valid email address` }
        : null);
}

export function isUrl(): ValidatorFn<string> {
    return (raw, field) => (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(raw)
        ? { field: field, code: "url", message: `${field} must be a valid URL` }
        : null);
}

export function isPhoneNumber(): ValidatorFn<string> {
    return (raw, field) => (!/^\+?[1-9]\d{6,14}$/.test(raw.replace(/[\s\-().]/g, ""))
        ? { field: field, code: "phoneNumber", message: `${field} must be a valid phone number` }
        : null);
}

export function isIpAddress(version?: "v4" | "v6"): ValidatorFn<string> {
    return (raw, field) => {
        const v4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
        const v6 = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(:[0-9a-f]{1,4}){1,6}|:((:[0-9a-f]{1,4}){1,7}|:))$/i;
        const ok = version === "v4" ? v4.test(raw) : version === "v6" ? v6.test(raw) : v4.test(raw) || v6.test(raw);
        return !ok
            ? { field: field, code: "ipAddress", message: `${field} must be a valid IP address` }
            : null;
    };
}

// Compiles the supplied pattern/flags into a RegExp at validation time.
export function pattern(value: string, flags?: string): ValidatorFn<string> {
    return (raw, field) => (!new RegExp(value, flags).test(raw)
        ? { field: field, code: "pattern", message: `${field} does not match the required pattern` }
        : null);
}

export function oneOf(...values: unknown[]): ValidatorFn<Json> {
    return (raw, field) => (raw !== null && raw !== undefined && !values.includes(raw)
        ? { field: field, code: "oneOf", message: `${field} must be one of: ${values.join(", ")}` }
        : null);
}
