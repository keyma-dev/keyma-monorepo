import { isIPv4, isIPv6 } from "node:net";
import type { SchemaMetadata, ValidatorSpec, ValidationError } from "./types.js";

export type ValidatorContext = { object: Record<string, unknown> };

export type ValidatorFn = (
    value: unknown,
    spec: ValidatorSpec,
    field: string,
    context: ValidatorContext,
) => ValidationError | null | Promise<ValidationError | null>;

export type ValidatorRegistry = Map<string, ValidatorFn>;

export function createDefaultValidatorRegistry(): ValidatorRegistry {
    const r = new Map<string, ValidatorFn>();

    r.set("required", (raw, _spec, field, _context) =>
        raw === null || raw === undefined || raw === ""
            ? err(field, "required", `${field} is required`)
            : null,
    );

    r.set("minLength", (raw, spec, field, _context) => {
        const v = num(spec["value"]);
        if (typeof raw === "string" && raw.length < v) {
            return err(field, "minLength", `${field} must be at least ${v} characters`);
        }
        return null;
    });

    r.set("maxLength", (raw, spec, field, _context) => {
        const v = num(spec["value"]);
        if (typeof raw === "string" && raw.length > v) {
            return err(field, "maxLength", `${field} must be at most ${v} characters`);
        }
        return null;
    });

    r.set("length", (raw, spec, field, _context) => {
        const v = num(spec["value"]);
        if (typeof raw === "string" && raw.length !== v) {
            return err(field, "length", `${field} must be exactly ${v} characters`);
        }
        return null;
    });

    r.set("min", (raw, spec, field, _context) => {
        const v = num(spec["value"]);
        if (typeof raw === "number" && raw < v) {
            return err(field, "min", `${field} must be at least ${v}`);
        }
        return null;
    });

    r.set("max", (raw, spec, field, _context) => {
        const v = num(spec["value"]);
        if (typeof raw === "number" && raw > v) {
            return err(field, "max", `${field} must be at most ${v}`);
        }
        return null;
    });

    r.set("multipleOf", (raw, spec, field, _context) => {
        const v = num(spec["value"]);
        if (typeof raw === "number" && raw % v !== 0) {
            return err(field, "multipleOf", `${field} must be a multiple of ${v}`);
        }
        return null;
    });

    r.set("positive", (raw, _spec, field, _context) =>
        typeof raw === "number" && raw <= 0
            ? err(field, "positive", `${field} must be positive`)
            : null,
    );

    r.set("nonNegative", (raw, _spec, field, _context) =>
        typeof raw === "number" && raw < 0
            ? err(field, "nonNegative", `${field} must be non-negative`)
            : null,
    );

    r.set("negative", (raw, _spec, field, _context) =>
        typeof raw === "number" && raw >= 0
            ? err(field, "negative", `${field} must be negative`)
            : null,
    );

    r.set("nonPositive", (raw, _spec, field, _context) =>
        typeof raw === "number" && raw > 0
            ? err(field, "nonPositive", `${field} must be non-positive`)
            : null,
    );

    r.set("integer", (raw, _spec, field, _context) =>
        typeof raw === "number" && !Number.isInteger(raw)
            ? err(field, "integer", `${field} must be an integer`)
            : null,
    );

    r.set("minDate", (raw, spec, field, _context) => {
        const v = str(spec["value"]);
        const asDate = raw instanceof Date ? raw : (typeof raw === "string" ? new Date(raw) : null);
        const threshold = new Date(v);
        if (asDate !== null && !isNaN(asDate.getTime()) && asDate < threshold) {
            return err(field, "minDate", `${field} must be on or after ${v}`);
        }
        return null;
    });

    r.set("maxDate", (raw, spec, field, _context) => {
        const v = str(spec["value"]);
        const asDate = raw instanceof Date ? raw : (typeof raw === "string" ? new Date(raw) : null);
        const threshold = new Date(v);
        if (asDate !== null && !isNaN(asDate.getTime()) && asDate > threshold) {
            return err(field, "maxDate", `${field} must be on or before ${v}`);
        }
        return null;
    });

    r.set("minItems", (raw, spec, field, _context) => {
        const v = num(spec["value"]);
        if (Array.isArray(raw) && raw.length < v) {
            return err(field, "minItems", `${field} must have at least ${v} items`);
        }
        return null;
    });

    r.set("maxItems", (raw, spec, field, _context) => {
        const v = num(spec["value"]);
        if (Array.isArray(raw) && raw.length > v) {
            return err(field, "maxItems", `${field} must have at most ${v} items`);
        }
        return null;
    });

    r.set("uniqueItems", (raw, _spec, field, _context) => {
        if (Array.isArray(raw)) {
            const seen = new Set(raw.map((x) => JSON.stringify(x)));
            if (seen.size !== raw.length) {
                return err(field, "uniqueItems", `${field} must contain unique items`);
            }
        }
        return null;
    });

    r.set("pattern", (raw, spec, field, _context) => {
        const pattern = str(spec["pattern"]);
        const flags = typeof spec["flags"] === "string" ? spec["flags"] : "";
        if (typeof raw === "string") {
            const re = new RegExp(pattern, flags);
            if (!re.test(raw)) {
                return err(field, "pattern", `${field} does not match the required pattern`);
            }
        }
        return null;
    });

    r.set("emailAddress", (raw, _spec, field, _context) =>
        typeof raw === "string" && !isEmail(raw)
            ? err(field, "emailAddress", `${field} must be a valid email address`)
            : null,
    );

    r.set("url", (raw, spec, field, _context) => {
        const protocols = Array.isArray(spec["protocols"])
            ? (spec["protocols"] as unknown[]).filter((p): p is string => typeof p === "string")
            : undefined;
        if (typeof raw === "string" && !isUrl(raw, protocols)) {
            return err(field, "url", `${field} must be a valid URL`);
        }
        return null;
    });

    r.set("phoneNumber", (raw, _spec, field, _context) =>
        typeof raw === "string" && !isPhone(raw)
            ? err(field, "phoneNumber", `${field} must be a valid phone number`)
            : null,
    );

    r.set("ipAddress", (raw, spec, field, _context) => {
        const version = spec["version"] === "v4" || spec["version"] === "v6" ? spec["version"] : undefined;
        if (typeof raw === "string" && !isIp(raw, version)) {
            return err(field, "ipAddress", `${field} must be a valid IP address`);
        }
        return null;
    });

    r.set("oneOf", (raw, spec, field, _context) => {
        const values = Array.isArray(spec["values"]) ? (spec["values"] as unknown[]) : [];
        if (raw !== undefined && raw !== null && !values.includes(raw)) {
            return err(field, "oneOf", `${field} must be one of: ${values.join(", ")}`);
        }
        return null;
    });

    return r;
}

