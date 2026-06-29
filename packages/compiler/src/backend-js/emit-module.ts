import type {
    IRClassDeclaration, IRMember, IRFunctionDeclaration, IRType,
} from "@keyma/core/ir";
import {
    collectRefTargets, collectFunctionRefs, collectStatementIdentifiers,
    filterVisibleFields, filterVisibleMethods, methodBodyForBundle, staticValueForBundle,
} from "@keyma/core/util";
import { defaultRuntimeSymbols } from "../driver/runtime-symbols.js";
import { stmtToJs, exprToJs } from "./emit-expression.js";
import { irTypeToTs } from "./ir-type-to-ts.js";
import type { BuildClassData, MetadataClassDescriptor, MetadataFieldDescriptor, MetadataRef } from "../driver/index.js";
import { emitLiteral, mkRaw } from "./emit-literal.js";
import { factoryIdent } from "./emit-validators.js";
import { relModuleSpecifier } from "./module-path.js";
import { TYPES_REF } from "./emit-types.js";

/** The declarations a single source module owns: the classes authored in the file plus the
 *  (reachable) functions homed in it — plain utility helpers and the factory functions the
 *  synthesized methods call alike. Either list may be empty (a function-only file still
 *  produces a module). */
export type ModuleContent = {
    classes: readonly IRClassDeclaration[];
    functions: readonly IRFunctionDeclaration[];
};

export type ModuleEmitDeps = {
    /** Include private members and private computed getters. */
    includePrivate: boolean;
    /** Which bundle is being emitted; threaded to the domain pack for its own gating. */
    bundle: "client" | "server" | "library";
    /** Include the per-class `applyDefaults` arrow (server/library bundles). */
    includeDefaults: boolean;
    /** sourceName → bundle-relative module ref (e.g. "src/user"). */
    classModule: ReadonlyMap<string, string>;
    /** Function name → bundle-relative module ref (e.g. "src/user", "vendor"). Covers every
     *  function the bundle keeps; cross-module function refs resolve through here. */
    functionModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted class symbol (`sourceName`).
     *  Resolves a target's identity to the TS type / class binding to import. */
    embeddedTypeNames: ReadonlyMap<string, string>;
    /** Every project-local function declaration keyed by name (a domain pack reads a
     *  factory function's params for factory-call arg ordering). */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    /** Domain-supplied builder of the per-class `.metadata` object (from the emitter
     *  registry's primary pack). Threaded here so the generic module emitter stays
     *  domain-agnostic. */
    buildClassData: BuildClassData;
};

// ─── JS module ─────────────────────────────────────────────────────────────────

/** Emit one source module `.js` with every declaration authored in a source file —
 *  classes plus the functions homed there (plain utilities and wrapped factories). */
export function emitModuleJs(moduleRef: string, content: ModuleContent, deps: ModuleEmitDeps): string {
    const importLines = buildImports(moduleRef, content, deps, false);
    const bodies: string[] = [];
    for (const cls of orderClassesByInheritance(content.classes)) bodies.push(emitClassJs(cls, deps));
    for (const fn of content.functions) bodies.push(emitFunctionJs(fn));
    return [...importLines, ...(importLines.length > 0 ? [""] : []), bodies.join("\n")].join("\n");
}

