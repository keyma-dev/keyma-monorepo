import { Validator } from "@keyma/dsl";

// Built-in validators. Each is a `Validator(name, factory)` whose factory returns
// the implementation `(raw, field) => ValidationError | null`. The Keyma compiler
// reads these factories, lowers their bodies to IR, and emits a validator registry
// consumed at runtime. Bodies use the portable expression subset (string/number/
// array ops, regex literals, conditionals, `new`). A validator returns `null` when
// the value is valid and only inspects values of the relevant runtime type, so it
// is a no-op for values of other types.

// ─── Presence ─────────────────────────────────────────────────────────────────

export const isRequired = Validator("required", () =>
    (raw, field) => (raw === null || raw === undefined || raw === ""
        ? { field: field, code: "required", message: `${field} is required` }
        : null),
);

// ─── String length ────────────────────────────────────────────────────────────

export const minLength = Validator("minLength", (value: number) =>
    (raw, field) => (typeof raw === "string" && raw.length < value
        ? { field: field, code: "minLength", message: `${field} must be at least ${value} characters` }
        : null),
);

export const maxLength = Validator("maxLength", (value: number) =>
    (raw, field) => (typeof raw === "string" && raw.length > value
        ? { field: field, code: "maxLength", message: `${field} must be at most ${value} characters` }
        : null),
);

export const length = Validator("length", (value: number) =>
    (raw, field) => (typeof raw === "string" && raw.length !== value
        ? { field: field, code: "length", message: `${field} must be exactly ${value} characters` }
        : null),
);

// ─── Numeric range ────────────────────────────────────────────────────────────

export const min = Validator("min", (value: number) =>
    (raw, field) => (typeof raw === "number" && raw < value
        ? { field: field, code: "min", message: `${field} must be at least ${value}` }
        : null),
);

export const max = Validator("max", (value: number) =>
    (raw, field) => (typeof raw === "number" && raw > value
        ? { field: field, code: "max", message: `${field} must be at most ${value}` }
        : null),
);

export const multipleOf = Validator("multipleOf", (value: number) =>
    (raw, field) => (typeof raw === "number" && raw % value !== 0
        ? { field: field, code: "multipleOf", message: `${field} must be a multiple of ${value}` }
        : null),
);

export const isPositive = Validator("positive", () =>
    (raw, field) => (typeof raw === "number" && raw <= 0
        ? { field: field, code: "positive", message: `${field} must be positive` }
        : null),
);

export const isNonNegative = Validator("nonNegative", () =>
    (raw, field) => (typeof raw === "number" && raw < 0
        ? { field: field, code: "nonNegative", message: `${field} must be non-negative` }
        : null),
);

export const isNegative = Validator("negative", () =>
    (raw, field) => (typeof raw === "number" && raw >= 0
        ? { field: field, code: "negative", message: `${field} must be negative` }
        : null),
);

export const isNonPositive = Validator("nonPositive", () =>
    (raw, field) => (typeof raw === "number" && raw > 0
        ? { field: field, code: "nonPositive", message: `${field} must be non-positive` }
        : null),
);

export const isInteger = Validator("integer", () =>
    (raw, field) => (typeof raw === "number" && !Number.isInteger(raw)
        ? { field: field, code: "integer", message: `${field} must be an integer` }
        : null),
);

// ─── Date range ────────────────────────────────────────────────────────────────
// Compares ISO-8601 strings lexically (which orders correctly for that format).

export const minDate = Validator("minDate", (value: string) =>
    (raw, field) => (typeof raw === "string" && raw < value
        ? { field: field, code: "minDate", message: `${field} must be on or after ${value}` }
        : null),
);

export const maxDate = Validator("maxDate", (value: string) =>
    (raw, field) => (typeof raw === "string" && raw > value
        ? { field: field, code: "maxDate", message: `${field} must be on or before ${value}` }
        : null),
);

// ─── Array ────────────────────────────────────────────────────────────────────

export const minItems = Validator("minItems", (value: number) =>
    (raw, field) => (Array.isArray(raw) && raw.length < value
        ? { field: field, code: "minItems", message: `${field} must have at least ${value} items` }
        : null),
);

export const maxItems = Validator("maxItems", (value: number) =>
    (raw, field) => (Array.isArray(raw) && raw.length > value
        ? { field: field, code: "maxItems", message: `${field} must have at most ${value} items` }
        : null),
);

// Shallow uniqueness (reference equality via indexOf) — sufficient for primitives.
export const hasUniqueItems = Validator("uniqueItems", () =>
    (raw, field) => (Array.isArray(raw) && raw.filter((x, i) => raw.indexOf(x) !== i).length > 0
        ? { field: field, code: "uniqueItems", message: `${field} must contain unique items` }
        : null),
);

// ─── Format validators ────────────────────────────────────────────────────────

export const isEmail = Validator("emailAddress", () =>
    (raw, field) => (typeof raw === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)
        ? { field: field, code: "emailAddress", message: `${field} must be a valid email address` }
        : null),
);

export const isUrl = Validator("url", () =>
    (raw, field) => (typeof raw === "string" && !/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(raw)
        ? { field: field, code: "url", message: `${field} must be a valid URL` }
        : null),
);

export const isPhoneNumber = Validator("phoneNumber", () =>
    (raw, field) => (typeof raw === "string" && !/^\+?[1-9]\d{6,14}$/.test(raw.replace(/[\s\-().]/g, ""))
        ? { field: field, code: "phoneNumber", message: `${field} must be a valid phone number` }
        : null),
);

export const isIpAddress = Validator("ipAddress", (version?: "v4" | "v6") =>
    (raw, field) => {
        const v4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
        const v6 = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(:[0-9a-f]{1,4}){1,6}|:((:[0-9a-f]{1,4}){1,7}|:))$/i;
        const ok = version === "v4" ? v4.test(raw) : version === "v6" ? v6.test(raw) : v4.test(raw) || v6.test(raw);
        return typeof raw === "string" && !ok
            ? { field: field, code: "ipAddress", message: `${field} must be a valid IP address` }
            : null;
    },
);

// Compiles the supplied pattern/flags into a RegExp at validation time.
export const pattern = Validator("pattern", (value: string, flags?: string) =>
    (raw, field) => (typeof raw === "string" && !new RegExp(value, flags).test(raw)
        ? { field: field, code: "pattern", message: `${field} does not match the required pattern` }
        : null),
);

export const oneOf = Validator("oneOf", (...values: unknown[]) =>
    (raw, field) => (raw !== null && raw !== undefined && !values.includes(raw)
        ? { field: field, code: "oneOf", message: `${field} must be one of: ${values.join(", ")}` }
        : null),
);
