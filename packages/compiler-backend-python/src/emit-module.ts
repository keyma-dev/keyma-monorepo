import type { IRSchema, IRField, IRType, IRMethod, IRExpression, IRStatement, IRValidatorDeclaration, IRFormatterDeclaration } from "@keyma/ir";
import { exprToPython } from "./emit-expression.js";
import { stmtToPython, factoryIdent } from "./emit-validators.js";
import { irTypeToPython } from "./ir-type-to-python.js";
import { buildSchemaData, buildMaterializer } from "./schema-data.js";
import { buildApplyDefaults } from "./emit-defaults.js";
import { emitLiteral } from "./emit-literal.js";
import { pythonRelImport } from "./module-path.js";

export type ModuleEmitDeps = {
    includePrivate: boolean;
    includeIndexes: boolean;
    emitMaterializers: boolean;
    formPhasesOnly: boolean;
    includeDefaults: boolean;
    /** sourceName → bundle-relative module ref (e.g. "models/user/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** Reference/embedded/edge target `name` → emitted Python class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    validatorDecls: ReadonlyMap<string, IRValidatorDeclaration>;
    formatterDecls: ReadonlyMap<string, IRFormatterDeclaration>;
    functionNames: ReadonlySet<string>;
    validatorsModuleRef: string;
    formattersModuleRef: string;
    functionsModuleRef: string;
};

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

export function emitModulePython(moduleRef: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps): string {
    const lines: string[] = [
        "from __future__ import annotations",
        "from typing import Any, List, Optional, Literal, Dict",
        "from datetime import datetime, timezone",
        "import re",
        "",
    ];
    lines.push(...buildImports(moduleRef, schemas, deps));
    lines.push("", "");

    for (const schema of schemas) {
        lines.push(...emitSchemaClass(schema, deps));
        lines.push("");
    }
    return lines.join("\n");
}

function emitSchemaClass(schema: IRSchema, deps: ModuleEmitDeps): string[] {
    const fields = visibleFields(schema, deps.includePrivate);
    const lines: string[] = [];

    const extendsClause = schema.extends !== undefined ? `(${schema.extends})` : "";
    lines.push(`class ${schema.sourceName}${extendsClause}:`);
    lines.push(`    def __init__(self, value: Dict[str, Any] = None):`);
    if (schema.extends !== undefined) lines.push(`        super().__init__(value)`);
    lines.push(`        if value:`);
    let assigned = false;
    for (const field of fields) {
        if (field.computed !== undefined) continue;
        lines.push(`            self.${field.name}: ${fieldAnnotation(field, deps.classNameByName)} = value.get("${field.name}")`);
        assigned = true;
    }
    if (!assigned && schema.extends === undefined) lines.push(`            pass`);

    const computedNames = new Set<string>();
    for (const field of fields) {
        if (field.computed === undefined) continue;
        computedNames.add(field.name);
        lines.push("");
        lines.push(`    @property`);
        lines.push(`    def ${field.name}(self) -> ${fieldAnnotation(field, deps.classNameByName)}:`);
        lines.push(`        return ${exprToPython(field.computed.expression)}`);
    }

    for (const method of visibleMethods(schema, deps.includePrivate)) {
        lines.push("");
        lines.push(...emitMethodPython(method, computedNames));
    }
    lines.push("");

    // Module-level applyDefaults function (referenced from the metadata) — server bundles.
    let applyDefaultsRef: string | undefined;
    if (deps.includeDefaults) {
        const ad = buildApplyDefaults(schema, deps.includePrivate);
        if (ad !== null) {
            lines.push(ad.def, "");
            applyDefaultsRef = ad.name;
        }
    }

    const schemaData = buildSchemaData(schema, {
        includePrivate: deps.includePrivate,
        includeIndexes: deps.includeIndexes,
        formPhasesOnly: deps.formPhasesOnly,
        validatorDecls: deps.validatorDecls,
        formatterDecls: deps.formatterDecls,
        refs: schemaRefs(fields, deps.classNameByName),
        ...(applyDefaultsRef !== undefined ? { applyDefaultsRef } : {}),
    });
    lines.push(`${schema.sourceName}.schema = ${emitLiteral(schemaData)}`);

    if (deps.emitMaterializers) {
        const materializer = buildMaterializer(schema, deps.includePrivate);
        if (materializer !== null) {
            lines.push("");
            lines.push(materializer);
        }
    }
    return lines;
}

// ─── Imports ──────────────────────────────────────────────────────────────────

function buildImports(moduleRef: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps): string[] {
    const bySpec = new Map<string, Set<string>>();
    const add = (toRef: string, binding: string): void => {
        if (toRef === moduleRef) return;
        const { prefix, module } = pythonRelImport(moduleRef, toRef);
        const spec = `from ${prefix}${module} import`;
        if (!bySpec.has(spec)) bySpec.set(spec, new Set());
        bySpec.get(spec)!.add(binding);
    };

    const allFields: IRField[] = schemas.flatMap((s) => visibleFields(s, deps.includePrivate));

    for (const s of schemas) {
        if (s.extends !== undefined) {
            const ref = deps.schemaModule.get(s.extends);
            if (ref !== undefined) add(ref, s.extends);
        }
    }
    for (const target of collectRefTargets(allFields)) {
        // Targets are identities (`name`); resolve to the emitted class + its module.
        const className = deps.classNameByName.get(target);
        if (className === undefined) continue;
        const ref = deps.schemaModule.get(className);
        if (ref !== undefined) add(ref, className);
    }
    for (const n of collectFactoryNames(allFields, "validators", deps.formPhasesOnly)) add(deps.validatorsModuleRef, factoryIdent(n));
    for (const n of collectFactoryNames(allFields, "formatters", deps.formPhasesOnly)) add(deps.formattersModuleRef, factoryIdent(n));
    for (const n of collectFunctionRefs(schemas, deps)) add(deps.functionsModuleRef, n);

    return [...bySpec.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([spec, bindings]) => `${spec} ${[...bindings].sort().join(", ")}`);
}

/** Embedded/reference targets of a field list as `{ name, className }` pairs for
 *  the live `refs` dict — keyed by the target's `name`, valued by its Python class. */
function schemaRefs(
    fields: IRField[],
    classNameByName: ReadonlyMap<string, string>,
): { name: string; className: string }[] {
    return [...collectRefTargets(fields)]
        .filter((t) => classNameByName.has(t))
        .map((name) => ({ name, className: classNameByName.get(name)! }));
}

function collectRefTargets(fields: IRField[]): Set<string> {
    const out = new Set<string>();
    const collect = (type: IRType): void => {
        if (type.kind === "embedded" || type.kind === "reference") out.add(type.schema);
        else if (type.kind === "array") collect(type.of);
    };
    for (const f of fields) collect(f.type);
    return out;
}

function collectFactoryNames(fields: IRField[], which: "validators" | "formatters", formPhasesOnly: boolean): Set<string> {
    const out = new Set<string>();
    for (const f of fields) {
        if (which === "validators") for (const v of f.validators) out.add(v.name);
        else for (const fmt of f.formatters) { if (formPhasesOnly && !CLIENT_PHASES.has(fmt.phase)) continue; out.add(fmt.spec.name); }
    }
    return out;
}

function collectFunctionRefs(schemas: readonly IRSchema[], deps: ModuleEmitDeps): Set<string> {
    const ids = new Set<string>();
    for (const schema of schemas) {
        for (const field of visibleFields(schema, deps.includePrivate)) {
            if (field.computed !== undefined) collectIdentifiers(field.computed.expression, ids);
            if (deps.includeDefaults && field.default !== undefined && field.default.kind === "expression") {
                collectIdentifiers(field.default.expression, ids);
            }
        }
        for (const method of visibleMethods(schema, deps.includePrivate)) {
            for (const stmt of method.statements) collectStatementIdentifiers(stmt, ids);
        }
    }
    return new Set([...ids].filter((id) => deps.functionNames.has(id)));
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
            collectIdentifiers(expr.condition, out); collectIdentifiers(expr.whenTrue, out); collectIdentifiers(expr.whenFalse, out); break;
        case "object": expr.properties.forEach((p) => collectIdentifiers(p.value, out)); break;
        case "arrow": collectIdentifiers(expr.body, out); break;
        case "intrinsic": if (expr.receiver) collectIdentifiers(expr.receiver, out); expr.args.forEach((a) => collectIdentifiers(a, out)); break;
    }
}

