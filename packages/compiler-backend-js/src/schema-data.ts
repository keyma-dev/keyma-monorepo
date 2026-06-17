import type { IRSchema, IRField, IRFieldIndex, IRIndex } from "@keyma/ir";
import { exprToJs } from "./emit-expression.js";

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
 * Build the JSON-serializable metadata object for a schema. Caller decides
 * how to embed it (e.g. as a frozen literal in the model file).
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
 * Build the `materialize<Name>` function source as a string. Returns null when
 * the schema has no computed fields.
 */
export function buildMaterializer(schema: IRSchema, includePrivate: boolean): string | null {
    const computedFields = visibleFields(schema, includePrivate).filter((f) => f.computed !== undefined);
    if (computedFields.length === 0) return null;

    const lines: string[] = [];
    lines.push(`export function materialize${schema.sourceName}(value) {`);
    for (const field of computedFields) {
        if (field.computed === undefined) continue;
        const jsExpr = exprToJs(field.computed.expression).replace(/\bthis\./g, "value.");
        lines.push(`    value.${field.name} = ${jsExpr};`);
    }
    lines.push(`    return value;`);
    lines.push(`}`);
    return lines.join("\n");
}

/** Whether a schema has any visible computed fields. */
export function hasComputedFields(schema: IRSchema, includePrivate: boolean): boolean {
    return visibleFields(schema, includePrivate).some((f) => f.computed !== undefined);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

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
