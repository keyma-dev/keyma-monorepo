import type {
    IRExpression,
    IRStatement,
    IRSwitchStmt,
} from "@keyma/core/ir";
import { exprToPython, withHoist, type Hoist } from "./emit-expression.js";

/** A factory identifier safe for a Python binding. */
export function factoryIdent(name: string): string {
    return name.replace(/-/g, "_");
}

// ─── Statement lowering ──────────────────────────────────────────────────────

export function stmtToPython(stmt: IRStatement, indent: string): string {
    switch (stmt.kind) {
        case "return":
            return stmt.value === null ? `${indent}return` : `${indent}return ${exprToPython(stmt.value)}`;
        case "if": {
            const cond = exprToPython(stmt.condition);
            // Branch statements render through renderStatements so any block-arrow defs they hoist
            // land inside the branch (before the using statement), at the branch's indent.
            const then = renderStatements(stmt.consequent, indent + "    ");
            let out = `${indent}if ${cond}:\n${then}`;
            if (stmt.alternate && stmt.alternate.length > 0) {
                const alt = renderStatements(stmt.alternate, indent + "    ");
                out += `\n${indent}else:\n${alt}`;
            }
            return out;
        }
        case "const":
            return `${indent}${stmt.name} = ${exprToPython(stmt.init)}`;
        case "expression":
            return `${indent}${exprToPython(stmt.expr)}`;
        case "assign":
            return `${indent}${exprToPython(stmt.target)} = ${exprToPython(stmt.value)}`;
        case "forOf": {
            const iterable = exprToPython(stmt.iterable);
            return `${indent}for ${stmt.name} in ${iterable}:\n${indentedBody(stmt.body, indent)}`;
        }
        case "while": {
            const cond = exprToPython(stmt.condition);
            return `${indent}while ${cond}:\n${indentedBody(stmt.body, indent)}`;
        }
        case "break":
            return `${indent}break`;
        case "continue":
            return `${indent}continue`;
        case "switch":
            return switchToPython(stmt, indent);
        default:
            // Exhaustiveness guard for any future additive IR statement kind.
            throw new Error(`stmtToPython: unsupported IR statement kind "${(stmt as { kind: string }).kind}"`);
    }
}

/** Render a suite (loop / branch body) one level deeper, substituting `pass` for an empty body
 *  so the indented block is never syntactically empty. */
function indentedBody(body: readonly IRStatement[], indent: string): string {
    const inner = indent + "    ";
    return body.length === 0 ? `${inner}pass` : renderStatements(body, inner);
}

// ─── switch (012) ──────────────────────────────────────────────────────────────
//
// Two strategies, chosen by `canUseMatch`, never erroring:
//   • CLEAN  → Python 3.10+ `match`/`case`. Each arm's trailing `break` is dropped (match has
//              no fallthrough), and consecutive empty-label cases collapse to an or-pattern
//              (`case A | B:`).
//   • OTHER  → a desugar to `if/elif` (entry selection) + a one-shot `while True:` carrier so
//              source-faithful FALLTHROUGH and `break` semantics survive. Used when mid-body
//              fallthrough is present, a non-trailing switch-`break` exists, a case label isn't a
//              valid match value-pattern, or a `default` isn't the last arm.

/** Unique-suffix counter so nested/sibling desugared switches never share temp-var names. */
let switchSeq = 0;

function switchToPython(stmt: IRSwitchStmt, indent: string): string {
    return canUseMatch(stmt) ? renderSwitchMatch(stmt, indent) : renderSwitchIfElif(stmt, indent);
}

/** Whether a case body terminates its arm (last top-level statement is `break` or `return`),
 *  i.e. it does NOT fall through into the next case. */
function bodyTerminates(body: readonly IRStatement[]): boolean {
    const last = body[body.length - 1];
    return last !== undefined && (last.kind === "break" || last.kind === "return");
}

/** Count `break`s that belong to THIS switch — i.e. excluding breaks nested inside loops or a
 *  nested switch (those bind elsewhere). Recurses only into `if` branches. */
function switchBreakCount(stmts: readonly IRStatement[]): number {
    let n = 0;
    for (const s of stmts) {
        if (s.kind === "break") n++;
        else if (s.kind === "if") {
            n += switchBreakCount(s.consequent);
            if (s.alternate !== undefined) n += switchBreakCount(s.alternate);
        }
        // forOf/while/switch own their breaks → do not recurse.
    }
    return n;
}

/** True when a case body has a switch-`break` somewhere other than as its final statement —
 *  `match` cannot host such a break (it is not a loop), so the switch must desugar instead. */
function hasNonTrailingSwitchBreak(body: readonly IRStatement[]): boolean {
    const trailing = body.length > 0 && body[body.length - 1]!.kind === "break" ? 1 : 0;
    return switchBreakCount(body) > trailing;
}

/** Whether a case label can appear as a Python `match` value-pattern: a literal, a `self.x`
 *  field, or a dotted name (enum/member chain). Anything else (bare identifier → capture
 *  pattern, calls, operators) is routed to the `==`-based if/elif desugar instead. */
function isMatchSafe(expr: IRExpression): boolean {
    if (expr.kind === "literal" || expr.kind === "field") return true;
    if (expr.kind === "member") return isDottedName(expr.object);
    return false;
}

function isDottedName(expr: IRExpression): boolean {
    if (expr.kind === "identifier" || expr.kind === "field") return true;
    if (expr.kind === "member") return isDottedName(expr.object);
    return false;
}

