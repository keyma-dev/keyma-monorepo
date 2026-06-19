import type { IRSchema, IRField, IRFieldIndex, IRIndex } from "@keyma/ir";
import { exprToPython } from "./emit-expression.js";

export type SchemaDataOptions = {
    /** Include private fields. */
    includePrivate: boolean;
    /** Include index metadata (field indexes, schema indexes). */
    includeIndexes: boolean;
    /** Client-only: restrict formatters to form phases (change/blur/submit). */
    formPhasesOnly: boolean;
};

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/**
 * Build the JSON-serializable metadata object for a schema.
 */
export function buildSchemaData(schema: IRSchema, opts: SchemaDataOptions): object {
    const fields = visibleFields(schema, opts.includePrivate).map((f) => buildFieldData(f, opts));
    const indexes = opts.includeIndexes ? schema.indexes.map(buildIndexData) : [];

    const out: Record<string, unknown> = {
        name: schema.name,
        sourceName: schema.sourceName,
        fields,
    };
    if (indexes.length > 0) out["indexes"] = indexes;
    if (schema.edge !== undefined) out["edge"] = schema.edge;
    if (schema.visibility === "private") out["visibility"] = "private";
    if (schema.ephemeral) out["ephemeral"] = true;
    return out;
}

/**
 * Build the `materialize<Name>` function source as a string.
 */
export function buildMaterializer(schema: IRSchema, includePrivate: boolean): string | null {
    const computedFields = visibleFields(schema, includePrivate).filter((f) => f.computed !== undefined);
    if (computedFields.length === 0) return null;

    const lines: string[] = [];
    lines.push(`def materialize${schema.sourceName}(value: dict) -> dict:`);
    for (const field of computedFields) {
        if (field.computed === undefined) continue;
        // Convert expression to Python, but replace 'self.' with 'value.' access.
        // Actually for a dict it should be value["name"].
        // This is tricky with simple regex because of nested properties etc.
        // For now let's assume computed expressions only access local fields.
        let pyExpr = exprToPython(field.computed.expression);
        pyExpr = pyExpr.replace(/self\.([a-zA-Z0-9_]+)/g, 'value["$1"]');
        
        lines.push(`    value["${field.name}"] = ${pyExpr}`);
    }
    lines.push(`    return value`);
    return lines.join("\n");
}

export function hasComputedFields(schema: IRSchema, includePrivate: boolean): boolean {
    return visibleFields(schema, includePrivate).some((f) => f.computed !== undefined);
}

function visibleFields(schema: IRSchema, includePrivate: boolean): IRField[] {
    return includePrivate ? schema.fields : schema.fields.filter((f) => f.visibility === "public");
}

function buildFieldData(field: IRField, opts: SchemaDataOptions): object {
    const formatters = opts.formPhasesOnly
        ? field.formatters.filter((fmt) => CLIENT_PHASES.has(fmt.phase))
        : field.formatters;

    const indexes: IRFieldIndex[] = opts.includeIndexes ? field.indexes : [];

    const base: Record<string, unknown> = {
        name: field.name,
        type: field.type,
    };

    if (field.visibility === "private") base["visibility"] = "private";
    if (field.readonly) base["readonly"] = true;
    if (!field.required) base["required"] = false;
    if (field.validators.length > 0) base["validators"] = field.validators;
    if (formatters.length > 0) base["formatters"] = formatters;
    if (indexes.length > 0) base["indexes"] = indexes;

    if (field.computed !== undefined) {
        base["computed"] = true;
    }
    if (field.ephemeral) {
        base["ephemeral"] = true;
    }

    return base;
}

function buildIndexData(index: IRIndex): object {
    const out: Record<string, unknown> = { fields: index.fields };
    if (index.unique !== undefined) out["unique"] = index.unique;
    if (index.sparse !== undefined) out["sparse"] = index.sparse;
    if (index.name !== undefined) out["name"] = index.name;
    return out;
}
