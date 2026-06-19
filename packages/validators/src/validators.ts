import { Validator } from "@keyma/dsl";
import type { Json } from "@keyma/dsl";

// Built-in validators. Each is a `Validator(name, factory)` whose factory returns
// the implementation `(raw, field) => ValidationError | null`. The Keyma compiler
// reads these factories, lowers their bodies to IR, and emits a validator registry
// consumed at runtime. Bodies use the portable expression subset (string/number/
// array ops, regex literals, conditionals, `new`).
//
// The `raw` parameter is typed to the value each validator operates on; the compiler
// emits a runtime guard from that type, so a mismatched value yields a validation
// error rather than being inspected. Genuinely type-agnostic validators take `Json`.
//
// (The "required" validator was removed — a field's required-ness is inferred by the
// DSL/IR and need not be expressed as a validator.)

// ─── String length ────────────────────────────────────────────────────────────

export const minLength = Validator("minLength", (value: number) =>
    (raw: string, field) => (raw.length < value
        ? { field: field, code: "minLength", message: `${field} must be at least ${value} characters` }
        : null),
);

export const maxLength = Validator("maxLength", (value: number) =>
    (raw: string, field) => (raw.length > value
        ? { field: field, code: "maxLength", message: `${field} must be at most ${value} characters` }
        : null),
);

export const length = Validator("length", (value: number) =>
    (raw: string, field) => (raw.length !== value
        ? { field: field, code: "length", message: `${field} must be exactly ${value} characters` }
        : null),
);

// ─── Numeric range ────────────────────────────────────────────────────────────

export const min = Validator("min", (value: number) =>
    (raw: number, field) => (raw < value
        ? { field: field, code: "min", message: `${field} must be at least ${value}` }
        : null),
);

export const max = Validator("max", (value: number) =>
    (raw: number, field) => (raw > value
        ? { field: field, code: "max", message: `${field} must be at most ${value}` }
        : null),
);

export const multipleOf = Validator("multipleOf", (value: number) =>
    (raw: number, field) => (raw % value !== 0
        ? { field: field, code: "multipleOf", message: `${field} must be a multiple of ${value}` }
        : null),
);

export const isPositive = Validator("positive", () =>
    (raw: number, field) => (raw <= 0
        ? { field: field, code: "positive", message: `${field} must be positive` }
        : null),
);

export const isNonNegative = Validator("nonNegative", () =>
    (raw: number, field) => (raw < 0
        ? { field: field, code: "nonNegative", message: `${field} must be non-negative` }
        : null),
);

export const isNegative = Validator("negative", () =>
    (raw: number, field) => (raw >= 0
        ? { field: field, code: "negative", message: `${field} must be negative` }
        : null),
);

export const isNonPositive = Validator("nonPositive", () =>
    (raw: number, field) => (raw > 0
        ? { field: field, code: "nonPositive", message: `${field} must be non-positive` }
        : null),
);

export const isInteger = Validator("integer", () =>
    (raw: number, field) => (raw % 1 !== 0
        ? { field: field, code: "integer", message: `${field} must be an integer` }
        : null),
);

// ─── Date range ────────────────────────────────────────────────────────────────
// Compares ISO-8601 strings lexically (which orders correctly for that format).

export const minDate = Validator("minDate", (value: string) =>
    (raw: string, field) => (raw < value
        ? { field: field, code: "minDate", message: `${field} must be on or after ${value}` }
        : null),
);

export const maxDate = Validator("maxDate", (value: string) =>
    (raw: string, field) => (raw > value
        ? { field: field, code: "maxDate", message: `${field} must be on or before ${value}` }
        : null),
);

// ─── Array ────────────────────────────────────────────────────────────────────

export const minItems = Validator("minItems", (value: number) =>
    (raw: Json[], field) => (raw.length < value
        ? { field: field, code: "minItems", message: `${field} must have at least ${value} items` }
        : null),
);

export const maxItems = Validator("maxItems", (value: number) =>
    (raw: Json[], field) => (raw.length > value
        ? { field: field, code: "maxItems", message: `${field} must have at most ${value} items` }
        : null),
);

// Shallow uniqueness (reference equality via indexOf) — sufficient for primitives.
export const hasUniqueItems = Validator("uniqueItems", () =>
    (raw: Json[], field) => (raw.filter((x, i) => raw.indexOf(x) !== i).length > 0
        ? { field: field, code: "uniqueItems", message: `${field} must contain unique items` }
        : null),
);

// ─── Format validators ────────────────────────────────────────────────────────

export const isEmail = Validator("emailAddress", () =>
    (raw: string, field) => (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)
        ? { field: field, code: "emailAddress", message: `${field} must be a valid email address` }
        : null),
);

export const isUrl = Validator("url", () =>
    (raw: string, field) => (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(raw)
        ? { field: field, code: "url", message: `${field} must be a valid URL` }
        : null),
);

export const isPhoneNumber = Validator("phoneNumber", () =>
    (raw: string, field) => (!/^\+?[1-9]\d{6,14}$/.test(raw.replace(/[\s\-().]/g, ""))
        ? { field: field, code: "phoneNumber", message: `${field} must be a valid phone number` }
        : null),
);

export const isIpAddress = Validator("ipAddress", (version?: "v4" | "v6") =>
    (raw: string, field) => {
        const v4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
        const v6 = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(:[0-9a-f]{1,4}){1,6}|:((:[0-9a-f]{1,4}){1,7}|:))$/i;
        const ok = version === "v4" ? v4.test(raw) : version === "v6" ? v6.test(raw) : v4.test(raw) || v6.test(raw);
        return !ok
            ? { field: field, code: "ipAddress", message: `${field} must be a valid IP address` }
            : null;
    },
);

// Compiles the supplied pattern/flags into a RegExp at validation time.
export const pattern = Validator("pattern", (value: string, flags?: string) =>
    (raw: string, field) => (!new RegExp(value, flags).test(raw)
        ? { field: field, code: "pattern", message: `${field} does not match the required pattern` }
        : null),
);

export const oneOf = Validator("oneOf", (...values: unknown[]) =>
    (raw: Json, field) => (raw !== null && raw !== undefined && !values.includes(raw)
        ? { field: field, code: "oneOf", message: `${field} must be one of: ${values.join(", ")}` }
        : null),
);
