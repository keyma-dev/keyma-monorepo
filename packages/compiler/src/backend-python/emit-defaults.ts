import type { IRClassDeclaration } from "@keyma/core/ir";
import { filterVisibleFields } from "@keyma/core/util";
import { exprToPython, withHoist, type Hoist } from "./emit-expression.js";

/**
 * Build a module-level `apply_defaults` function for a class's expression-kind
 * member defaults, referenced from the class metadata dict. Returns the function
 * name + its source, or null when the class has no expression defaults.
 */
export function buildApplyDefaults(cls: IRClassDeclaration, includePrivate: boolean): { name: string; def: string } | null {
    const fields = filterVisibleFields(cls, includePrivate).filter(
        (f) => f.default !== undefined && f.default.kind === "expression",
    );
    if (fields.length === 0) return null;

    const name = `_apply_defaults_${cls.sourceName}`;
    const lines = [`def ${name}(value):`];
    const rw = (s: string): string => s.replace(/self\.([a-zA-Z0-9_]+)/g, 'value["$1"]');
    for (const f of fields) {
        const expr = (f.default as { kind: "expression"; expression: import("@keyma/core/ir").IRExpression }).expression;
        const hoist: Hoist = { defs: [], n: { v: 0 } };
        const raw = withHoist(hoist, () => exprToPython(expr));
        lines.push(`    if value.get("${f.name}") is None:`);
        // Drain any block-arrow defs into the if-block, before the assignment (also self→value rewritten).
        for (const def of hoist.defs) for (const dl of def.split("\n")) lines.push(dl === "" ? "" : "        " + rw(dl));
        lines.push(`        value["${f.name}"] = ${rw(raw)}`);
    }
    return { name, def: lines.join("\n") };
}

export function classHasExpressionDefault(cls: IRClassDeclaration, includePrivate: boolean): boolean {
    return filterVisibleFields(cls, includePrivate).some((f) => f.default !== undefined && f.default.kind === "expression");
}
