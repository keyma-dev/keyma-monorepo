import type { SchemaMetadata, FormatterContext, FormatterFn } from "./types.js";
import { allSchemaFields } from "./schema-fields.js";

export type { FormatterContext, FormatterFn } from "./types.js";

/**
 * Apply every field's formatters for the given lifecycle `phase`, in order. Each formatter is a
 * direct callable re-emitted into the schema metadata (no registry). Formatters are synchronous
 * (async rejected at the frontend, KEYMA026), so the driver never awaits.
 *
 * Absent (`undefined`) values are skipped — a partial update only formats the fields it actually
 * carries, and formatters never run against missing values. Mutates `value` in place.
 */
export function format(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
    phase: string,
): void {
    const context: FormatterContext = { object: value };
    for (const field of allSchemaFields(schema)) {
        const current = value[field.name];
        if (current === undefined) continue;
        for (const fmt of field.formatters ?? []) {
            if (fmt.phase !== phase) continue;
            value[field.name] = (fmt.fn as FormatterFn)(value[field.name], context);
        }
    }
}
