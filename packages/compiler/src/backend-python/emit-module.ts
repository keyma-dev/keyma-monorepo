import type { IRClassDeclaration, IRMember, IRMethod, IRFunctionDeclaration, IRType } from "@keyma/core/ir";
import { collectRefTargets, collectFunctionRefs, collectStatementIdentifiers, filterVisibleFields, filterVisibleMethods, methodBodyForBundle, type Bundle } from "@keyma/core/util";
import { defaultRuntimeSymbols } from "../driver/runtime-symbols.js";
import { renderStatements, factoryIdent } from "./emit-validators.js";
import { intrinsicImports } from "./emit-expression.js";
import { irTypeToPython } from "./ir-type-to-python.js";
import type { BuildClassData } from "./emitter-registry.js";
import { buildApplyDefaults } from "./emit-defaults.js";
import { emitLiteral } from "./emit-literal.js";
import { pythonRelImport } from "./module-path.js";
import { EMITTED_PY_RUNTIME_MODULE } from "./emitted-runtime.js";

/** The declarations a single source module owns: the classes authored in the file plus
 *  the (reachable) functions homed in it — plain utility helpers and claimed domain
 *  factories alike. Either list may be empty (a function-only file still produces a module). */
export type ModuleContent = {
    classes: readonly IRClassDeclaration[];
    functions: readonly IRFunctionDeclaration[];
};