function emitClassJs(cls: IRClassDeclaration, deps: ModuleEmitDeps): string {
    const fields = filterVisibleFields(cls, deps.includePrivate);
    const lines: string[] = [];

    // Inheritance is real: emit `extends Parent` and assign only OWN fields here; the
    // base-chain walk in `_hydrate` populates the inherited ones. (`extends` is the parent's
    // sourceName — the emit symbol.)
    const ext = cls.extends !== undefined ? ` extends ${cls.extends}` : "";
    lines.push(`export class ${cls.sourceName}${ext} {`);

    // Hydration is a STATIC factory (mirrors C++ `T::from_value`), which frees the constructor
    // slot for a user-authored constructor. `Object.create` bypasses the constructor so the two
    // never collide — no code path hydrates via `new Class(plain)`.
    lines.push(`    static fromValue(value) {`);
    lines.push(`        const instance = Object.create(this.prototype);`);
    lines.push(`        instance._hydrate(value);`);
    lines.push(`        return instance;`);
    lines.push(`    }`);
    lines.push("");
    // Per-class field assignment, walking the base chain via `super._hydrate` (real inheritance:
    // each class assigns only its OWN fields; the parent assigns the inherited ones).
    lines.push(`    _hydrate(value) {`);
    if (cls.extends !== undefined) lines.push(`        super._hydrate(value);`);
    lines.push(`        if (value) {`);
    for (const field of fields) {
        // Defaults apply at CONSTRUCTION: an absent (`undefined`) key takes the field's default —
        // literal or expression, required + optional alike (matches the runtime `applyDefaults`
        // absence semantics). Non-defaulted fields assign through directly.
        if (field.default !== undefined) {
            const def = field.default;
            const dflt = def.kind === "literal" ? emitLiteral(def.value) : exprToJs(def.expression, { fieldAccess: (n) => `value.${n}` });
            lines.push(`            this.${field.name} = value.${field.name} !== undefined ? value.${field.name} : ${dflt};`);
        } else {
            lines.push(`            this.${field.name} = value.${field.name};`);
        }
    }
    lines.push(`        }`);
    lines.push(`    }`);

    // Getters, setters, methods, and the user-authored constructor/destructor are all re-emitted
    // as class members. `async` rides on plain methods only.
    for (const method of filterVisibleMethods(cls, deps.includePrivate)) {
        lines.push("");
        const params = method.params.map((p) => p.name).join(", ");
        const asyncKw = method.async ? "async " : "";
        const signature =
            method.kind === "setter" ? `    set ${method.name}(${params}) {`
            : method.kind === "getter" ? `    get ${method.name}() {`
            : method.kind === "constructor" ? `    constructor(${params}) {`
            : method.kind === "destructor" ? `    destructor() {`
            : `    ${asyncKw}${method.name}(${params}) {`;
        lines.push(signature);
        for (const stmt of methodBodyForBundle(method, deps.bundle)) lines.push(stmtToJs(stmt, "        "));
        lines.push(`    }`);
    }

    lines.push(`}`);
    lines.push("");

    const refs = classRefs(fields, deps.embeddedTypeNames);
    const descriptor = deps.buildClassData(cls, {
        includePrivate: deps.includePrivate,
        bundle: deps.bundle,
    });
    lines.push(renderClassMetadata(cls, descriptor, refs));

    // Synthesized static members (e.g. domain `metadata`): emitted from base IR as
    // `Class.<name> = <value>;`, audience-gated like a method body. Empty for plain classes.
    for (const s of cls.statics ?? []) {
        lines.push(`${cls.sourceName}.${s.name} = ${exprToJs(staticValueForBundle(s, deps.bundle))};`);
    }

    lines.push("");
    return lines.join("\n");
}

/** Emit a plain project-local utility function as an ES-module export. */
function emitFunctionJs(decl: IRFunctionDeclaration): string {
    const params = decl.params.map((p) => p.name).join(", ");
    const body = decl.statements.map((s) => stmtToJs(s, "    ")).join("\n");
    const asyncKw = decl.async ? "async " : "";
    return `export ${asyncKw}function ${decl.name}(${params}) {\n${body}\n}\n`;
}

// ─── .d.ts module ──────────────────────────────────────────────────────────────

/** Emit one source module `.d.ts` declaring every declaration authored in a source file. */
export function emitModuleDts(moduleRef: string, content: ModuleContent, deps: ModuleEmitDeps): string {
    const lines: string[] = [];
    lines.push(...buildImports(moduleRef, content, deps, true));
    if (lines.length > 0) lines.push("");

    for (const cls of orderClassesByInheritance(content.classes)) lines.push(emitClassDts(cls, deps));
    for (const fn of content.functions) lines.push(emitFunctionDts(fn, deps.embeddedTypeNames));

    return lines.join("\n");
}