function canUseMatch(stmt: IRSwitchStmt): boolean {
    const cases = stmt.cases;
    const lastIndex = cases.length - 1;
    const defaultIdx = cases.findIndex((c) => c.test === null);
    // `match` wildcards must be last; a default elsewhere needs the ordered if/elif desugar.
    if (defaultIdx !== -1 && defaultIdx !== lastIndex) return false;
    for (let i = 0; i < cases.length; i++) {
        const c = cases[i]!;
        // Mid-body fallthrough: a non-empty, non-terminating case that is not the last arm.
        if (c.body.length > 0 && i < lastIndex && !bodyTerminates(c.body)) return false;
        if (hasNonTrailingSwitchBreak(c.body)) return false;
        if (c.test !== null && !isMatchSafe(c.test)) return false;
    }
    return true;
}

/** Render the or-pattern for one match arm; any `default` (null) collapses to a `_` wildcard. */
function casePattern(tests: readonly (IRExpression | null)[]): string {
    if (tests.some((t) => t === null)) return "_";
    return tests.map((t) => exprToPython(t!)).join(" | ");
}

function renderSwitchMatch(stmt: IRSwitchStmt, indent: string): string {
    const caseIndent = indent + "    ";
    const bodyIndent = indent + "        ";
    const lastIndex = stmt.cases.length - 1;
    const lines: string[] = [`${indent}match ${exprToPython(stmt.discriminant)}:`];

    let pending: (IRExpression | null)[] = []; // stacked empty-label tests awaiting a body
    const arm = (tests: (IRExpression | null)[], body: readonly IRStatement[]): void => {
        lines.push(`${caseIndent}case ${casePattern(tests)}:`);
        // Drop the implicit trailing break — `match` arms never fall through.
        const eff = body.length > 0 && body[body.length - 1]!.kind === "break" ? body.slice(0, -1) : body;
        lines.push(eff.length === 0 ? `${bodyIndent}pass` : renderStatements(eff, bodyIndent));
    };

    for (let i = 0; i < stmt.cases.length; i++) {
        const c = stmt.cases[i]!;
        if (c.body.length === 0 && i < lastIndex) {
            pending.push(c.test); // empty stacked label → folds into the next arm's or-pattern
            continue;
        }
        arm([...pending, c.test], c.body);
        pending = [];
    }
    if (pending.length > 0) arm(pending, []); // trailing empty labels with no following body

    return lines.join("\n");
}

/**
 * Desugar a switch with fallthrough/non-match-safe labels to an `if/elif` entry selector plus a
 * one-shot `while True:` carrier. The selector picks the FIRST matching label (or the default's
 * index, or -1); the carrier runs every case body from that index onward (`if _idx <= i`),
 * reproducing fallthrough. A native `break` in a body exits the `while` (= switch break) and a
 * `return` exits the function. Caveat: a top-level `continue` meant for an enclosing loop would
 * bind to this carrier — an exotic construct, accepted here in exchange for correct break/default.
 */
function renderSwitchIfElif(stmt: IRSwitchStmt, indent: string): string {
    const sid = switchSeq++;
    const disc = `_kdisc${sid}`;
    const idx = `_kidx${sid}`;
    const inner = indent + "    ";
    const body2 = indent + "        ";
    const lines: string[] = [
        `${indent}${disc} = ${exprToPython(stmt.discriminant)}`,
        `${indent}${idx} = -1`,
    ];

    // Entry selection: first matching label wins; default (if any) is the fallback.
    let first = true;
    for (let i = 0; i < stmt.cases.length; i++) {
        const c = stmt.cases[i]!;
        if (c.test === null) continue;
        lines.push(`${indent}${first ? "if" : "elif"} ${disc} == ${exprToPython(c.test)}:`);
        lines.push(`${inner}${idx} = ${i}`);
        first = false;
    }
    const defaultIdx = stmt.cases.findIndex((c) => c.test === null);
    if (defaultIdx !== -1) {
        if (first) lines.push(`${indent}${idx} = ${defaultIdx}`);
        else {
            lines.push(`${indent}else:`);
            lines.push(`${inner}${idx} = ${defaultIdx}`);
        }
    }

    // One-shot carrier: run bodies from the selected index downward, honoring break/fallthrough.
    lines.push(`${indent}while True:`);
    lines.push(`${inner}if ${idx} == -1:`);
    lines.push(`${body2}break`);
    for (let i = 0; i < stmt.cases.length; i++) {
        const c = stmt.cases[i]!;
        lines.push(`${inner}if ${idx} <= ${i}:`);
        lines.push(c.body.length === 0 ? `${body2}pass` : renderStatements(c.body, body2));
    }
    lines.push(`${inner}break`);

    return lines.join("\n");
}

/**
 * Render a statement list, draining block-arrow hoists per statement: each statement gets a
 * fresh hoist accumulator; any `def`s it produces are emitted (indented) immediately before
 * that statement. Output is byte-identical to a plain `stmtToPython` loop when no block arrows
 * are present.
 */
export function renderStatements(stmts: readonly IRStatement[], indent: string): string {
    const lines: string[] = [];
    for (const s of stmts) {
        const hoist: Hoist = { defs: [], n: { v: 0 } };
        const line = withHoist(hoist, () => stmtToPython(s, indent));
        for (const def of hoist.defs) {
            for (const dl of def.split("\n")) lines.push(dl === "" ? "" : indent + dl);
        }
        lines.push(line);
    }
    return lines.join("\n");
}
