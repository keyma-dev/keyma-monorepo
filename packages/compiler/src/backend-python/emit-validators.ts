import type {
    IRStatement,
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
        default:
            // Additive IR vocabulary (forOf/while/break/continue/switch) emitted in a later slice.
            throw new Error(`stmtToPython: unsupported IR statement kind "${(stmt as { kind: string }).kind}"`);
    }
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