function emitClassDts(cls: IRClassDeclaration, deps: ModuleEmitDeps): string {
    const fields = filterVisibleFields(cls, deps.includePrivate);
    const lines: string[] = [];

    const declName = cls.sourceName;
    const declKeyword = "export declare class";

    // Real inheritance: declare `extends Parent` and own members only (inherited come from the base).
    const ext = cls.extends !== undefined ? ` extends ${cls.extends}` : "";
    lines.push(`${declKeyword} ${declName}${ext} {`);
    lines.push(`    static readonly metadata: ClassMetadata;`);
    // Synthesized statics declared on the type surface (empty for plain classes).
    for (const s of cls.statics ?? []) {
        lines.push(`    static readonly ${s.name}: ${s.type !== undefined ? irTypeToTs(s.type, deps.embeddedTypeNames) : "unknown"};`);
    }

    for (const field of fields) {
        const nul = field.nullable ? " | null" : "";
        const optional = !field.required ? " | undefined" : "";
        const ro = field.readonly ? "readonly " : "";
        for (const jsdoc of fieldJsDoc(field)) lines.push(jsdoc);
        lines.push(`    ${ro}${field.name}: ${irTypeToTs(field.type, deps.embeddedTypeNames)}${nul}${optional};`);
    }

    for (const method of filterVisibleMethods(cls, deps.includePrivate)) {
        const params = method.params
            .map((p) => `${p.name}: ${irTypeToTs(p.type, deps.embeddedTypeNames)}`)
            .join(", ");
        if (method.kind === "setter") {
            lines.push(`    set ${method.name}(${params});`);
        } else if (method.kind === "getter") {
            const ret = method.returnType ? irTypeToTs(method.returnType, deps.embeddedTypeNames) : "void";
            lines.push(`    get ${method.name}(): ${ret};`);
        } else if (method.kind === "constructor") {
            lines.push(`    constructor(${params});`);
        } else {
            // method or destructor — async re-wraps the unwrapped `returnType` in `Promise<…>`.
            let ret = method.returnType ? irTypeToTs(method.returnType, deps.embeddedTypeNames) : "void";
            if (method.async) ret = `Promise<${ret}>`;
            lines.push(`    ${method.name}(${params}): ${ret};`);
        }
    }

    // Hydration is the static `fromValue` factory (mirrors the `.js`); the constructor slot is
    // left for the user-authored constructor declared in the method loop above.
    const fromValueParams = fields
        .map((f) => `${f.name}?: ${irTypeToTs(f.type, deps.embeddedTypeNames)}${f.nullable ? " | null" : ""}`)
        .join("; ");
    lines.push(`    static fromValue(value?: { ${fromValueParams} }): ${declName};`);
    lines.push(`}`);

    lines.push("");
    return lines.join("\n");
}

/** Emit a plain project-local utility function's `.d.ts` declaration. */
function emitFunctionDts(decl: IRFunctionDeclaration, embeddedNames: ReadonlyMap<string, string>): string {
    const params = decl.params.map((p) => `${p.name}: ${irTypeToTs(p.type, embeddedNames)}`).join(", ");
    // `returnType` carries the UNWRAPPED `T`; an async fn re-wraps it in `Promise<…>`.
    let ret = irTypeToTs(decl.returnType, embeddedNames);
    if (decl.async) ret = `Promise<${ret}>`;
    return `export declare function ${decl.name}(${params}): ${ret};\n`;
}

// ─── Import resolution ─────────────────────────────────────────────────────────

/**
 * Build the import lines a module needs: cross-module class/embedded class refs, the
 * utility functions its bodies (class behaviors, defaults, and the functions homed here)
 * reference, and — in the `.d.ts` — the `ClassMetadata` type plus the runtime (`external`)
 * types named in a visible method/static signature. Same-module refs are skipped (the
 * binding is declared in this very file).
 */
