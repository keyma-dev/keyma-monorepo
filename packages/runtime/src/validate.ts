import type { SchemaMetadata, ValidationError, ValidatorContext, ValidatorFn } from "./types.js";
import { allFields } from "./fields.js";

export type { ValidatorContext, ValidatorFn } from "./types.js";

/**
 * Run every field's validators. Each validator is a direct callable re-emitted
 * into the schema metadata — there is no registry to pass. A validator returns a
 * {@link ValidationError} or `null`/`undefined`.
 *
 * Absent (`undefined`) values are not passed to validators: a required field that
 * is missing fails with `code: "required"`, while an optional missing field is
 * skipped.
 */
export async function validate(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];
    const context: ValidatorContext = { object: value };
    for (const field of allFields(schema)) {
        const raw = value[field.name];

        // An absent value skips its validators (they would otherwise trip their
        // own type guards). A required field that is absent fails with `required`;
        // an optional field that is absent simply has nothing to validate.
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
            const result = await fn(raw, field.name, context);
            if (result !== null && result !== undefined) errors.push(result);
        }
    }
    return errors;
}
