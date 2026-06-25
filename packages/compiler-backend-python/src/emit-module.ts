import type { IRSchema, IRField, IRMethod, IRValidatorDeclaration, IRFormatterDeclaration } from "@keyma/ir";
import { collectRefTargets, collectFunctionRefs, filterVisibleFields, filterVisibleMethods } from "@keyma/compiler-util";
import { renderStatements, factoryIdent } from "./emit-validators.js";
import { intrinsicImports } from "./emit-expression.js";
import { irTypeToPython } from "./ir-type-to-python.js";
import { buildSchemaData } from "./schema-data.js";
import { buildApplyDefaults } from "./emit-defaults.js";
import { emitLiteral } from "./emit-literal.js";
import { pythonRelImport } from "./module-path.js";

export type ModuleEmitDeps = {
    includePrivate: boolean;
    includeIndexes: boolean;
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
    // Emit the class bodies first so the header can pull in only the math/coercion-intrinsic
    // imports they actually reference (getter/method/default expressions may use them).
    const body: string[] = [];
    for (const schema of schemas) {
        body.push(...emitSchemaClass(schema, deps));
        body.push("");
    }

    const lines: string[] = [
        "from __future__ import annotations",
        "from typing import Any, List, Optional, Literal, Dict",
        "from datetime import datetime, timezone",
        "import re",
        ...intrinsicImports(body.join("\n")),
        "",
    ];
    lines.push(...buildImports(moduleRef, schemas, deps));
    lines.push("", "");
    lines.push(...body);
    return lines.join("\n");
}

function emitSchemaClass(schema: IRSchema, deps: ModuleEmitDeps): string[] {
    const fields = filterVisibleFields(schema, deps.includePrivate);
    const lines: string[] = [];

    const extendsClause = schema.extends !== undefined ? `(${schema.extends})` : "";
    lines.push(`class ${schema.sourceName}${extendsClause}:`);
    lines.push(`    def __init__(self, value: Dict[str, Any] = None):`);
    if (schema.extends !== undefined) lines.push(`        super().__init__(value)`);
    lines.push(`        if value:`);
    let assigned = false;
    for (const field of fields) {
        lines.push(`            self.${field.name}: ${fieldAnnotation(field, deps.classNameByName)} = value.get("${field.name}")`);
        assigned = true;
    }
    if (!assigned && schema.extends === undefined) lines.push(`            pass`);

    // Getters, setters, and methods are all behaviors re-emitted as class members.
    // Emit getters first so a paired `@name.setter` follows its `@property`.
    const behaviors = filterVisibleMethods(schema, deps.includePrivate);
    const getterNames = new Set(behaviors.filter((m) => m.kind === "getter").map((m) => m.name));
    const ordered = [
        ...behaviors.filter((m) => m.kind === "getter"),
        ...behaviors.filter((m) => m.kind !== "getter"),
    ];
    for (const method of ordered) {
        lines.push("");
        lines.push(...emitMethodPython(method, getterNames, deps.classNameByName));
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

    const allFields: IRField[] = schemas.flatMap((s) => filterVisibleFields(s, deps.includePrivate));

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

function collectFactoryNames(fields: IRField[], which: "validators" | "formatters", formPhasesOnly: boolean): Set<string> {
    const out = new Set<string>();
    for (const f of fields) {
        if (which === "validators") for (const v of f.validators) out.add(v.name);
        else for (const fmt of f.formatters) { if (formPhasesOnly && !CLIENT_PHASES.has(fmt.phase)) continue; out.add(fmt.spec.name); }
    }
    return out;
}

function emitMethodPython(
    method: IRMethod,
    getterNames: ReadonlySet<string>,
    classNameByName: ReadonlyMap<string, string>,
): string[] {
    const lines: string[] = [];
    const body = method.statements.length === 0 ? ["        pass"] : [renderStatements(method.statements, "        ")];

    if (method.kind === "getter") {
        const ret = method.returnType !== undefined ? irTypeToPython(method.returnType, classNameByName) : "Any";
        lines.push(`    @property`, `    def ${method.name}(self) -> ${ret}:`, ...body);
        return lines;
    }
    if (method.kind === "setter") {
        const valueParam = method.params[0]?.name ?? "value";
        if (getterNames.has(method.name)) {
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
