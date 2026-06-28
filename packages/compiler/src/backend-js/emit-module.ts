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
import type { BuildClassData, ClassDtsContext, ClassDtsShape, ClaimedFunctionRendering } from "./emitter-registry.js";
import { emitLiteral } from "./emit-literal.js";
import { factoryIdent } from "./emit-validators.js";
import { relModuleSpecifier } from "./module-path.js";
import { TYPES_REF } from "./emit-types.js";

/** The declarations a single source module owns: the classes authored in the file plus the
 *  (reachable) functions homed in it — plain utility helpers and claimed factory functions
 *  alike. Either list may be empty (a function-only file still produces a module). */
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
    /** Names of the functions rendered with the domain wrapper rather than as plain
     *  functions. The matching renderings come from `renderClaimedFunctions`. */
    claimedFunctionNames: ReadonlySet<string>;
    /** Domain-supplied builder of the per-class `.metadata` object (from the emitter
     *  registry's primary pack). Threaded here so the generic module emitter stays
     *  domain-agnostic. */
    buildClassData: BuildClassData;
    /** The function names a class's members reference (validator/formatter attachments, …),
     *  read by the domain from its own member extension slice. Absent for domains that attach
     *  no per-member functions. */
    referencedFunctionNames?: (
        members: readonly IRMember[],
        ctx: { bundle: "client" | "server" | "library" },
    ) => ReadonlySet<string>;
    /** Render the claimed functions a module owns, with the domain wrapper. Present whenever
     *  `claimedFunctionNames` is non-empty. */
    renderClaimedFunctions?: (decls: readonly IRFunctionDeclaration[]) => readonly ClaimedFunctionRendering[];
    /** Domain hook to override a class's `.d.ts` declaration. From the primary pack; absent for
     *  plain class sets / core-only builds, in which case every class emits the default
     *  `export declare class`. */
    shapeClassDts?: (cls: IRClassDeclaration, ctx: ClassDtsContext) => ClassDtsShape | undefined;
};

// ─── JS module ─────────────────────────────────────────────────────────────────

/** Emit one source module `.js` with every declaration authored in a source file —
 *  classes plus the functions homed there (plain utilities and wrapped factories). */
export function emitModuleJs(moduleRef: string, content: ModuleContent, deps: ModuleEmitDeps): string {
    const claimedByName = renderClaimed(content, deps);
    const importLines = buildImports(moduleRef, content, deps, false);
    const bodies: string[] = [];
    for (const cls of orderClassesByInheritance(content.classes)) bodies.push(emitClassJs(cls, deps));
    for (const fn of content.functions) {
        const rendering = claimedByName.get(fn.name);
        bodies.push(rendering !== undefined ? rendering.js : emitFunctionJs(fn));
    }
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
        lines.push(`            this.${field.name} = value.${field.name};`);
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
    const classData = deps.buildClassData(cls, {
        includePrivate: deps.includePrivate,
        bundle: deps.bundle,
        includeDefaults: deps.includeDefaults,
        functionDecls: deps.functionDecls,
        refs,
    });
    lines.push(`${cls.sourceName}.metadata = Object.freeze(${emitLiteral(classData)});`);

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
    const claimedByName = renderClaimed(content, deps);
    const lines: string[] = [];
    lines.push(...buildImports(moduleRef, content, deps, true, claimedByName));
    if (lines.length > 0) lines.push("");

    for (const cls of orderClassesByInheritance(content.classes)) lines.push(emitClassDts(cls, deps));
    for (const fn of content.functions) {
        const rendering = claimedByName.get(fn.name);
        lines.push(rendering !== undefined ? rendering.dts : emitFunctionDts(fn, deps.embeddedTypeNames));
    }

    return lines.join("\n");
}