function buildImports(
    moduleRef: string,
    content: ModuleContent,
    deps: ModuleEmitDeps,
    typeOnly: boolean,
): string[] {
    const bySpec = new Map<string, Set<string>>();
    const add = (spec: string, binding: string): void => {
        if (!bySpec.has(spec)) bySpec.set(spec, new Set());
        bySpec.get(spec)!.add(binding);
    };

    const classes = content.classes;
    const allFields: IRMember[] = classes.flatMap((s) => filterVisibleFields(s, deps.includePrivate));

    // Real-inheritance parents: the base class symbol (`extends` = parent sourceName), imported
    // from its module. This is a VALUE import — used in the `extends` heritage clause — so even
    // the `.d.ts` imports it with `import`, never `import type`. Same-module parents need no import.
    const parentBySpec = new Map<string, Set<string>>();
    for (const cls of classes) {
        if (cls.extends === undefined) continue;
        const targetRef = deps.classModule.get(cls.extends);
        if (targetRef === undefined || targetRef === moduleRef) continue;
        const spec = relModuleSpecifier(moduleRef, targetRef);
        (parentBySpec.get(spec) ?? parentBySpec.set(spec, new Set()).get(spec)!).add(cls.extends);
    }

    // Cross-module class/embedded class refs. Targets are identities (`name`);
    // resolve to the emitted class symbol and its module.
    const addRef = (targetName: string): void => {
        const symbol = deps.embeddedTypeNames.get(targetName);
        if (symbol === undefined) return;
        const targetRef = deps.classModule.get(symbol);
        if (targetRef === undefined || targetRef === moduleRef) return;
        add(relModuleSpecifier(moduleRef, targetRef), symbol);
    };
    for (const target of collectRefTargets(allFields)) addRef(target);

    if (!typeOnly) {
        // Functions referenced from this module — by class behaviors/defaults (including the
        // synthesized validate/format* method bodies, which name the factory functions they
        // call) and by the bodies of the functions homed here.
        const fnRefs = new Set<string>();
        for (const n of collectFunctionRefs(classes, { includePrivate: deps.includePrivate, includeDefaults: deps.includeDefaults, functionNames: new Set(deps.functionModule.keys()) })) fnRefs.add(n);
        for (const fn of content.functions) {
            const ids = new Set<string>();
            for (const stmt of fn.statements) collectStatementIdentifiers(stmt, ids);
            for (const id of ids) if (deps.functionModule.has(id)) fnRefs.add(id);
        }
        for (const n of fnRefs) {
            const targetRef = deps.functionModule.get(n);
            if (targetRef === undefined || targetRef === moduleRef) continue;
            add(relModuleSpecifier(moduleRef, targetRef), factoryIdent(n));
        }
    } else {
        // The `.d.ts` imports `ClassMetadata` (when classes are present) plus the runtime
        // (`external`) types named in a visible method/static signature (below).
        const typeNames = new Set<string>();
        if (classes.length > 0) typeNames.add("ClassMetadata");
        // Runtime-provided (`external`) types named in a visible method's signature or a static's
        // type (e.g. a synthesized `validate(): ValidationError[]`). Resolve each registered name to
        // its emitted symbol; the schema bake homes these runtime types in the bundle's `types.d.ts`
        // (TYPES_REF). Inert until synthesis emits `external`-typed signatures (registry seeded empty
        // ⇒ zero matches ⇒ byte-identical .d.ts today).
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
            if (defaultRuntimeSymbols.has(name)) typeNames.add(defaultRuntimeSymbols.resolve("js", name) ?? name);
        }
        if (typeNames.size > 0) add(relModuleSpecifier(moduleRef, TYPES_REF), [...typeNames].sort().join(", "));
    }

    // In `.js`, the parent is an ordinary value import — fold it into the normal import set so it
    // sorts with everything else. In `.d.ts`, emit it as its own `import` line (value, not type).
    if (!typeOnly) {
        for (const [spec, set] of parentBySpec) for (const b of set) add(spec, b);
    }
    const kw = typeOnly ? "import type" : "import";
    const typeLines = [...bySpec.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([spec, bindings]) => {
            // Drop a binding the `.d.ts` also value-imports as a parent (avoid a duplicate import).
            const names = typeOnly ? [...bindings].filter((b) => !parentBySpec.get(spec)?.has(b)) : [...bindings];
            return names.length > 0 ? `${kw} { ${names.sort().join(", ")} } from "${spec}";` : undefined;
        })
        .filter((l): l is string => l !== undefined);
    const parentLines = typeOnly
        ? [...parentBySpec.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([spec, set]) => `import { ${[...set].sort().join(", ")} } from "${spec}";`)
        : [];
    return [...parentLines, ...typeLines];
}

