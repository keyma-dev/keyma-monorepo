import type { IRClassDeclaration, IRExpression } from "@keyma/core/ir";
import { collectIdentifiers, filterVisibleFields } from "@keyma/core/util";
import { exprToJs } from "./emit-expression.js";

/**
 * Build the `applyDefaults` arrow for a class's expression-kind member defaults
 * (`= (() => new Date())()`, `= myFn()`), attached directly to the frozen class
 * metadata. Each line fills one absent member by evaluating the re-emitted expression
 * per record at create time. Returns null when the class has no expression defaults.
 * Literal defaults are not handled here — they ride in the member metadata and are
 * applied generically by the runtime.
 */
export function buildApplyDefaults(cls: IRClassDeclaration, includePrivate: boolean): string | null {
    const fields = filterVisibleFields(cls, includePrivate).filter(
        (f) => f.default !== undefined && f.default.kind === "expression",
    );
    if (fields.length === 0) return null;

    const lines = fields.map((f) => {
        const expr = (f.default as { kind: "expression"; expression: IRExpression }).expression;
        const js = exprToJs(expr, { fieldAccess: (name) => `value.${name}` });
        return `        if (value.${f.name} === undefined) value.${f.name} = ${js};`;
    });
    return `(value) => {\n${lines.join("\n")}\n    }`;
}

/** Whether a class has at least one visible expression-kind default. */
export function classHasExpressionDefault(cls: IRClassDeclaration, includePrivate: boolean): boolean {
    return filterVisibleFields(cls, includePrivate).some(
        (f) => f.default !== undefined && f.default.kind === "expression",
    );
}

/** Names of utility functions referenced by a class's expression defaults. */
export function defaultsReferencedFunctions(cls: IRClassDeclaration, includePrivate: boolean): Set<string> {
    const names = new Set<string>();
    for (const f of filterVisibleFields(cls, includePrivate)) {
        if (f.default !== undefined && f.default.kind === "expression") {
            collectIdentifiers(f.default.expression, names);
        }
    }
    return names;
}
