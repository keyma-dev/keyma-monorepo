import type { SchemaMetadata, ValidationError, ValidatorContext, ValidatorFn } from "./types.js";
import { allSchemaFields } from "./schema-fields.js";

export type { ValidatorContext, ValidatorFn } from "./types.js";

/**
 * Run every field's validators. Each validator is a direct callable re-emitted into the schema
 * metadata (`field.validators`) — there is no registry to pass. A validator returns a
 * {@link ValidationError} or `null`. Validators are synchronous: async validators are rejected at
 * the frontend (KEYMA026), so the driver never awaits.
 *
 * Absent (`undefined`) values are not passed to validators: a required field that is missing fails
 * with `code: "required"`, while an optional missing field is skipped.
 */
export function validate(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
): ValidationError[] {
    const errors: ValidationError[] = [];
    const context: ValidatorContext = { object: value };
    for (const field of allSchemaFields(schema)) {
        const raw = value[field.name];

        // An absent value skips its validators (they would otherwise trip their own type guards).
        // A required field that is absent fails with `required`; an optional absent field simply
        // has nothing to validate.
        if (raw === undefined) {
            if (field.required !== false) {
                errors.push({
                    field: field.name,
                    code: "required",
                    message: `${field.name} is required`,
                });
            }
            continue;
        }

        for (const fn of (field.validators ?? []) as ValidatorFn[]) {
            const result = fn(raw, field.name, context);
            if (result !== null && result !== undefined) errors.push(result);
        }
    }
    return errors;
}

/**
 * Collect the non-null candidate errors into a `ValidationError[]` — the baked collector a
 * synthesized method-driven `validate()` lowers `error.collect(...)` to (the JS leg of the typed
 * validator hot path; the C++ leg is `keyma::collect_errors`). Each candidate is a per-field
 * validator result (`ValidationError | null | undefined`); nullish ones are dropped.
 */
export const __keyma_collect = (...es: (ValidationError | null | undefined)[]): ValidationError[] =>
    es.filter((e): e is ValidationError => e != null);
