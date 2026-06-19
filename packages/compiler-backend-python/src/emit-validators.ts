import type { IRValidatorDeclaration, IRFormatterDeclaration, IRStatement } from "@keyma/ir";
import { exprToPython } from "./emit-expression.js";

export type ValidatorEmitFiles = {
    factoriesPy: string;
    registryPy: string;
};

export type FormatterEmitFiles = {
    factoriesPy: string;
    registryPy: string;
};

// ─── Validators ───────────────────────────────────────────────────────────────

export function emitValidatorFiles(declarations: IRValidatorDeclaration[]): ValidatorEmitFiles {
    return {
        factoriesPy: emitValidatorFactoriesPy(declarations),
        registryPy: emitValidatorRegistryPy(declarations),
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

function emitValidatorRegistryPy(declarations: IRValidatorDeclaration[]): string {
    const lines: string[] = [];
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

export function emitFormatterFiles(declarations: IRFormatterDeclaration[]): FormatterEmitFiles {
    return {
        factoriesPy: emitFormatterFactoriesPy(declarations),
        registryPy: emitFormatterRegistryPy(declarations),
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

function emitFormatterRegistryPy(declarations: IRFormatterDeclaration[]): string {
    const lines: string[] = [];
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


// ─── Statement lowering ───────────────────────────────────────────────────────

function stmtToPython(stmt: IRStatement, indent: string): string {
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
