import type { SchemaMetadata, ValidatorSpec, ValidationError } from "./types.js";

export type ValidatorContext = { object: Record<string, unknown> };

export type ValidatorFn = (
    value: unknown,
    spec: ValidatorSpec,
    field: string,
    context: ValidatorContext,
) => ValidationError | null | Promise<ValidationError | null>;

export type ValidatorRegistry = Map<string, ValidatorFn>;

export async function validate(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
    registry: ValidatorRegistry = new Map(),
): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];
    const context: ValidatorContext = { object: value };
    for (const field of schema.fields) {
        const raw = value[field.name];
        for (const v of field.validators ?? []) {
            const fn = registry.get(v.name);
            if (fn === undefined) continue;
            const result = await fn(raw, flattenParams(v), field.name, context);
            if (result !== null) errors.push(result);
        }
    }
    return errors;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function flattenParams(spec: ValidatorSpec): ValidatorSpec {
    const params = spec["params"];
    if (params !== null && typeof params === "object" && !Array.isArray(params)) {
        return { ...spec, ...(params as Record<string, unknown>) };
    }
    return spec;
}
