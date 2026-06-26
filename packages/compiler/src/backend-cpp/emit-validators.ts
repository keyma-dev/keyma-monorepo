import type {
    IRStatement,
    IRExpression,
} from "@keyma/core/ir";
import { exprToCpp, type ExprOpts } from "./emit-expression.js";

/** A factory/function name as a valid C++ identifier. */
export function factoryIdent(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

// ─── Statement lowering (shared with methods/functions) ───────────────────────

/** Lowers a `return` statement; the strategy differs by body kind (plain / validator / formatter). */
export type ReturnLowerer = (value: IRExpression | null, indent: string) => string;

/** Plain return for methods/functions. */
export const plainReturn: ReturnLowerer = (value, indent) =>
    value === null ? `${indent}return;` : `${indent}return ${exprToCpp(value)};`;

export function stmtToCpp(stmt: IRStatement, indent: string, ret: ReturnLowerer, opts?: ExprOpts): string {
    switch (stmt.kind) {
        case "return":
            return ret(stmt.value, indent);
        case "if": {
            const cond = exprToCpp(stmt.condition, opts);
            const then = stmt.consequent.map((s) => stmtToCpp(s, indent + "    ", ret, opts)).join("\n");
            let out = `${indent}if (${cond}) {\n${then}\n${indent}}`;
            if (stmt.alternate && stmt.alternate.length > 0) {
                const alt = stmt.alternate.map((s) => stmtToCpp(s, indent + "    ", ret, opts)).join("\n");
                out += ` else {\n${alt}\n${indent}}`;
            }
            return out;
        }
        case "const":
            return `${indent}auto ${stmt.name} = ${exprToCpp(stmt.init, opts)};`;
        case "expression":
            return `${indent}${exprToCpp(stmt.expr, opts)};`;
        case "assign":
            return `${indent}${exprToCpp(stmt.target, opts)} = ${exprToCpp(stmt.value, opts)};`;
        default:
            // Additive IR vocabulary (forOf/while/break/continue/switch) emitted in a later slice.
            throw new Error(`stmtToCpp: unsupported IR statement kind "${(stmt as { kind: string }).kind}"`);
    }
}

/**
 * Rewrite portable cross-field access `<ctx>.object.<field>` to a Value lookup
 * `<ctx>.object.at("<field>")` (returns a const Value&; missing keys read as null).
 * No-op when the body declares no context parameter.
 */
export function rewriteContextAccess(code: string, ctxParam: string | undefined): string {
    if (ctxParam === undefined) return code;
    const re = new RegExp(`\\b${ctxParam}\\.object\\.([A-Za-z_][A-Za-z0-9_]*)`, "g");
    return code.replace(re, `${ctxParam}.object.at("$1")`);
}
