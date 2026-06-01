import type { SchemaMetadata, FormatterSpec } from "./types.js";

export type FormatterContext = { object: Record<string, unknown> };

export type FormatterFn = (value: unknown, spec: FormatterSpec, context: FormatterContext) => unknown | Promise<unknown>;
export type FormatterRegistry = Map<string, FormatterFn>;

export async function format(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
    phase: string,
    registry: FormatterRegistry = new Map(),
): Promise<void> {
    const context: FormatterContext = { object: value };
    for (const field of schema.fields) {
        for (const fmt of field.formatters ?? []) {
            if (fmt.phase !== phase) continue;
            const fn = registry.get(fmt.spec.name);
            if (fn === undefined) continue;
            value[field.name] = await fn(value[field.name], flattenParams(fmt.spec), context);
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function flattenParams(spec: FormatterSpec): FormatterSpec {
    const params = spec["params"];
    if (params !== null && typeof params === "object" && !Array.isArray(params)) {
        return { ...spec, ...(params as Record<string, unknown>) };
    }
    return spec;
}
