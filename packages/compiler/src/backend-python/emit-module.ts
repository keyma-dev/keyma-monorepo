import type { IRClassDeclaration, IRField, IRMethod, IRFunctionDeclaration } from "@keyma/core/ir";
import { collectRefTargets, collectFunctionRefs, collectStatementIdentifiers, filterVisibleFields, filterVisibleMethods } from "@keyma/core/util";
import { renderStatements, factoryIdent } from "./emit-validators.js";
import { intrinsicImports } from "./emit-expression.js";
import { irTypeToPython } from "./ir-type-to-python.js";
import type { BuildSchemaData } from "./emitter-registry.js";
import { buildApplyDefaults } from "./emit-defaults.js";
import { emitLiteral } from "./emit-literal.js";
import { pythonRelImport } from "./module-path.js";

/** The declarations a single source module owns: the schema classes authored in the file plus
 *  the (reachable) functions homed in it — plain utility helpers and claimed validator/formatter
 *  factories alike. Either list may be empty (a function-only file still produces a module). */
export type ModuleContent = {
    classes: readonly IRClassDeclaration[];
    functions: readonly IRFunctionDeclaration[];
};

export type ModuleEmitDeps = {
    includePrivate: boolean;
    includeIndexes: boolean;
    formPhasesOnly: boolean;
    includeDefaults: boolean;
    /** sourceName → bundle-relative module ref (e.g. "src/user/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** Function name → bundle-relative module ref (e.g. "src/user", "vendor"). Covers every
     *  function the bundle keeps; cross-module function refs resolve through here. */
    functionModule: ReadonlyMap<string, string>;
    /** Reference/embedded/edge target `name` → emitted Python class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Every project-local function declaration keyed by name (a domain pack reads a
     *  validator/formatter factory's params for factory-call arg ordering). */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    /** Names of the functions rendered with the domain wrapper (validators/formatters) rather
     *  than as plain functions. The matching renderings come from `renderClaimedFunctions`. */
    claimedFunctionNames: ReadonlySet<string>;
    /** Domain-supplied builder of the per-schema `.schema` metadata dict (from the
     *  emitter registry's schema pack). Keeps the generic module emitter domain-agnostic. */
    buildSchemaData: BuildSchemaData;
    /** Render the claimed (validator/formatter) functions a module owns, with the domain
     *  wrapper, one rendered `def` block per declaration. Present when `claimedFunctionNames`
     *  is non-empty. */
    renderClaimedFunctions?: (decls: readonly IRFunctionDeclaration[]) => readonly string[];
};

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

/** Emit one source module `.py` with every declaration authored in a source file — schema
 *  classes plus the functions homed there (plain utilities and wrapped validator/formatter
 *  factories alike). A function-only file still produces a module. */