let defaultRegistry: ValidatorRegistry | null = null;

function getDefaultRegistry(): ValidatorRegistry {
    if (defaultRegistry === null) defaultRegistry = createDefaultValidatorRegistry();
    return defaultRegistry;
}

export async function validate(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
    registry: ValidatorRegistry = getDefaultRegistry(),
): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];
    const context: ValidatorContext = { object: value };
    for (const field of schema.fields) {
        const raw = value[field.name];
        for (const v of field.validators ?? []) {
            const fn = registry.get(v.kind);
            if (fn === undefined) continue;
            const result = await fn(raw, v, field.name, context);
            if (result !== null) errors.push(result);
        }
    }
    return errors;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function err(field: string, code: string, message: string): ValidationError {
    return { field, code, message };
}

function num(v: unknown): number {
    return typeof v === "number" ? v : 0;
}

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isEmail(v: string): boolean {
    return EMAIL_RE.test(v);
}

function isUrl(v: string, protocols?: string[]): boolean {
    let url: URL;
    try {
        url = new URL(v);
    } catch {
        return false;
    }
    if (protocols !== undefined && protocols.length > 0) {
        const proto = url.protocol.slice(0, -1);
        return protocols.includes(proto);
    }
    return true;
}

const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

function isPhone(v: string): boolean {
    return PHONE_RE.test(v.replace(/[\s\-().]/g, ""));
}

function isIp(v: string, version?: "v4" | "v6"): boolean {
    if (version === "v6") return isIPv6(v);
    if (version === "v4") return isIPv4(v);
    return isIPv4(v) || isIPv6(v);
}
