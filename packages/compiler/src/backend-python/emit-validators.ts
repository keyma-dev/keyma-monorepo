import type {
    IRFunctionDeclaration,
    IRStatement,
} from "@keyma/core/ir";
import { exprToPython, intrinsicImports, withHoist, type Hoist } from "./emit-expression.js";

/** A factory identifier safe for a Python binding. */
export function factoryIdent(name: string): string {
    return name.replace(/-/g, "_");
}

/**
 * Standard import header for generated validator/formatter/function modules. `extra`
 * carries any math/coercion-intrinsic imports the body requires (computed from the
 * emitted body via `intrinsicImports`). Exported so the schema domain pack — which now
 * owns validator/formatter emission — reuses the same header.
 */
export function moduleHeader(hasFunctions: boolean, extra: readonly string[] = []): string[] {
    const lines = ["from datetime import datetime, timezone", "import re", ...extra];
    if (hasFunctions) lines.push("from .functions import *");
    lines.push("", "");
    return lines;
}

// ─── Utility functions (functions.py) ───────────────────────────────────────────
//
// The generic project-local function emitter. After the validator→function collapse this
// emits every function the bundle keeps in `functions.py` — plain utility helpers. The
// validator/formatter factories (also `IRFunctionDeclaration`s) are CLAIMED by the schema
// domain pack, which emits them with the runtime validator/formatter wrapper into
// validators.py/formatters.py, so the generic backend excludes their names from this set.

export function emitFunctionsPy(declarations: readonly IRFunctionDeclaration[]): string {
    const body: string[] = [];
    for (const decl of declarations) {
        const params = decl.params.map((p) => p.name).join(", ");
        body.push(`def ${decl.name}(${params}):`);
        if (decl.statements.length === 0) {
            body.push("    pass");
        } else {
            body.push(renderStatements(decl.statements, "    "));
        }
        body.push("");
    }
    return [...moduleHeader(false, intrinsicImports(body.join("\n"))), ...body].join("\n");
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
