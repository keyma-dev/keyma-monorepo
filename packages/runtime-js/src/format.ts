import type { SchemaMetadata, FormatterSpec } from "./types.js";

export type FormatterContext = { object: Record<string, unknown> };

export type FormatterFn = (value: unknown, spec: FormatterSpec, context: FormatterContext) => unknown | Promise<unknown>;
export type FormatterRegistry = Map<string, FormatterFn>;

export function createDefaultFormatterRegistry(): FormatterRegistry {
    const r = new Map<string, FormatterFn>();
    r.set("trim", (v, _spec, _context) => onString(v, (s) => s.trim()));
    r.set("lowercase", (v, _spec, _context) => onString(v, (s) => s.toLowerCase()));
    r.set("uppercase", (v, _spec, _context) => onString(v, (s) => s.toUpperCase()));
    r.set("capitalize", (v, _spec, _context) =>
        onString(v, (s) => (s.length === 0 ? "" : s[0]!.toUpperCase() + s.slice(1).toLowerCase())),
    );
    r.set("titleCase", (v, _spec, _context) => onString(v, (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())));
    r.set("normalizeWhitespace", (v, _spec, _context) => onString(v, (s) => s.trim().replace(/\s+/g, " ")));
    r.set("stripNonDigits", (v, _spec, _context) => onString(v, (s) => s.replace(/\D/g, "")));
    r.set("normalizeEmail", (v, _spec, _context) => onString(v, (s) => s.toLowerCase().trim()));
    r.set("normalizeUrl", (v, _spec, _context) => onString(v, normalizeUrl));
    r.set("normalizePhone", (v, _spec, _context) => onString(v, normalizePhone));
    r.set("slugify", (v, _spec, _context) => onString(v, slugify));
    r.set("truncate", (v, spec, _context) =>
        onString(v, (s) => {
            const max = typeof spec["maxLength"] === "number" ? spec["maxLength"] : Infinity;
            return s.length > max ? s.slice(0, max) : s;
        }),
    );
    return r;
}

let defaultRegistry: FormatterRegistry | null = null;

function getDefaultRegistry(): FormatterRegistry {
    if (defaultRegistry === null) defaultRegistry = createDefaultFormatterRegistry();
    return defaultRegistry;
}

export async function format(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
    phase: string,
    registry: FormatterRegistry = getDefaultRegistry(),
): Promise<void> {
    const context: FormatterContext = { object: value };
    for (const field of schema.fields) {
        for (const fmt of field.formatters ?? []) {
            if (fmt.phase !== phase) continue;
            const fn = registry.get(fmt.spec.kind);
            if (fn === undefined) continue;
            value[field.name] = await fn(value[field.name], fmt.spec, context);
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function onString(v: unknown, fn: (s: string) => string): unknown {
    return typeof v === "string" ? fn(v) : v;
}

function normalizeUrl(value: string): string {
    try {
        const url = new URL(value);
        url.hostname = url.hostname.toLowerCase();
        if (
            (url.protocol === "https:" && url.port === "443") ||
            (url.protocol === "http:" && url.port === "80")
        ) {
            url.port = "";
        }
        return url.toString();
    } catch {
        return value;
    }
}

function normalizePhone(value: string): string {
    const digits = value.replace(/\D/g, "");
    if (digits.length === 0) return value;
    return `+${digits}`;
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/[\s_]+/g, "-")
        .replace(/-+/g, "-");
}
