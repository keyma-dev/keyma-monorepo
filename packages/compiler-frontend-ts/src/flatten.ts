import type { IRSchema, IRField, IRIndex, IRDiagnostic } from "@keyma/ir";
import { mkError, KEYMA032, KEYMA033, KEYMA034 } from "./diagnostics.js";

type FlattenContext = {
    /** Map from sourceName → extracted (pre-flatten) schema. */
    schemas: ReadonlyMap<string, IRSchema>;
    diagnostics: IRDiagnostic[];
};

/**
 * Flatten inheritance for all schemas.
 * Returns a new list of schemas where each schema's field list is the complete
 * flattened set (parent fields first, child fields overriding).
 */
export function flattenAll(schemas: IRSchema[], ctx: FlattenContext): IRSchema[] {
    const result: IRSchema[] = [];
    for (const schema of schemas) {
        result.push(flattenSchema(schema, ctx, new Set()));
    }
    return result;
}

function flattenSchema(
    schema: IRSchema,
    ctx: FlattenContext,
    visiting: Set<string>
): IRSchema {
    if (!schema.extends) return schema; // no inheritance, already flat

    const parentName = schema.extends;

    if (visiting.has(schema.sourceName)) {
        // Circular — skip (shouldn't happen in valid TS)
        return schema;
    }

    const parent = ctx.schemas.get(parentName);
    if (!parent) {
        ctx.diagnostics.push(
            mkError(KEYMA033, `"${schema.sourceName}" extends "${parentName}" which is not a @Schema class`, schema.source)
        );
        return schema;
    }

    // KEYMA032: public child cannot extend private parent
    if (schema.visibility === "public" && parent.visibility === "private") {
        ctx.diagnostics.push(
            mkError(KEYMA032, `Public schema "${schema.sourceName}" cannot extend private schema "${parentName}"`, schema.source)
        );
    }

    // Recursively flatten the parent first
    visiting.add(schema.sourceName);
    const flatParent = flattenSchema(parent, ctx, visiting);
    visiting.delete(schema.sourceName);

    // Merge fields: parent first, child overrides by name
    const mergedFields = mergeFields(flatParent.fields, schema.fields, schema, ctx);

    // Merge composite indexes: concatenate and deduplicate
    const mergedIndexes = mergeIndexes(flatParent.indexes, schema.indexes);

    return {
        ...schema,
        fields: mergedFields,
        indexes: mergedIndexes,
    };
}

function mergeFields(
    parentFields: IRField[],
    childFields: IRField[],
    childSchema: IRSchema,
    ctx: FlattenContext
): IRField[] {
    const result = new Map<string, IRField>();

    for (const f of parentFields) {
        result.set(f.name, f);
    }

    for (const f of childFields) {
        const existing = result.get(f.name);
        if (existing) {
            // Type compatibility check: child must not change the type in an incompatible way.
            if (!typesCompatible(existing.type, f.type)) {
                ctx.diagnostics.push(
                    mkError(
                        KEYMA034,
                        `Field "${f.name}" in "${childSchema.sourceName}" overrides parent field with incompatible type`,
                        f.source
                    )
                );
            }
        }
        result.set(f.name, f);
    }

    return [...result.values()];
}

/**
 * A simplified type-compatibility check.
 * For Milestone 2, we only require that both types have the same `kind`.
 */
function typesCompatible(
    parent: import("@keyma/ir").IRType,
    child: import("@keyma/ir").IRType
): boolean {
    if (parent.kind !== child.kind) return false;
    if (parent.kind === "reference" || parent.kind === "embedded") {
        return parent.schema === (child as typeof parent).schema;
    }
    if (parent.kind === "enum") {
        return true; // Allow enum value changes
    }
    return true;
}

function mergeIndexes(parentIndexes: IRIndex[], childIndexes: IRIndex[]): IRIndex[] {
    const all = [...parentIndexes, ...childIndexes];
    const seen = new Set<string>();
    return all.filter((idx) => {
        const key = normalizeIndexKey(idx);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeIndexKey(idx: IRIndex): string {
    const fields = [...idx.fields]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => `${f.name}:${f.direction}`)
        .join(",");
    return `[${fields}]|unique=${idx.unique ?? false}|sparse=${idx.sparse ?? false}`;
}
