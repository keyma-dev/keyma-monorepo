import type { SchemaMetadata, FormatterContext, FormatterFn } from "./types.js";

export type { FormatterContext, FormatterFn } from "./types.js";

/**
 * Apply every field's formatters for the given lifecycle `phase`, in order. Each
 * formatter is a direct callable re-emitted into the schema metadata (no registry).
 *
 * Absent (`undefined`) values are skipped — a partial update only formats the
 * fields it actually carries, and formatters never run against missing values.
 */
export async function format(
    schema: SchemaMetadata,
    value: Record<string, unknown>,
    phase: string,
): Promise<void> {
    const context: FormatterContext = { object: value };
    for (const field of schema.fields) {
        const current = value[field.name];
        if (current === undefined) continue;
        for (const fmt of field.formatters ?? []) {
            if (fmt.phase !== phase) continue;
            value[field.name] = await (fmt.fn as FormatterFn)(value[field.name], context);
        }
    }
}
