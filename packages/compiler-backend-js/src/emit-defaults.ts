import type { IRSchema, IRField, IRExpression } from "@keyma/ir";
import { exprToJs } from "./emit-expression.js";

/**
 * Build the `applyDefaults` arrow for a schema's expression-kind field defaults
 * (`= (() => new Date())()`, `= myFn()`), attached directly to the frozen schema
 * metadata. Each line fills one absent field by evaluating the re-emitted expression
 * per record at create time. Returns null when the schema has no expression defaults.
 * Literal defaults are not handled here — they ride in the field metadata and are
 * applied generically by the runtime.
 */
export function buildApplyDefaults(schema: IRSchema, includePrivate: boolean): string | null {
    const fields = visibleFields(schema, includePrivate).filter(
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

/** Whether a schema has at least one visible expression-kind default. */
export function schemaHasExpressionDefault(schema: IRSchema, includePrivate: boolean): boolean {
    return visibleFields(schema, includePrivate).some(
        (f) => f.default !== undefined && f.default.kind === "expression",
    );
}

/** Names of utility functions referenced by a schema's expression defaults. */
export function defaultsReferencedFunctions(schema: IRSchema, includePrivate: boolean): Set<string> {
    const names = new Set<string>();
    for (const f of visibleFields(schema, includePrivate)) {
        if (f.default !== undefined && f.default.kind === "expression") {
            collectIdentifiers(f.default.expression, names);
        }
    }
    return names;
}

function collectIdentifiers(expr: IRExpression, out: Set<string>): void {
    switch (expr.kind) {
        case "identifier": out.add(expr.name); break;
        case "member": collectIdentifiers(expr.object, out); break;
        case "call": collectIdentifiers(expr.callee, out); expr.args.forEach((a) => collectIdentifiers(a, out)); break;
        case "new": collectIdentifiers(expr.callee, out); expr.args.forEach((a) => collectIdentifiers(a, out)); break;
        case "typeof": collectIdentifiers(expr.operand, out); break;
        case "unary": collectIdentifiers(expr.operand, out); break;
        case "template": expr.parts.forEach((p) => collectIdentifiers(p, out)); break;
        case "binary": collectIdentifiers(expr.left, out); collectIdentifiers(expr.right, out); break;
        case "conditional":
            collectIdentifiers(expr.condition, out);
            collectIdentifiers(expr.whenTrue, out);
            collectIdentifiers(expr.whenFalse, out);
            break;
        case "object": expr.properties.forEach((p) => collectIdentifiers(p.value, out)); break;
        case "arrow": collectIdentifiers(expr.body, out); break;
        case "intrinsic":
            if (expr.receiver) collectIdentifiers(expr.receiver, out);
            expr.args.forEach((a) => collectIdentifiers(a, out));
            break;
    }
}

function visibleFields(schema: IRSchema, includePrivate: boolean): IRField[] {
    return includePrivate ? schema.fields : schema.fields.filter((f) => f.visibility === "public");
}
