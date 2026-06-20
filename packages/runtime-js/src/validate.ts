import type { SchemaMetadata, ValidationError, ValidatorContext, ValidatorFn } from "./types.js";

export type { ValidatorContext, ValidatorFn } from "./types.js";

/**
 * Run every field's validators. Each validator is a direct callable re-emitted
 * into the schema metadata — there is no registry to pass. A validator returns a
 * {@link ValidationError} or `null`/`undefined`.
 */
export async function validate(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];
    const context: ValidatorContext = { object: value };
    for (const field of schema.fields) {
        const raw = value[field.name];
        for (const fn of (field.validators ?? []) as ValidatorFn[]) {
            const result = await fn(raw, field.name, context);
            if (result !== null && result !== undefined) errors.push(result);
        }
    }
    return errors;
}
