import type {
    IRValidatorDeclaration,
    IRFormatterDeclaration,
    IRFunctionDeclaration,
    IRStatement,
} from "@keyma/ir";
import { exprToPython } from "./emit-expression.js";
import { irTypeGuard, irTypeLabel } from "./ir-type-to-python.js";

export type ValidatorEmitFiles = {
    factoriesPy: string;
    registryPy: string;
};

export type FormatterEmitFiles = {
    factoriesPy: string;
    registryPy: string;
};

export type RegistryOptions = {
    /** Whether a sibling `functions.py` exists to import compiled utility functions from. */
    hasFunctions: boolean;
};

/** Standard import header for generated registry/function modules. */
function moduleHeader(hasFunctions: boolean): string[] {
    const lines = ["from datetime import datetime", "import re"];
    if (hasFunctions) lines.push("from .functions import *");
    lines.push("");
    return lines;
}

// ─── Validators ───────────────────────────────────────────────────────────────

export function emitValidatorFiles(
    declarations: IRValidatorDeclaration[],
    opts: RegistryOptions,
): ValidatorEmitFiles {
    return {
        factoriesPy: emitValidatorFactoriesPy(declarations),
        registryPy: emitValidatorRegistryPy(declarations, opts),
    };
}

function emitValidatorFactoriesPy(declarations: IRValidatorDeclaration[]): string {
    if (declarations.length === 0) return "";
    const lines: string[] = [];
    for (const decl of declarations) {
        const funcName = decl.name.replace(/-/g, "_");
        if (decl.factoryParams.length === 0) {
            lines.push(`def ${funcName}():`);
            lines.push(`    return { "__validatorName": ${JSON.stringify(decl.name)} }`);
        } else {
            const paramList = decl.factoryParams.map((p) => p.name).join(", ");
            const paramsObj = `{ ${decl.factoryParams.map((p) => `"${p.name}": ${p.name}`).join(", ")} }`;
            lines.push(`def ${funcName}(${paramList}):`);
            lines.push(`    return { "__validatorName": ${JSON.stringify(decl.name)}, "params": ${paramsObj} }`);
        }
        lines.push("");
    }
    return lines.join("\n");
}

function emitValidatorRegistryPy(declarations: IRValidatorDeclaration[], opts: RegistryOptions): string {
    const lines: string[] = moduleHeader(opts.hasFunctions);
    const entries: string[] = [];
    for (const decl of declarations) {
        const { valueParam, fieldParam, ctxParam } = resolveInnerParams(decl.body.params);
        const specParam = "spec";
        const paramNames = [valueParam, specParam, fieldParam, ctxParam].filter(Boolean);
        const funcName = `_validate_${decl.name.replace(/-/g, "_")}`;

        lines.push(`def ${funcName}(${paramNames.join(", ")}):`);
        for (const p of decl.factoryParams) {
            lines.push(`    ${p.name} = ${specParam}.get("${p.name}")`);
        }
        // Runtime input guard: reject values that do not match the declared input type.
        const guard = irTypeGuard(decl.inputType, valueParam);
        if (guard !== null) {
            lines.push(`    if not (${guard}):`);
            lines.push(`        return ${JSON.stringify(`expected ${irTypeLabel(decl.inputType)}`)}`);
        }
        for (const stmt of decl.body.statements) {
            lines.push(stmtToPython(stmt, "    "));
        }
        lines.push("");
        entries.push(`${JSON.stringify(decl.name)}: ${funcName}`);
    }
    
    lines.push(`def create_validator_registry():`);
    lines.push(`    return {`);
    for (const entry of entries) {
        lines.push(`        ${entry},`);
    }
    lines.push(`    }`);
    
    return lines.join("\n");
}

// Actually, I'll put all these internal validator functions in the registry file.

// ─── Formatters ───────────────────────────────────────────────────────────────

export function emitFormatterFiles(
    declarations: IRFormatterDeclaration[],
    opts: RegistryOptions,
): FormatterEmitFiles {
    return {
        factoriesPy: emitFormatterFactoriesPy(declarations),
        registryPy: emitFormatterRegistryPy(declarations, opts),
    };
}