export type ModuleEmitDeps = {
    includePrivate: boolean;
    /** Which bundle is being emitted; passed through to the domain's hooks for per-bundle gating. */
    bundle: "client" | "server" | "library";
    includeDefaults: boolean;
    /** sourceName → bundle-relative module ref (e.g. "src/user/user"). */
    classModule: ReadonlyMap<string, string>;
    /** Function name → bundle-relative module ref (e.g. "src/user", "vendor"). Covers every
     *  function the bundle keeps; cross-module function refs resolve through here. */
    functionModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted Python class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Every project-local function declaration keyed by name (a domain pack reads a
     *  helper factory's params for factory-call arg ordering). */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    /** Names of the functions rendered with the domain wrapper rather than as plain
     *  functions. The matching renderings come from `renderClaimedFunctions`. */
    claimedFunctionNames: ReadonlySet<string>;
    /** Domain-supplied builder of the per-class `.metadata` dict (from the emitter
     *  registry's primary pack). Keeps the generic module emitter domain-agnostic. */
    buildClassData: BuildClassData;
    /** The union of function names a class's members reference (domain-supplied), used to wire
     *  the module's cross-module imports. Absent when the domain references none. */
    referencedFunctionNames?: (
        members: readonly IRMember[],
        ctx: { bundle: "client" | "server" | "library" },
    ) => ReadonlySet<string>;
    /** Render the claimed functions a module owns, with the domain wrapper, one rendered `def`
     *  block per declaration. Present when `claimedFunctionNames` is non-empty. */
    renderClaimedFunctions?: (decls: readonly IRFunctionDeclaration[]) => readonly string[];
};

/** Emit one source module `.py` with every declaration authored in a source file — classes
 *  plus the functions homed there (plain utilities and wrapped domain factories alike).
 *  A function-only file still produces a module. */
export function emitModulePython(moduleRef: string, content: ModuleContent, deps: ModuleEmitDeps): string {
    const claimedByName = renderClaimed(content, deps);

    // Emit the class + function bodies first so the header can pull in only the math/coercion-
    // intrinsic imports they actually reference (getter/method/default/factory bodies may use them).
    const body: string[] = [];
    for (const cls of orderClassesByInheritance(content.classes)) {
        body.push(...emitClass(cls, deps));
        body.push("");
    }
    for (const fn of content.functions) {
        const rendering = claimedByName.get(fn.name);
        body.push(rendering !== undefined ? rendering : emitFunctionPy(fn));
        body.push("");
    }

    // Pull the math/coercion intrinsic shims from the bundle-local baked runtime module (relative
    // to this module's location) so generated code imports no `keyma-runtime` package.
    const rt = pythonRelImport(moduleRef, EMITTED_PY_RUNTIME_MODULE);
    const intrinsicSpec = `from ${rt.prefix}${rt.module} import`;
    const lines: string[] = [
        "from __future__ import annotations",
        "from typing import Any, List, Optional, Literal, Dict",
        "from datetime import datetime, timezone",
        "import re",
        ...intrinsicImports(body.join("\n"), intrinsicSpec),
        "",
    ];
    lines.push(...buildImports(moduleRef, content, deps));
    lines.push("", "");
    lines.push(...body);
    return lines.join("\n");
}

/** Order a module's classes so a base class precedes any same-module subclass — Python executes
 *  top-to-bottom, so `Parent.metadata` (and the `class Parent`) must be defined before a child's
 *  `class Child(Parent)` / `Child.metadata = { base: Parent.metadata }`. Cross-module parents come
 *  in via imports. */
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

function emitClass(cls: IRClassDeclaration, deps: ModuleEmitDeps): string[] {
    const fields = filterVisibleFields(cls, deps.includePrivate);
    const lines: string[] = [];

    // Inheritance is real: `class Child(Parent)`. `extends` is the parent sourceName (emit symbol).
    const extendsClause = cls.extends !== undefined ? `(${cls.extends})` : "";
    lines.push(`class ${cls.sourceName}${extendsClause}:`);

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
    if (cls.extends !== undefined) lines.push(`        super()._hydrate(value)`);
    if (fields.length > 0) {
        lines.push(`        if value:`);
        for (const field of fields) {
            lines.push(`            self.${field.name}: ${fieldAnnotation(field, deps.classNameByName)} = value.get("${field.name}")`);
        }
    } else if (cls.extends === undefined) {
        // Fieldless base class: a valid no-op body.
        lines.push(`        pass`);
    }
    // (extends with no own fields → the body is just the super()._hydrate(value) call.)

    // Getters, setters, and methods are all behaviors re-emitted as class members.
    // Emit getters first so a paired `@name.setter` follows its `@property`.
    const behaviors = filterVisibleMethods(cls, deps.includePrivate);
    const getterNames = new Set(behaviors.filter((m) => m.kind === "getter").map((m) => m.name));
    const ordered = [
        ...behaviors.filter((m) => m.kind === "getter"),
        ...behaviors.filter((m) => m.kind !== "getter"),
    ];
    for (const method of ordered) {
        lines.push("");
        lines.push(...emitMethodPython(method, getterNames, deps.classNameByName, deps.bundle));
    }
    lines.push("");

    // Module-level applyDefaults function (referenced from the metadata) — server bundles.
    let applyDefaultsRef: string | undefined;
    if (deps.includeDefaults) {
        const ad = buildApplyDefaults(cls, deps.includePrivate);
        if (ad !== null) {
            lines.push(ad.def, "");
            applyDefaultsRef = ad.name;
        }
    }

    const classData = deps.buildClassData(cls, {
        includePrivate: deps.includePrivate,
        bundle: deps.bundle,
        functionDecls: deps.functionDecls,
        refs: classRefs(fields, deps.classNameByName),
        ...(applyDefaultsRef !== undefined ? { applyDefaultsRef } : {}),
    });
    lines.push(`${cls.sourceName}.metadata = ${emitLiteral(classData)}`);

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

    const classes = content.classes;
    const allFields: IRMember[] = classes.flatMap((c) => filterVisibleFields(c, deps.includePrivate));

    // Cross-module base classes + embedded/reference class targets.
    for (const c of classes) {
        if (c.extends !== undefined) {
            const ref = deps.classModule.get(c.extends);
            if (ref !== undefined) add(ref, c.extends);
        }
    }
    for (const target of collectRefTargets(allFields)) {
        // Targets are identities (`name`); resolve to the emitted class + its module.
        const className = deps.classNameByName.get(target);
        if (className === undefined) continue;
        const ref = deps.classModule.get(className);
        if (ref !== undefined) add(ref, className);
    }

    // Functions referenced from this module — by a domain's per-member metadata, by class
    // behaviors/defaults, and by the bodies of the functions homed here — resolved to their
    // source module through `functionModule`. Same-module refs are skipped by `add`.
    const fnRefs = new Set<string>();
    if (deps.referencedFunctionNames !== undefined) {
        for (const n of deps.referencedFunctionNames(allFields, { bundle: deps.bundle })) fnRefs.add(n);
    }
    for (const n of collectFunctionRefs(classes, {
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

    // Runtime-provided (`external`) types named in a visible method's signature or a static's type
    // (e.g. a synthesized `validate() -> List[ValidationError]`). Registered names are imported from
    // the bundle-local baked schema runtime module (`_keyma_schema`, the home of these runtime
    // types). Inert until synthesis emits `external`-typed signatures (registry seeded empty ⇒ zero
    // matches ⇒ byte-identical output today).
    const externalNames = new Set<string>();
    for (const cls of classes) {
        for (const m of filterVisibleMethods(cls, deps.includePrivate)) {
            if (m.returnType !== undefined) collectExternalTypeNames(m.returnType, externalNames);
            for (const p of m.params) collectExternalTypeNames(p.type, externalNames);
        }
        for (const s of cls.statics ?? []) {
            if (s.type !== undefined) collectExternalTypeNames(s.type, externalNames);
        }
    }
    for (const name of externalNames) {
        if (defaultRuntimeSymbols.has(name)) add(SCHEMA_RUNTIME_MODULE, defaultRuntimeSymbols.resolve("python", name) ?? name);
    }

    return [...bySpec.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([spec, bindings]) => `${spec} ${[...bindings].sort().join(", ")}`);
}

/** Bundle-local baked schema-runtime module that homes the runtime-provided (`external`) types a
 *  synthesized method signature names. (Matches the schema Python pack's `_keyma_schema.py` bake.) */
const SCHEMA_RUNTIME_MODULE = "_keyma_schema";

/** Collect every `external` runtime-type name reachable in a type (through array/optional element
 *  types and function param/return types) into `out`. Mirrors the JS backend's collector. */
function collectExternalTypeNames(type: IRType, out: Set<string>): void {
    switch (type.kind) {
        case "external": out.add(type.name); break;
        case "array": collectExternalTypeNames(type.of, out); break;
        case "optional": collectExternalTypeNames(type.of, out); break;
        case "function":
            type.params.forEach((p) => collectExternalTypeNames(p.type, out));
            if (type.returns !== undefined) collectExternalTypeNames(type.returns, out);
            break;
    }
}

/** Embedded/reference targets of a member list as `{ name, className }` pairs for
 *  the live `refs` dict — keyed by the target's `name`, valued by its Python class. */
function classRefs(
    fields: IRMember[],
    classNameByName: ReadonlyMap<string, string>,
): { name: string; className: string }[] {
    return [...collectRefTargets(fields)]
        .filter((t) => classNameByName.has(t))
        .map((name) => ({ name, className: classNameByName.get(name)! }));
}

function emitMethodPython(
    method: IRMethod,
    getterNames: ReadonlySet<string>,
    classNameByName: ReadonlyMap<string, string>,
    bundle: Bundle,
): string[] {
    const lines: string[] = [];
    const stmts = methodBodyForBundle(method, bundle);
    const body = stmts.length === 0 ? ["        pass"] : [renderStatements(stmts, "        ")];

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

function fieldAnnotation(field: IRMember, classNameByName: ReadonlyMap<string, string>): string {
    const core = irTypeToPython(field.type, classNameByName);
    if (field.nullable || !field.required) return core.startsWith("Optional[") ? core : `Optional[${core}]`;
    return core;
}