export function emitModulePython(moduleRef: string, content: ModuleContent, deps: ModuleEmitDeps): string {
    const claimedByName = renderClaimed(content, deps);

    // Emit the class + function bodies first so the header can pull in only the math/coercion-
    // intrinsic imports they actually reference (getter/method/default/factory bodies may use them).
    const body: string[] = [];
    for (const schema of orderClassesByInheritance(content.classes)) {
        body.push(...emitSchemaClass(schema, deps));
        body.push("");
    }
    for (const fn of content.functions) {
        const rendering = claimedByName.get(fn.name);
        body.push(rendering !== undefined ? rendering : emitFunctionPy(fn));
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
    lines.push(...buildImports(moduleRef, content, deps));
    lines.push("", "");
    lines.push(...body);
    return lines.join("\n");
}

/** Order a module's classes so a base class precedes any same-module subclass — Python executes
 *  top-to-bottom, so `Parent.schema` (and the `class Parent`) must be defined before a child's
 *  `class Child(Parent)` / `Child.schema = { base: Parent.schema }`. Cross-module parents come in
 *  via imports. */
function orderClassesByInheritance(classes: readonly IRClassDeclaration[]): IRClassDeclaration[] {
    const bySource = new Map(classes.map((c) => [c.sourceName, c]));
    const out: IRClassDeclaration[] = [];
    const seen = new Set<string>();
    const visit = (c: IRClassDeclaration): void => {
        if (seen.has(c.sourceName)) return;
        seen.add(c.sourceName);
        const parent = c.extends !== undefined ? bySource.get(c.extends) : undefined;
        if (parent !== undefined) visit(parent);
        out.push(c);
    };
    for (const c of classes) visit(c);
    return out;
}

/** Emit a plain project-local utility function as a module-level `def` (or `async def` when the
 *  declaration is async — its body may then use `await`; `returnType` is the unwrapped `T`). */
function emitFunctionPy(decl: IRFunctionDeclaration): string {
    const params = decl.params.map((p) => p.name).join(", ");
    const kw = decl.async === true ? "async def" : "def";
    const lines = [`${kw} ${decl.name}(${params}):`];
    if (decl.statements.length === 0) lines.push("    pass");
    else lines.push(renderStatements(decl.statements, "    "));
    return lines.join("\n");
}

/** Run the domain's claimed-function renderer over the claimed functions this module owns,
 *  returning a name→rendering map (empty when the module owns none). */
function renderClaimed(content: ModuleContent, deps: ModuleEmitDeps): Map<string, string> {
    const claimed = content.functions.filter((fn) => deps.claimedFunctionNames.has(fn.name));
    if (claimed.length === 0) return new Map();
    if (deps.renderClaimedFunctions === undefined) {
        throw new Error("module owns claimed functions but no renderClaimedFunctions hook was provided");
    }
    const renderings = deps.renderClaimedFunctions(claimed);
    return new Map(claimed.map((fn, i) => [fn.name, renderings[i]!]));
}

function emitSchemaClass(schema: IRClassDeclaration, deps: ModuleEmitDeps): string[] {
    const fields = filterVisibleFields(schema, deps.includePrivate);
    const lines: string[] = [];

    // Inheritance is real: `class Child(Parent)`. `extends` is the parent sourceName (emit symbol).
    const extendsClause = schema.extends !== undefined ? `(${schema.extends})` : "";
    lines.push(`class ${schema.sourceName}${extendsClause}:`);

    // Hydration is a STATIC factory (008), freeing `__init__` for a user-authored constructor:
    //   • `from_value` allocates via `__new__` (bypassing any user `__init__`) and delegates to
    //     `_hydrate`, returning the instance.
    //   • `_hydrate` chains to the base then assigns only this class's OWN fields — real
    //     inheritance, base-chain walked through `super()._hydrate(value)`.
    lines.push(`    @classmethod`);
    lines.push(`    def from_value(cls, value: Dict[str, Any] = None):`);
    lines.push(`        obj = cls.__new__(cls)`);
    lines.push(`        obj._hydrate(value)`);
    lines.push(`        return obj`);
    lines.push("");
    lines.push(`    def _hydrate(self, value: Dict[str, Any] = None):`);
    if (schema.extends !== undefined) lines.push(`        super()._hydrate(value)`);
    if (fields.length > 0) {
        lines.push(`        if value:`);
        for (const field of fields) {
            lines.push(`            self.${field.name}: ${fieldAnnotation(field, deps.classNameByName)} = value.get("${field.name}")`);
        }
    } else if (schema.extends === undefined) {
        // Fieldless base class: a valid no-op body.
        lines.push(`        pass`);
    }
    // (extends with no own fields → the body is just the super()._hydrate(value) call.)

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

    const schemaData = deps.buildSchemaData(schema, {
        includePrivate: deps.includePrivate,
        includeIndexes: deps.includeIndexes,
        formPhasesOnly: deps.formPhasesOnly,
        functionDecls: deps.functionDecls,
        refs: schemaRefs(fields, deps.classNameByName),
        ...(applyDefaultsRef !== undefined ? { applyDefaultsRef } : {}),
    });
    lines.push(`${schema.sourceName}.schema = ${emitLiteral(schemaData)}`);

    return lines;
}

// ─── Imports ──────────────────────────────────────────────────────────────────

function buildImports(moduleRef: string, content: ModuleContent, deps: ModuleEmitDeps): string[] {
    const bySpec = new Map<string, Set<string>>();
    const add = (toRef: string, binding: string): void => {
        if (toRef === moduleRef) return;
        const { prefix, module } = pythonRelImport(moduleRef, toRef);
        const spec = `from ${prefix}${module} import`;
        if (!bySpec.has(spec)) bySpec.set(spec, new Set());
        bySpec.get(spec)!.add(binding);
    };

    const schemas = content.classes;
    const allFields: IRField[] = schemas.flatMap((s) => filterVisibleFields(s, deps.includePrivate));

    // Cross-module schema base classes + embedded/reference class targets.
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

    // Functions referenced from this module — by field validator/formatter metadata, by class
    // behaviors/defaults, and by the bodies of the functions homed here — resolved to their
    // source module through `functionModule`. Same-module refs are skipped by `add`.
    const fnRefs = new Set<string>();
    for (const n of collectFactoryNames(allFields, "validators", deps.formPhasesOnly)) fnRefs.add(n);
    for (const n of collectFactoryNames(allFields, "formatters", deps.formPhasesOnly)) fnRefs.add(n);
    for (const n of collectFunctionRefs(schemas, {
        includePrivate: deps.includePrivate,
        includeDefaults: deps.includeDefaults,
        functionNames: new Set(deps.functionModule.keys()),
    })) fnRefs.add(n);
    for (const fn of content.functions) {
        const ids = new Set<string>();
        for (const stmt of fn.statements) collectStatementIdentifiers(stmt, ids);
        for (const id of ids) if (deps.functionModule.has(id)) fnRefs.add(id);
    }
    for (const n of fnRefs) {
        const ref = deps.functionModule.get(n);
        if (ref !== undefined) add(ref, factoryIdent(n));
    }

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

// Validator/formatter attachments now ride in the field's `extensions['schema']` slice
// (a schema-domain concern). The generic module emitter still needs the referenced factory
// names to wire the model file's imports from validators.py/formatters.py — a transitional
// read of the well-known slice keeps that import wiring here without depending on `@keyma/schema`.
type SchemaFieldSlice = {
    validators?: { name: string }[];
    formatters?: { phase: string; spec: { name: string } }[];
};
function schemaSlice(field: IRField): SchemaFieldSlice | undefined {
    return field.extensions?.["schema"] as SchemaFieldSlice | undefined;
}

export function collectFactoryNames(fields: readonly IRField[], which: "validators" | "formatters", formPhasesOnly: boolean): Set<string> {
    const out = new Set<string>();
    for (const f of fields) {
        const slice = schemaSlice(f);
        if (which === "validators") {
            for (const v of slice?.validators ?? []) out.add(v.name);
        } else {
            for (const fmt of slice?.formatters ?? []) {
                if (formPhasesOnly && !CLIENT_PHASES.has(fmt.phase)) continue;
                out.add(fmt.spec.name);
            }
        }
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
    // A user-authored constructor (008) → `__init__`. It coexists with the hydration factory
    // (`from_value`/`_hydrate`), which bypasses `__init__` via `__new__`.
    if (method.kind === "constructor") {
        const params = ["self", ...method.params.map((p) => p.name)].join(", ");
        lines.push(`    def __init__(${params}):`, ...body);
        return lines;
    }
    // A user-authored destructor (009) → `__del__` (no params, no return).
    if (method.kind === "destructor") {
        lines.push(`    def __del__(self):`, ...body);
        return lines;
    }
    // Regular method — `async def` when async (010); its body may then use `await`.
    const kw = method.async === true ? "async def" : "def";
    const params = ["self", ...method.params.map((p) => p.name)].join(", ");
    lines.push(`    ${kw} ${method.name}(${params}):`, ...body);
    return lines;
}

function fieldAnnotation(field: IRField, classNameByName: ReadonlyMap<string, string>): string {
    const core = irTypeToPython(field.type, classNameByName);
    if (field.nullable || !field.required) return core.startsWith("Optional[") ? core : `Optional[${core}]`;
    return core;
}