function emitFormatterFactoriesPy(declarations: IRFormatterDeclaration[]): string {
    if (declarations.length === 0) return "";
    const lines: string[] = [];
    for (const decl of declarations) {
        const funcName = decl.name.replace(/-/g, "_");
        if (decl.factoryParams.length === 0) {
            lines.push(`def ${funcName}():`);
            lines.push(`    return { "__formatterName": ${JSON.stringify(decl.name)} }`);
        } else {
            const paramList = decl.factoryParams.map((p) => p.name).join(", ");
            const paramsObj = `{ ${decl.factoryParams.map((p) => `"${p.name}": ${p.name}`).join(", ")} }`;
            lines.push(`def ${funcName}(${paramList}):`);
            lines.push(`    return { "__formatterName": ${JSON.stringify(decl.name)}, "params": ${paramsObj} }`);
        }
        lines.push("");
    }
    return lines.join("\n");
}

function emitFormatterRegistryPy(declarations: IRFormatterDeclaration[], opts: RegistryOptions): string {
    const lines: string[] = moduleHeader(opts.hasFunctions);
    const entries: string[] = [];
    for (const decl of declarations) {
        const { valueParam, ctxParam } = resolveInnerParams(decl.body.params);
        const specParam = "spec";
        const paramNames = [valueParam, specParam, ctxParam].filter(Boolean);
        const funcName = `_format_${decl.name.replace(/-/g, "_")}`;

        lines.push(`def ${funcName}(${paramNames.join(", ")}):`);
        for (const p of decl.factoryParams) {
            lines.push(`    ${p.name} = ${specParam}.get("${p.name}")`);
        }
        // Runtime input guard: formatters raise on a type mismatch.
        const guard = irTypeGuard(decl.inputType, valueParam);
        if (guard !== null) {
            const msg = `${decl.name} formatter expected ${irTypeLabel(decl.inputType)}, got `;
            lines.push(`    if not (${guard}):`);
            lines.push(`        raise TypeError(${JSON.stringify(msg)} + type(${valueParam}).__name__)`);
        }
        for (const stmt of decl.body.statements) {
            lines.push(stmtToPython(stmt, "    "));
        }
        lines.push("");
        entries.push(`${JSON.stringify(decl.name)}: ${funcName}`);
    }
    
    lines.push(`def create_formatter_registry():`);
    lines.push(`    return {`);
    for (const entry of entries) {
        lines.push(`        ${entry},`);
    }
    lines.push(`    }`);
    
    return lines.join("\n");
}


// ─── Utility functions ─────────────────────────────────────────────────────────

/** Emit project-local utility functions (referenced from validator/formatter bodies). */
export function emitFunctionsPy(declarations: IRFunctionDeclaration[]): string {
    const lines: string[] = moduleHeader(false);
    for (const decl of declarations) {
        const params = decl.params.map((p) => p.name).join(", ");
        lines.push(`def ${decl.name}(${params}):`);
        if (decl.statements.length === 0) {
            lines.push("    pass");
        } else {
            for (const stmt of decl.statements) {
                lines.push(stmtToPython(stmt, "    "));
            }
        }
        lines.push("");
    }
    return lines.join("\n");
}

// ─── Statement lowering ───────────────────────────────────────────────────────

/**
 * Lower an IR statement to a Python source line. Shared by validator/formatter
 * registries, compiled utility functions, and method/setter behavior bodies.
 */
export function stmtToPython(stmt: IRStatement, indent: string): string {
    switch (stmt.kind) {
        case "return":
            return stmt.value === null
                ? `${indent}return`
                : `${indent}return ${exprToPython(stmt.value)}`;

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

type InnerParamNames = {
    valueParam: string;
    fieldParam: string;
    ctxParam: string;
};

function resolveInnerParams(params: Array<{ name: string; role: string }>): InnerParamNames {
    let valueParam = "_value";
    let fieldParam = "_field";
    let ctxParam = "_ctx";
    for (const p of params) {
        if (p.role === "value") valueParam = p.name;
        else if (p.role === "field") fieldParam = p.name;
        else if (p.role === "context") ctxParam = p.name;
    }
    return { valueParam, fieldParam, ctxParam };
}
