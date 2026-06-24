import type {
    IRValidatorDeclaration,
    IRFormatterDeclaration,
    IRFunctionDeclaration,
    IRStatement,
} from "@keyma/ir";
import { exprToPython } from "./emit-expression.js";
import { irTypeGuard, irTypeLabel } from "./ir-type-to-python.js";
import { emitLiteral } from "./emit-literal.js";

/** A factory identifier safe for a Python binding. */
export function factoryIdent(name: string): string {
    return name.replace(/-/g, "_");
}

/** Standard import header for generated validator/formatter/function modules. */
function moduleHeader(hasFunctions: boolean): string[] {
    const lines = ["from datetime import datetime, timezone", "import re"];
    if (hasFunctions) lines.push("from .functions import *");
    lines.push("", "");
    return lines;
}

/**
 * Rewrite portable cross-field access `<ctx>.object.<field>` to a Python dict lookup
 * `<ctx>.object.get("<field>")`. The Python runtime hands validators/formatters a
 * context whose `.object` is the record **dict**, so generic member lowering
 * (`ctx.object.field`) would be attribute access on a dict and fail at runtime.
 * No-op when the inner function declares no context parameter.
 */
export function rewriteContextAccess(code: string, ctxParam: string | undefined): string {
    if (ctxParam === undefined) return code;
    const re = new RegExp(`\\b${ctxParam}\\.object\\.([A-Za-z_][A-Za-z0-9_]*)`, "g");
    return code.replace(re, `${ctxParam}.object.get("$1")`);
}

/**
 * Render a factory parameter for the def signature. An optional param (a `?` or default
 * in the source factory) gets `=None` so a call site may omit it; the lowered body
 * already guards such params (e.g. `flags or ""`), mirroring the JS source.
 */
function pyFactoryParam(p: { name: string; optional?: boolean }): string {
    return p.optional === true ? `${p.name}=None` : p.name;
}

/** Build the factory call that materializes a validator/formatter, e.g. `min_length(2)`. */
export function buildFactoryCall(
    name: string,
    params: Record<string, unknown> | undefined,
    factoryParams: readonly { name: string }[],
): string {
    const args = factoryParams.map((p) => params?.[p.name]);
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    return `${factoryIdent(name)}(${args.map((a) => emitLiteral(a)).join(", ")})`;
}

// ─── Validators (validators.py) ────────────────────────────────────────────────

export function emitValidatorsPy(decls: readonly IRValidatorDeclaration[], hasFunctions: boolean): string {
    return [...moduleHeader(hasFunctions), ...decls.map(emitValidatorFactory)].join("\n");
}

function emitValidatorFactory(decl: IRValidatorDeclaration): string {
    const factoryParamList = decl.factoryParams.map(pyFactoryParam).join(", ");
    const innerParamList = decl.body.params.map((p) => p.name).join(", ");
    const valueParam = decl.body.params.find((p) => p.role === "value")?.name ?? "_value";
    const fieldParam = decl.body.params.find((p) => p.role === "field")?.name ?? "None";
    const ctxParam = decl.body.params.find((p) => p.role === "context")?.name;

    const lines = [`def ${factoryIdent(decl.name)}(${factoryParamList}):`, `    def _v(${innerParamList}):`];
    const guard = irTypeGuard(decl.inputType, valueParam);
    if (guard !== null) {
        const message = JSON.stringify(`expected ${irTypeLabel(decl.inputType)}`);
        lines.push(`        if not (${guard}):`);
        lines.push(`            return {"field": ${fieldParam}, "code": "type_error", "message": ${message}}`);
    }
    for (const stmt of decl.body.statements) lines.push(rewriteContextAccess(stmtToPython(stmt, "        "), ctxParam));
    lines.push(`    return _v`, "");
    return lines.join("\n");
}

// ─── Formatters (formatters.py) ─────────────────────────────────────────────────

export function emitFormattersPy(decls: readonly IRFormatterDeclaration[], hasFunctions: boolean): string {
    return [...moduleHeader(hasFunctions), ...decls.map(emitFormatterFactory)].join("\n");
}

function emitFormatterFactory(decl: IRFormatterDeclaration): string {
    const factoryParamList = decl.factoryParams.map(pyFactoryParam).join(", ");
    const innerParamList = decl.body.params.map((p) => p.name).join(", ");
    const valueParam = decl.body.params.find((p) => p.role === "value")?.name ?? "_value";
    const ctxParam = decl.body.params.find((p) => p.role === "context")?.name;

    const lines = [`def ${factoryIdent(decl.name)}(${factoryParamList}):`, `    def _f(${innerParamList}):`];
    const guard = irTypeGuard(decl.inputType, valueParam);
    if (guard !== null) {
        const msg = `${decl.name} formatter expected ${irTypeLabel(decl.inputType)}, got `;
        lines.push(`        if not (${guard}):`);
        lines.push(`            raise TypeError(${JSON.stringify(msg)} + type(${valueParam}).__name__)`);
    }
    for (const stmt of decl.body.statements) lines.push(rewriteContextAccess(stmtToPython(stmt, "        "), ctxParam));
    lines.push(`    return _f`, "");
    return lines.join("\n");
}

// ─── Utility functions (functions.py) ───────────────────────────────────────────

export function emitFunctionsPy(declarations: readonly IRFunctionDeclaration[]): string {
    const lines: string[] = moduleHeader(false);
    for (const decl of declarations) {
        const params = decl.params.map((p) => p.name).join(", ");
        lines.push(`def ${decl.name}(${params}):`);
        if (decl.statements.length === 0) {
            lines.push("    pass");
        } else {
            for (const stmt of decl.statements) lines.push(stmtToPython(stmt, "    "));
        }
        lines.push("");
    }
    return lines.join("\n");
}

// ─── Statement lowering ──────────────────────────────────────────────────────

export function stmtToPython(stmt: IRStatement, indent: string): string {
    switch (stmt.kind) {
        case "return":
            return stmt.value === null ? `${indent}return` : `${indent}return ${exprToPython(stmt.value)}`;
        case "if": {
            const cond = exprToPython(stmt.condition);
            const then = stmt.consequent.map((s) => stmtToPython(s, indent + "    ")).join("\n");
            let out = `${indent}if ${cond}:\n${then}`;
            if (stmt.alternate && stmt.alternate.length > 0) {
                const alt = stmt.alternate.map((s) => stmtToPython(s, indent + "    ")).join("\n");
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
    }
}