/** Collect every `external` runtime-type name reachable in a type (through array/optional element
 *  types and function param/return types) into `out`. Drives the `.d.ts` runtime-type imports. */
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

/**
 * Embedded/reference targets referenced by a member list, as `{ name, target }`
 * pairs for the live `refs` Map — keyed by the target's `name` (the runtime
 * identity serialize/deserialize look up), valued by its emitted class symbol.
 */
function classRefs(
    fields: IRMember[],
    embeddedTypeNames: ReadonlyMap<string, string>,
): MetadataRef[] {
    return [...collectRefTargets(fields)]
        .filter((t) => embeddedTypeNames.has(t))
        .map((name) => ({ name, target: embeddedTypeNames.get(name)! }));
}

/**
 * Render a class's `<Class>.metadata = Object.freeze({…})` from the neutral
 * {@link MetadataClassDescriptor}, the live `base` (derived from `cls.extends`), and the live
 * `refs` (a `new Map([…])` of class references). The key order + conditional inclusion are the
 * cross-language runtime contract; the compiler owns it (was the schema domain's `buildClassData`).
 */
function renderClassMetadata(cls: IRClassDeclaration, d: MetadataClassDescriptor, refs: readonly MetadataRef[]): string {
    const out: Record<string, unknown> = {
        name: d.name,
        sourceName: d.sourceName,
        fields: d.fields.map(jsFieldRecord),
    };
    // A live reference to the parent's `.metadata` lets the runtime walk the chain (metadata
    // carries OWN fields only). `cls.extends` is the parent's emit symbol, so `<Parent>.metadata`.
    if (cls.extends !== undefined) out["base"] = mkRaw(`${cls.extends}.metadata`);
    if (d.indexes !== undefined && d.indexes.length > 0) out["indexes"] = d.indexes;
    if (d.edge !== undefined) out["edge"] = d.edge;
    if (d.visibility === "private") out["visibility"] = "private";
    if (d.ephemeral === true) out["ephemeral"] = true;
    if (refs.length > 0) {
        const entries = refs.map((r) => `[${JSON.stringify(r.name)}, ${r.target}]`).join(", ");
        out["refs"] = mkRaw(`new Map([${entries}])`);
    }
    return `${cls.sourceName}.metadata = Object.freeze(${emitLiteral(out)});`;
}

/** One field's metadata record, in the contract key order. */
function jsFieldRecord(f: MetadataFieldDescriptor): Record<string, unknown> {
    const out: Record<string, unknown> = { name: f.name, type: f.type };
    if (f.visibility === "private") out["visibility"] = "private";
    if (f.readonly) out["readonly"] = true;
    if (!f.required) out["required"] = false;
    if (f.nullable) out["nullable"] = true;
    if (f.indexes !== undefined && f.indexes.length > 0) out["indexes"] = f.indexes;
    if (f.ephemeral) out["ephemeral"] = true;
    if (f.default !== undefined) out["default"] = f.default;
    if (f.form !== undefined) out["form"] = f.form;
    if (f.deprecated !== undefined) out["deprecated"] = f.deprecated;
    if (f.tag !== undefined) out["tag"] = f.tag;
    return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Order a module's classes so a base class precedes any same-module subclass — the emitted
 *  `class X extends Base` and `X.metadata = { base: Base.metadata }` both need `Base` evaluated
 *  first. Cross-module parents (absent from this list) are evaluated via module load order. */
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

function fieldJsDoc(field: IRMember): string[] {
    const body: string[] = [];
    if (field.deprecated !== undefined) {
        body.push(typeof field.deprecated === "string" ? `@deprecated ${field.deprecated}` : "@deprecated");
    }
    if (body.length === 0) return [];
    if (body.length === 1) return [`    /** ${body[0]} */`];
    return ["    /**", ...body.map((l) => `     * ${l}`), "     */"];
}
