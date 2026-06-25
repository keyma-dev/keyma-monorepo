import type { IRSchema } from "@keyma/ir";
import { filterVisibleFields } from "@keyma/compiler-util";
import { exprToPython } from "./emit-expression.js";

/**
 * Build a module-level `apply_defaults` function for a schema's expression-kind
 * field defaults, referenced from the schema metadata dict. Returns the function
 * name + its source, or null when the schema has no expression defaults.
 */
export function buildApplyDefaults(schema: IRSchema, includePrivate: boolean): { name: string; def: string } | null {
    const fields = filterVisibleFields(schema, includePrivate).filter(
        (f) => f.default !== undefined && f.default.kind === "expression",
    );
    if (fields.length === 0) return null;

    const name = `_apply_defaults_${schema.sourceName}`;
    const lines = [`def ${name}(value):`];
    for (const f of fields) {
        const expr = (f.default as { kind: "expression"; expression: import("@keyma/ir").IRExpression }).expression;
        const py = exprToPython(expr).replace(/self\.([a-zA-Z0-9_]+)/g, 'value["$1"]');
        lines.push(`    if value.get("${f.name}") is None:`);
        lines.push(`        value["${f.name}"] = ${py}`);
    }
    return { name, def: lines.join("\n") };
}

export function schemaHasExpressionDefault(schema: IRSchema, includePrivate: boolean): boolean {
    return filterVisibleFields(schema, includePrivate).some((f) => f.default !== undefined && f.default.kind === "expression");
}