function collectStatementIdentifiers(stmt: IRStatement, out: Set<string>): void {
    switch (stmt.kind) {
        case "return": if (stmt.value) collectIdentifiers(stmt.value, out); break;
        case "expression": collectIdentifiers(stmt.expr, out); break;
        case "const": collectIdentifiers(stmt.init, out); break;
        case "assign": collectIdentifiers(stmt.target, out); collectIdentifiers(stmt.value, out); break;
        case "if":
            collectIdentifiers(stmt.condition, out);
            stmt.consequent.forEach((s) => collectStatementIdentifiers(s, out));
            (stmt.alternate ?? []).forEach((s) => collectStatementIdentifiers(s, out));
            break;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function visibleFields(schema: IRSchema, includePrivate: boolean): IRField[] {
    return includePrivate ? schema.fields : schema.fields.filter((f) => f.visibility === "public");
}

function visibleMethods(schema: IRSchema, includePrivate: boolean): IRMethod[] {
    const methods = schema.methods ?? [];
    return includePrivate ? methods : methods.filter((m) => m.visibility === "public");
}

function emitMethodPython(method: IRMethod, computedNames: ReadonlySet<string>): string[] {
    const lines: string[] = [];
    const body = method.statements.length === 0 ? ["        pass"] : method.statements.map((s) => stmtToPython(s, "        "));

    if (method.kind === "setter") {
        const valueParam = method.params[0]?.name ?? "value";
        if (computedNames.has(method.name)) {
            lines.push(`    @${method.name}.setter`, `    def ${method.name}(self, ${valueParam}):`, ...body);
        } else {
            const helper = `_set_${method.name}`;
            lines.push(`    def ${helper}(self, ${valueParam}):`, ...body, `    ${method.name} = property(None, ${helper})`);
        }
        return lines;
    }
    const params = ["self", ...method.params.map((p) => p.name)].join(", ");
    lines.push(`    def ${method.name}(${params}):`, ...body);
    return lines;
}

function fieldAnnotation(field: IRField, classNameByName: ReadonlyMap<string, string>): string {
    const core = irTypeToPython(field.type, classNameByName);
    if (field.nullable || !field.required) return core.startsWith("Optional[") ? core : `Optional[${core}]`;
    return core;
}