function emitClassDts(cls: IRClassDeclaration, deps: ModuleEmitDeps): string {
    const fields = filterVisibleFields(cls, deps.includePrivate);
    const lines: string[] = [];

    // A domain may reshape the class declaration (e.g. privatize a relationship class and
    // re-export a branded const). Plain classes / non-domain builds keep the default.
    const shape = deps.shapeClassDts?.(cls, { embeddedTypeNames: deps.embeddedTypeNames });
    const declName = shape?.declName ?? cls.sourceName;
    const declKeyword = shape?.declKeyword ?? "export declare class";

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

    if (shape?.trailer !== undefined && shape.trailer.length > 0) {
        lines.push("");
        lines.push(...shape.trailer);
    }

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
 * per-member functions its members reference, the utility functions its bodies (class
 * behaviors, defaults, and the functions homed here) reference, and — in the `.d.ts` — the
 * `ClassMetadata` type plus any wrapper types the claimed functions declare. Same-module
 * refs are skipped (the binding is declared in this very file).
 */
function buildImports(
    moduleRef: string,
    content: ModuleContent,
    deps: ModuleEmitDeps,
    typeOnly: boolean,
    claimedByName?: ReadonlyMap<string, ClaimedFunctionRendering>,
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
    // A domain may need extra .d.ts imports per class (e.g. a relationship's endpoint types).
    if (typeOnly && deps.shapeClassDts !== undefined) {
        for (const cls of classes) {
            const targets = deps.shapeClassDts(cls, { embeddedTypeNames: deps.embeddedTypeNames })?.importTargets;
            if (targets !== undefined) for (const t of targets) addRef(t);
        }
    }

    if (!typeOnly) {
        // Functions referenced from this module — by class behaviors/defaults, by the per-member
        // functions a domain attaches, and by the bodies of the functions homed here.
        const fnRefs = new Set<string>();
        for (const n of collectFunctionRefs(classes, { includePrivate: deps.includePrivate, includeDefaults: deps.includeDefaults, functionNames: new Set(deps.functionModule.keys()) })) fnRefs.add(n);
        if (deps.referencedFunctionNames !== undefined) {
            for (const n of deps.referencedFunctionNames(allFields, { bundle: deps.bundle })) fnRefs.add(n);
        }
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
        // The `.d.ts` imports `ClassMetadata` (when classes are present) and any wrapper
        // types the claimed functions declare (e.g. `ValidatorFn` from the types module).
        const typeNames = new Set<string>();
        if (classes.length > 0) typeNames.add("ClassMetadata");
        if (claimedByName !== undefined) {
            for (const fn of content.functions) {
                for (const t of claimedByName.get(fn.name)?.dtsTypeImports ?? []) typeNames.add(t);
            }
        }
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

/** Run the domain's claimed-function renderer over the claimed functions this module owns,
 *  returning a name→rendering map (empty when the module owns none). */
function renderClaimed(content: ModuleContent, deps: ModuleEmitDeps): Map<string, ClaimedFunctionRendering> {
    const claimed = content.functions.filter((fn) => deps.claimedFunctionNames.has(fn.name));
    if (claimed.length === 0) return new Map();
    if (deps.renderClaimedFunctions === undefined) {
        throw new Error("module owns claimed functions but no renderClaimedFunctions hook was provided");
    }
    const renderings = deps.renderClaimedFunctions(claimed);
    return new Map(claimed.map((fn, i) => [fn.name, renderings[i]!]));
}

/**
 * Embedded/reference targets referenced by a member list, as `{ name, symbol }`
 * pairs for the live `refs` Map — keyed by the target's `name` (the runtime
 * identity serialize/deserialize look up), valued by its emitted class symbol.
 */
function classRefs(
    fields: IRMember[],
    embeddedTypeNames: ReadonlyMap<string, string>,
): { name: string; symbol: string }[] {
    return [...collectRefTargets(fields)]
        .filter((t) => embeddedTypeNames.has(t))
        .map((name) => ({ name, symbol: embeddedTypeNames.get(name)! }));
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
