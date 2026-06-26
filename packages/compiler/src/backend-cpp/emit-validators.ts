import type {
    IRStatement,
    IRExpression,
    IRSwitchStmt,
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
        case "forOf": {
            // `for (const <name> of <iterable>)` → a range-for. `const auto&` binds each element
            // without copying; backends infer the element type (issue 011).
            const iter = exprToCpp(stmt.iterable, opts);
            const body = blockBody(stmt.body, indent, ret, opts);
            return `${indent}for (const auto& ${stmt.name} : ${iter}) {\n${body}${indent}}`;
        }
        case "while": {
            const cond = exprToCpp(stmt.condition, opts);
            const body = blockBody(stmt.body, indent, ret, opts);
            return `${indent}while (${cond}) {\n${body}${indent}}`;
        }
        case "break":
            return `${indent}break;`;
        case "continue":
            return `${indent}continue;`;
        case "switch":
            return switchToCpp(stmt, indent, ret, opts);
        default:
            // Additive IR vocabulary whose C++ emission lands in a later slice.
            throw new Error(`stmtToCpp: unsupported IR statement kind "${(stmt as { kind: string }).kind}"`);
    }
}

/** Render a `{ … }` block body (each statement on its own line, trailing newline), or "" if empty. */
function blockBody(body: readonly IRStatement[], indent: string, ret: ReturnLowerer, opts?: ExprOpts): string {
    if (body.length === 0) return "";
    return body.map((s) => stmtToCpp(s, indent + "    ", ret, opts)).join("\n") + "\n";
}

// ─── switch (issue 012) ───────────────────────────────────────────────────────
//
// The switch IR does not carry the discriminant's STATIC type, so the C++ backend picks its
// rendering with a pragmatic heuristic on the case-label expressions:
//   • EVERY non-`default` test is a numeric literal or an enum-looking member access
//     (e.g. `Status.Active`)  ⇒  a native `switch` (integral/enum), with `[[fallthrough]];`
//     emitted after any NON-EMPTY case that falls through (no terminating break/return/continue)
//     into the next case. Empty (stacked) labels fall through naturally with no marker.
//   • otherwise (string-literal labels, mixed, or anything else)  ⇒  an `if / else-if` chain;
//     `==` comparisons against each label, stacked empty labels OR-joined, `default` ⇒ the
//     trailing `else`. A trailing `break` in a case body is stripped (illegal outside a switch).

/** A case test is integral/enum-looking when it is a numeric literal or an enum member access. */
function looksIntegral(test: IRExpression): boolean {
    return (test.kind === "literal" && typeof test.value === "number") || test.kind === "member";
}

/** A case body that ends in one of these terminates the case (so no `[[fallthrough]]` is needed). */
function terminates(body: readonly IRStatement[]): boolean {
    const last = body[body.length - 1];
    return last !== undefined && (last.kind === "break" || last.kind === "return" || last.kind === "continue");
}

function switchToCpp(stmt: IRSwitchStmt, indent: string, ret: ReturnLowerer, opts?: ExprOpts): string {
    const tests = stmt.cases.map((c) => c.test).filter((t): t is IRExpression => t !== null);
    const native = tests.length > 0 && tests.every(looksIntegral);
    return native
        ? nativeSwitchToCpp(stmt, indent, ret, opts)
        : ifChainSwitchToCpp(stmt, indent, ret, opts);
}

/** Native `switch (disc) { case L: { … } [[fallthrough]]; … }` for integral/enum discriminants. */
function nativeSwitchToCpp(stmt: IRSwitchStmt, indent: string, ret: ReturnLowerer, opts?: ExprOpts): string {
    const disc = exprToCpp(stmt.discriminant, opts);
    const caseIndent = indent + "    ";
    const lines: string[] = [`${indent}switch (${disc}) {`];
    stmt.cases.forEach((c, i) => {
        const label = c.test === null ? "default" : `case ${exprToCpp(c.test, opts)}`;
        if (c.body.length === 0) {
            // Empty (stacked) label — falls through to the next case with no marker.
            lines.push(`${caseIndent}${label}:`);
            return;
        }
        // Brace the body so per-case declarations are scoped (avoids "jump crosses init").
        lines.push(`${caseIndent}${label}: {`);
        for (const s of c.body) lines.push(stmtToCpp(s, caseIndent + "    ", ret, opts));
        lines.push(`${caseIndent}}`);
        // `[[fallthrough]];` lives AFTER the braced body, immediately before the next case label
        // (where the attribute is well-formed), only when this case actually falls through.
        if (i < stmt.cases.length - 1 && !terminates(c.body)) lines.push(`${caseIndent}[[fallthrough]];`);
    });
    lines.push(`${indent}}`);
    return lines.join("\n");
}

/** Drop a single trailing `break` (illegal in an if/else body) from a case's statements. */
function stripTrailingBreak(body: readonly IRStatement[]): IRStatement[] {
    const out = body.slice();
    if (out.length > 0 && out[out.length - 1]!.kind === "break") out.pop();
    return out;
}

/** `if (disc == L1 || disc == L2) { … } else if … else { default }` for string/other discriminants. */
function ifChainSwitchToCpp(stmt: IRSwitchStmt, indent: string, ret: ReturnLowerer, opts?: ExprOpts): string {
    const disc = exprToCpp(stmt.discriminant, opts);

    // Group stacked empty-bodied labels onto the next non-empty body.
    type Group = { tests: (IRExpression | null)[]; body: IRStatement[] };
    const groups: Group[] = [];
    let pending: (IRExpression | null)[] = [];
    for (const c of stmt.cases) {
        pending.push(c.test);
        if (c.body.length > 0) { groups.push({ tests: pending, body: c.body }); pending = []; }
    }
    if (pending.length > 0) groups.push({ tests: pending, body: [] });

    const branches: { tests: IRExpression[]; body: IRStatement[] }[] = [];
    let defaultBody: IRStatement[] | undefined;
    for (const g of groups) {
        if (g.tests.some((t) => t === null)) defaultBody = g.body;
        else branches.push({ tests: g.tests as IRExpression[], body: g.body });
    }

    const parts: string[] = [];
    branches.forEach((b, i) => {
        const cond = b.tests.map((t) => `${disc} == ${exprToCpp(t, opts)}`).join(" || ");
        const body = blockBody(stripTrailingBreak(b.body), indent, ret, opts);
        const head = i === 0 ? `${indent}if (${cond}) {` : ` else if (${cond}) {`;
        parts.push(`${head}\n${body}${indent}}`);
    });
    let out = parts.join("");
    if (defaultBody !== undefined) {
        const body = blockBody(stripTrailingBreak(defaultBody), indent, ret, opts);
        out += branches.length > 0 ? ` else {\n${body}${indent}}` : `${indent}{\n${body}${indent}}`;
    }
    return out;
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
