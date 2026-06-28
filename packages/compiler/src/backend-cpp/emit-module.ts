import type {
    IRClassDeclaration, IRMember, IRType, IRMethod, IREnumDeclaration,
    IRFunctionDeclaration, IRDiagnostic, IRExpression, IRStatement,
} from "@keyma/core/ir";
import { collectRefTargets, collectFunctionRefs, collectStatementIdentifiers, collectIntrinsicOpsInStatement, unwrapArray, filterVisible, filterVisibleFields, filterVisibleMethods, inheritedFields, methodBodyForBundle } from "@keyma/core/util";
import { exprToCpp, type ExprOpts } from "./emit-expression.js";
import { stmtToCpp, plainReturn, factoryIdent, type ReturnLowerer } from "./emit-validators.js";
import { irTypeToCpp, memberType, traitsArg, whereValueType, fieldKind, refTargetType, binaryFieldPlan, type BinaryFieldPlan } from "./ir-type-to-cpp.js";
import type { BuildClassData } from "./emitter-registry.js";
import type { MetadataRef } from "../driver/index.js";
import { emitEnumClass, emitEnumConversions } from "./emit-enum.js";
import { emitClassMeta } from "./emit-class-meta.js";
import { includePath, namespaceOf, cppSanitizer } from "./module-path.js";

export type ModuleEmitDeps = {
    includePrivate: boolean;
    includeDefaults: boolean;
    /** Which bundle is being emitted; threaded into the domain's `buildClassData` and the
     *  method-body audience pick so they can derive their own per-bundle gating. */
    bundle: "client" | "server" | "library";
    /** Emit the typed binary codec (keyma::binary_traits<T>) alongside value_traits. Driven
     *  by the project's `binary` config; off ⇒ JSON-only output is byte-for-byte unchanged. */
    binary: boolean;
    nsRoot: string;
    /** Every class keyed by `sourceName` — resolves the `extends` parent so the trait/codec
     *  emitters can walk the inheritance chain for the full field set (struct members stay own). */
    classBySourceName: ReadonlyMap<string, IRClassDeclaration>;
    /** sourceName → bundle-relative module ref (e.g. "models/user"). */
    classModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted C++ class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → fully-qualified C++ struct type. */
    cppTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → fully-qualified C++ `enum class` type. */
    enumTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → bundle-relative module ref of its declaring file. */
    enumModuleByName: ReadonlyMap<string, string>;
    /** Class `name` → its id field's name (for reference id-stubs). */
    idFieldByName: ReadonlyMap<string, string>;
    /** Class `name`s that are the target of some reference (carry id-stub helpers). */
    referenceTargetNames: ReadonlySet<string>;
    /** Every project-local function declaration keyed by name (a domain pack reads a
     *  validator/formatter factory's params for factory-call arg ordering). */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    functionNames: ReadonlySet<string>;
    /** Function name → bundle-relative module ref of its declaring file (e.g. "src/validators",
     *  "vendor"). Cross-module function refs resolve through here, like reference targets. */
    functionModule: ReadonlyMap<string, string>;
    /** Complete `#include` token (with delimiters) for the runtime header. */
    runtimeInclude: string;
    /** Domain-supplied builder (from the registered primary pack) of the per-class
     *  `metadata()` data as neutral data — keeps the generic module emitter domain-agnostic;
     *  the compiler's `emitClassMeta` renders it. (Named-enum emission is fully compiler-owned.) */
    buildClassData: BuildClassData;
};

/** Diagnostic code for an async function/method the C++ backend cannot yet emit (issue 010). */
export const CPP_ASYNC_DIAGNOSTIC = "KEYMA-CPP-ASYNC";

/**
 * Record the "async not yet C++-emittable" diagnostic for an async function/method. The CALLER
 * then OMITS the member's body entirely — the C++ backend never silently strips `async` and
 * emits a synchronous body (issue 010).
 */
function asyncDiagnostic(what: string, name: string, source: IRDiagnostic["source"]): IRDiagnostic {
    return {
        code: CPP_ASYNC_DIAGNOSTIC,
        severity: "error",
        message: `async ${what} "${name}": async bodies not yet C++-emittable`,
        ...(source !== undefined ? { source } : {}),
    };
}

export function emitModuleCpp(
    moduleRef: string,
    classes: readonly IRClassDeclaration[],
    enums: readonly IREnumDeclaration[],
    functions: readonly IRFunctionDeclaration[],
    deps: ModuleEmitDeps,
    diagnostics: IRDiagnostic[] = [],
): string {
    const ordered = topoSort(classes, deps);
    const ns = namespaceOf(moduleRef, deps.nsRoot);

    // Cross-module utility-function home namespaces this module's bodies call by bare name
    // (class behaviors/defaults + the bodies of the functions homed here). They resolve via
    // per-module using-directives — replacing the old shared `using namespace <root>::functions`.
    // Validator/formatter factory refs in the class metadata are fully qualified separately
    // (like reference targets), so they are not part of this set.
    const usingDirectives = crossModuleFnUsings(moduleRef, classes, functions, deps);
    const useLines = usingDirectives.map((u) => `using namespace ${u};`);

    const lines: string[] = ["#pragma once", `#include ${deps.runtimeInclude}`];
    // The typed binary codec lives in a separate runtime header (keeps the binary-only
    // primitives out of the baked runtime.hpp); pulled in only when binary is enabled.
    if (deps.binary && classes.length > 0) lines.push(`#include <keyma/binary-typed.hpp>`);
    for (const inc of buildIncludes(moduleRef, classes, functions, deps)) lines.push(`#include "${inc}"`);

    if (classes.length > 0) {
        // Forward declarations for every reference target (same- and cross-module). A
        // std::shared_ptr<T> member needs only a forward declaration, which lets legal
        // reference cycles compile (the complete type is pulled in after the structs).
        const fwd = referenceForwardDecls(classes, deps);
        if (fwd.length > 0) { lines.push(""); lines.push(...fwd); }

        // value_traits explicit-specialization DECLARATIONS for every same-module struct and
        // reference target, before any struct whose value_traits would implicitly instantiate
        // a target's. This guarantees "declared before first use" in every translation unit
        // and both include orders — required for the reference cycle to be well-formed
        // ([temp.expl.spec]); redeclaration across the cycle's headers is legal.
        const traitDecls = valueTraitsForwardDecls(ns, classes, deps);
        if (traitDecls.length > 0) { lines.push(""); lines.push(...traitDecls); }

        // binary_traits explicit-specialization forward declarations (same discipline as
        // value_traits) so a binary_traits body that names a sibling's or a reference target's
        // binary_traits has seen its declaration first. Gated on deps.binary.
        if (deps.binary) {
            const binDecls = binaryTraitsForwardDecls(classes, deps);
            if (binDecls.length > 0) lines.push(...binDecls);
        }
    }

    // ── Enums first: definitions + keyma:: conversions + std::formatter, all BEFORE
    // the structs. A getter may interpolate an enum via std::format (analyzed
    // in complete-class context), so the formatter specialization must already be seen. ──
    if (enums.length > 0) {
        lines.push("", `namespace ${ns} {`);
        for (const e of enums) lines.push(emitEnumClass(e));
        lines.push(`}  // namespace ${ns}`, "");
        for (const e of enums) {
            lines.push(emitEnumConversions(e, deps.enumTypeByName.get(e.name) ?? `${ns}::${cppSanitizer(e.name)}`, deps.binary), "");
        }
    }

    // ── Functions homed in this module: plain utilities + the validator/formatter factories the
    // synthesized methods call (all emitted as plain functions via emitFunctionCpp). Emitted
    // before the structs so same-module behaviors can call them; a function-only source file
    // (e.g. validators.ts) produces just this block. ──
    if (functions.length > 0) {
        lines.push("", `namespace ${ns} {`);
        if (useLines.length > 0) { lines.push(...useLines); }
        lines.push("");
        for (const decl of functions) { lines.push(...emitFunctionCpp(decl, diagnostics)); lines.push(""); }
        lines.push(`}  // namespace ${ns}`, "");
    }

    if (classes.length === 0) return lines.join("\n");

    // ── Structs ──
    lines.push(`namespace ${ns} {`);
    if (useLines.length > 0) lines.push(...useLines);
    lines.push("");
    for (const cls of ordered) {
        lines.push(...emitStruct(cls, deps, diagnostics));
        lines.push(`static_assert(std::uses_allocator_v<${cls.sourceName}, ${cls.sourceName}::allocator_type>);`, "");
    }
    lines.push(`}  // namespace ${ns}`, "");

    // Reference-target includes — at file scope, AFTER the struct definitions so
    // from_value sees the complete target types. With #pragma once this ordering
    // breaks reference cycles: every struct in a cycle is defined before any
    // from_value body (which allocate_shared's the target) is parsed.
    const refIncludes = referenceIncludes(moduleRef, classes, deps);
    if (refIncludes.length > 0) { for (const inc of refIncludes) lines.push(`#include "${inc}"`); lines.push(""); }

    // ── Block 2a: value_traits specializations (namespace keyma, file scope). Every
    // same-module struct and reference target is now a complete type, and every
    // value_traits is at least declared above, so the per-field cross-references resolve.
    // All cross-trait references live in function bodies → instantiated lazily at the
    // consumer's odr-use, where every specialization is fully defined. ──
    for (const cls of ordered) {
        lines.push(...emitValueTraits(cls, deps));
        if (deps.binary) lines.push(...emitBinaryTraits(cls, deps));
        lines.push("");
    }

    // ── Block 2b: out-of-line metadata() + the thin from_value/to_value forwarder
    // definitions (after the value_traits they delegate to). ──
    lines.push(`namespace ${ns} {`);
    if (useLines.length > 0) lines.push(...useLines);
    lines.push("");

    for (const cls of ordered) {
        lines.push(...emitClassAccessor(cls, deps));
        lines.push("");
    }

    lines.push(`}  // namespace ${ns}`, "");
    return lines.join("\n");
}

/** Emit a plain project-local utility function as an inline free function. */
function emitFunctionCpp(decl: IRFunctionDeclaration, diagnostics: IRDiagnostic[]): string[] {
    // An async function body may use `await`, which has no C++ lowering yet. Record a diagnostic
    // and OMIT the function entirely — never emit a silently-desynced synchronous body (issue 010).
    if (decl.async === true) {
        diagnostics.push(asyncDiagnostic("function", decl.name, decl.source));
        return [];
    }
    // A validator/formatter FACTORY: a HOF whose body is `return <typed inner arrow>` (the inner
    // arrow carries a `returnType`, set only by the schema `lower-validator`). It is emitted as a
    // concretely-typed generic lambda (decisions 4/5/6) — see `emitFactoryCpp`.
    const factoryArrow = factoryInnerArrow(decl);
    if (factoryArrow !== undefined) return emitFactoryCpp(decl, factoryArrow);

    const params = decl.params.map((p) => `${irTypeToCpp(p.type)} ${p.name}`).join(", ");
    const lines = [`inline auto ${decl.name}(${params}) {`];
    for (const stmt of decl.statements) lines.push(stmtToCpp(stmt, "    ", plainReturn));
    lines.push(`}`);
    return lines;
}

type IRArrowExpr = Extract<IRExpression, { kind: "arrow" }>;

/** If `decl` is a validator/formatter factory — its body is a single `return <arrow>` and that
 *  inner arrow carries an explicit `returnType` (the schema lowering sets it) — return the arrow. */
function factoryInnerArrow(decl: IRFunctionDeclaration): IRArrowExpr | undefined {
    const s = decl.statements;
    const first = s[0];
    if (s.length === 1 && first !== undefined && first.kind === "return"
        && first.value !== null && first.value.kind === "arrow" && first.value.returnType !== undefined) {
        return first.value;
    }
    return undefined;
}

/** A factory parameter declaration. A required param is a deduced `auto` (inferred from the bound
 *  spec arg); an optional param needs a concrete type with a default value (a template parameter
 *  cannot be deduced from a default function argument) — string in practice (regex flags, …). */
function cppFactoryParam(p: { name: string; optional?: boolean }): string {
    return p.optional === true ? `std::pmr::string ${p.name} = {}` : `auto ${p.name}`;
}

/**
 * Emit a validator/formatter factory as a concretely-typed generic lambda (decision 4 — no
 * `keyma::Value` erasure on the hot path): `inline auto f(<spec params>) { return [<spec params by
 * value>](const auto& value, …, const auto& ctx) -> <innerRet> { __a = ctx.object.get_allocator();
 * <body> }; }`. The spec params are captured BY VALUE (the closure escapes the factory call). The
 * allocator reaches the body through the ctx instance (`ctx.object.get_allocator()`), so no method
 * gains an allocator parameter. A validator's `optional<ValidationError>` return COERCES each
 * `return` (the `result()`-style logic relocated from the deleted schema validator backend): an
 * object literal → a wrapped `ValidationError{…}` aggregate (built on `__a` via the record layout),
 * `null` → an empty optional, a conditional → both branches coerced. A formatter returns the field
 * value directly (no coercion).
 */
function emitFactoryCpp(decl: IRFunctionDeclaration, arrow: IRArrowExpr): string[] {
    const factoryParams = decl.params.map(cppFactoryParam).join(", ");
    const captures = decl.params.map((p) => p.name).join(", ");
    const paramNames = arrow.params.map((p) => (typeof p === "string" ? p : p.name));
    const ctxName = paramNames[paramNames.length - 1] ?? "__ctx";
    const arrowParams = paramNames.map((n) => `const auto& ${n}`).join(", ");
    const retType = irTypeToCpp(arrow.returnType!);
    // The factory body references its params/ctx as identifiers (never `this->x` field nodes), so
    // `fieldExpr` is identity; the lambda allocator `__a` threads to the typed `record`/error build.
    const opts: ExprOpts = { fieldExpr: (n) => n, allocVar: "__a" };

    // A validator returns `optional(external(ValidationError))` → coerce returns to that optional.
    const rt = arrow.returnType!;
    const errorReturn = rt.kind === "optional" && rt.of.kind === "external";
    const coerce = (e: IRExpression | null): string => {
        if (e === null || (e.kind === "literal" && e.value === null)) return `${retType}{}`;
        if (e.kind === "conditional") return `(${exprToCpp(e.condition, opts)} ? ${coerce(e.whenTrue)} : ${coerce(e.whenFalse)})`;
        if (e.kind === "object") {
            // An object error literal → the typed aggregate, via the record-layout renderer.
            const rec: IRExpression = { kind: "record", type: (rt as { of: { kind: "external"; name: string } }).of, properties: e.properties };
            return `${retType}(${exprToCpp(rec, opts)})`;
        }
        if (e.kind === "record") return `${retType}(${exprToCpp(e, opts)})`;
        return `${retType}(${exprToCpp(e, opts)})`;
    };
    const ret: ReturnLowerer = errorReturn
        ? (value, indent) => `${indent}return ${coerce(value)};`
        : (value, indent) => (value === null ? `${indent}return;` : `${indent}return ${exprToCpp(value, opts)};`);

    const lines: string[] = [
        `inline auto ${decl.name}(${factoryParams}) {`,
        `    return [${captures}](${arrowParams}) -> ${retType} {`,
        `        [[maybe_unused]] const keyma::alloc_t __a = ${ctxName}.object.get_allocator();`,
    ];
    for (const stmt of arrow.statements ?? []) lines.push(stmtToCpp(stmt, "        ", ret, opts));
    lines.push(`    };`, `}`);
    return lines;
}

/** The distinct cross-module utility-function home namespaces this module references by bare
 *  name (from class behaviors/defaults and the bodies of the functions homed here). */
function crossModuleFnUsings(
    moduleRef: string,
    classes: readonly IRClassDeclaration[],
    functions: readonly IRFunctionDeclaration[],
    deps: ModuleEmitDeps,
): string[] {
    const names = new Set<string>(collectFunctionRefs(classes, deps));
    for (const fn of functions) {
        const ids = new Set<string>();
        for (const stmt of fn.statements) collectStatementIdentifiers(stmt, ids);
        for (const id of ids) if (deps.functionModule.has(id)) names.add(id);
    }
    const nsSet = new Set<string>();
    for (const n of names) {
        const home = deps.functionModule.get(n);
        if (home !== undefined && home !== moduleRef) nsSet.add(namespaceOf(home, deps.nsRoot));
    }
    return [...nsSet].sort();
}

// ─── Struct ───────────────────────────────────────────────────────────────────

/** The fully-qualified C++ type of a class's `extends` parent (`<ns>::<SourceName>`), or undefined. */
function baseFqnOf(cls: IRClassDeclaration, deps: ModuleEmitDeps): string | undefined {
    if (cls.extends === undefined) return undefined;
    const mod = deps.classModule.get(cls.extends);
    return mod !== undefined ? `${namespaceOf(mod, deps.nsRoot)}::${cls.extends}` : undefined;
}

/** A class's full (own + inherited) visible field set — for the self-contained value/binary traits
 *  and field descriptors that must enumerate every field (struct MEMBERS stay own-only). */
function fullFields(cls: IRClassDeclaration, deps: ModuleEmitDeps): IRMember[] {
    return filterVisible(inheritedFields(cls, deps.classBySourceName), deps.includePrivate);
}

/** A class's full (own + inherited) visible behaviors, child overriding by `kind:name`. */
function fullMethods(cls: IRClassDeclaration, deps: ModuleEmitDeps): IRMethod[] {
    const byKey = new Map<string, IRMethod>();
    const chain: IRClassDeclaration[] = [];
    const seen = new Set<string>();
    let cur: IRClassDeclaration | undefined = cls;
    while (cur !== undefined && !seen.has(cur.sourceName)) {
        seen.add(cur.sourceName);
        chain.push(cur);
        cur = cur.extends !== undefined ? deps.classBySourceName.get(cur.extends) : undefined;
    }
    for (let i = chain.length - 1; i >= 0; i--) for (const m of chain[i]!.methods ?? []) byKey.set(`${m.kind}:${m.name}`, m);
    return filterVisible([...byKey.values()], deps.includePrivate);
}

function emitStruct(cls: IRClassDeclaration, deps: ModuleEmitDeps, diagnostics: IRDiagnostic[]): string[] {
    // Real inheritance: the struct holds OWN members and derives from the base. The traits/codecs
    // and field descriptors below use the FULL (own + inherited) set — base members are accessible.
    const stored = filterVisibleFields(cls, deps.includePrivate);
    const baseFqn = baseFqnOf(cls, deps);
    // Getter behaviors are member functions, so a reference to one is a call `this->n()`. Own
    // method bodies may reference inherited getters/ref-fields, so resolve over the full chain.
    const getterNames = new Set(fullMethods(cls, deps).filter((m) => m.kind === "getter").map((m) => m.name));
    const refFieldNames = new Set(fullFields(cls, deps).filter((f) => f.type.kind === "reference").map((f) => f.name));
    const opts: ExprOpts = {
        fieldExpr: (n) => (getterNames.has(n) ? `this->${n}()` : `this->${n}`),
        isRefField: (n) => refFieldNames.has(n),
    };
    const C = cls.sourceName;
    const lines: string[] = [`struct ${C}${baseFqn !== undefined ? ` : ${baseFqn}` : ""} {`];
    lines.push(`    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;`, "");

    // Members (own only — inherited come from the base struct).
    for (const f of stored) lines.push(`    ${memberType(f, deps.cppTypeByName, deps.enumTypeByName)} ${f.name};`);
    lines.push("");

    // Constructors (allocator-aware). Each chains to the base before initializing own members.
    lines.push(`    ${C}() = default;`);
    const baseInit = (args: string): string[] => (baseFqn !== undefined ? [`${baseFqn}(${args})`] : []);
    const allocInits = [...baseInit("a"), ...stored.map((f) => initAllocOnly(f))];
    const copyInits = [...baseInit("o, a"), ...stored.map((f) => initCopy(f))];
    const moveInits = [...baseInit("std::move(o), a"), ...stored.map((f) => initMove(f))];
    if (allocInits.length > 0) {
        lines.push(`    explicit ${C}(const allocator_type& a) : ${allocInits.join(", ")} {}`);
        lines.push(`    ${C}(const ${C}& o, const allocator_type& a) : ${copyInits.join(", ")} {}`);
        lines.push(`    ${C}(${C}&& o, const allocator_type& a) : ${moveInits.join(", ")} {}`);
    } else {
        lines.push(`    explicit ${C}(const allocator_type&) {}`);
        lines.push(`    ${C}(const ${C}&, const allocator_type&) {}`);
        lines.push(`    ${C}(${C}&&, const allocator_type&) {}`);
    }
    lines.push(`    ${C}(const ${C}&) = default;`);
    lines.push(`    ${C}(${C}&&) = default;`);
    lines.push(`    ${C}& operator=(const ${C}&) = default;`);
    lines.push(`    ${C}& operator=(${C}&&) = default;`);

    // get_allocator delegates to the first directly-pmr member, then to the base, else default.
    const allocSrc = stored.find((f) => memberCat(f) === "pmr");
    const allocExpr = allocSrc !== undefined ? `${allocSrc.name}.get_allocator()`
        : baseFqn !== undefined ? `${baseFqn}::get_allocator()`
        : `{}`;
    lines.push(`    allocator_type get_allocator() const noexcept { return ${allocExpr}; }`);
    lines.push("");

    // from_value / to_value: thin members forwarding to keyma::value_traits<C> (defined
    // out-of-line below, after the value_traits specialization).
    lines.push(`    static ${C} from_value(const keyma::Value& v, const allocator_type& a);`);
    lines.push(`    keyma::Value to_value(const allocator_type& a) const;`);

    // Getters, setters, methods, plus the user-authored constructor/destructor — own behaviors
    // re-emitted as member functions (inherited ones come through C++ inheritance).
    for (const m of filterVisibleMethods(cls, deps.includePrivate)) lines.push(...emitMethod(m, C, opts, deps, diagnostics));

    // Typed field descriptors (consumed by keyma/query.hpp). The full set — a child's `f` would
    // otherwise HIDE the base's, so `Child::f::baseField` must resolve here.
    lines.push(...emitFieldDescriptors(C, fullFields(cls, deps), deps));

    lines.push(`    static const keyma::ClassMetadata& metadata();`);
    lines.push(`};`);
    return lines;
}

// ─── Field descriptors (`struct f`) ───────────────────────────────────────────
//
// A nested tag per stored field, carrying its JSON key, logical value type, reference
// target, and FieldKind, so keyma::query.hpp can build COMPILE-TIME-checked typed
// where-clauses / projections (User::f::age) that lower to the same keyma::Value the raw
// API produces. Additive and compile-time only — the runtime metadata (metadata()) is
// unaffected.
function emitFieldDescriptors(C: string, stored: readonly IRMember[], deps: ModuleEmitDeps): string[] {
    if (stored.length === 0) return [];
    const lines: string[] = [`    struct f {`];
    for (const fld of stored) {
        const vt = whereValueType(fld, deps.cppTypeByName, deps.enumTypeByName);
        const rt = refTargetType(fld, deps.cppTypeByName);
        lines.push(
            `        struct ${fld.name}_ { using Owner = ${C}; using Value = ${vt}; using RefTarget = ${rt};` +
            ` static constexpr std::string_view key() { return ${JSON.stringify(fld.name)}; }` +
            ` static constexpr keyma::FieldKind kind = ${fieldKind(fld)}; };`,
        );
    }
    for (const fld of stored) lines.push(`        static constexpr ${fld.name}_ ${fld.name}{};`);
    lines.push(`    };`);
    return lines;
}

function emitMethod(method: IRMethod, C: string, opts: ExprOpts, deps: ModuleEmitDeps, diagnostics: IRDiagnostic[]): string[] {
    // An async method body may use `await`, which has no C++ lowering yet. Record a diagnostic and
    // OMIT the member entirely — never emit a silently-desynced synchronous body (issue 010).
    if (method.async === true) {
        diagnostics.push(asyncDiagnostic(method.kind, method.name, method.source));
        return [];
    }
    // A synthesized method that aggregates errors (`error.collect`) or builds a typed `record`/
    // default on the method allocator needs an in-scope `keyma::alloc_t`. Bind it from the struct's
    // `get_allocator()` and thread it (`opts.allocVar`) into the body. Detected by scanning for the
    // `error.collect` op (the only method-level allocator consumer); plain user methods are unchanged.
    const stmts = methodBodyForBundle(method, deps.bundle);
    const needsAlloc = stmts.some((s) => {
        const ops = new Set<string>();
        collectIntrinsicOpsInStatement(s, ops);
        return ops.has("error.collect");
    });
    const bodyOpts: ExprOpts = needsAlloc ? { ...opts, allocVar: "__a" } : opts;
    const ret: ReturnLowerer = (v, indent) =>
        v === null ? `${indent}return;` : `${indent}return ${exprToCpp(v, bodyOpts)};`;
    const body = [
        ...(needsAlloc ? ["        [[maybe_unused]] const keyma::alloc_t __a = get_allocator();"] : []),
        ...stmts.map((s) => stmtToCpp(s, "        ", ret, bodyOpts)),
    ];
    if (method.kind === "getter") {
        // A getter is a const accessor with a deduced (`auto`) return type.
        return [`    auto ${method.name}() const {`, ...body, `    }`];
    }
    const params = method.params.map((p) => `${irTypeToCpp(p.type, deps.cppTypeByName, deps.enumTypeByName)} ${p.name}`).join(", ");
    if (method.kind === "constructor") {
        // A user-authored constructor — `T(params) { body }`. Coexists with the allocator ctors and
        // the static `from_value` hydration factory (issue 008); a parameterized ctor is a distinct
        // overload, so there is no collision with `T() = default` or `from_value`.
        return [`    ${C}(${params}) {`, ...body, `    }`];
    }
    if (method.kind === "destructor") {
        // A user-authored destructor — `~T() { body }` (no params, no return) (issue 009).
        return [`    ~${C}() {`, ...body, `    }`];
    }
    if (method.kind === "setter") {
        return [`    void set_${method.name}(${params}) {`, ...body, `    }`];
    }
    const retType = method.returnType !== undefined ? "auto" : "void";
    return [`    ${retType} ${method.name}(${params}) {`, ...body, `    }`];
}

// ─── from_value / metadata() out-of-line definitions ────────────────────────────

function emitClassAccessor(cls: IRClassDeclaration, deps: ModuleEmitDeps): string[] {
    const C = cls.sourceName;
    const stored = filterVisibleFields(cls, deps.includePrivate);

    // Thin forwarders to the value_traits<C> specialization (defined just above, in
    // namespace keyma). Keeping the members means consumer code keeps
    // calling `C::from_value(...)` / `obj.to_value(a)` unchanged.
    const forwarders: string[] = [
        `inline ${C} ${C}::from_value(const keyma::Value& v, const allocator_type& a) { return keyma::from_value<${C}>(v, a); }`,
        `inline keyma::Value ${C}::to_value(const allocator_type& a) const { return keyma::value_traits<${C}>::to_value(*this, a); }`,
    ];

    const accessor: string[] = [
        `inline const keyma::ClassMetadata& ${C}::metadata() {`,
        emitClassMeta(
            deps.buildClassData(cls, { includePrivate: deps.includePrivate, bundle: deps.bundle }),
            classRefs(stored, deps),
            baseFqnOf(cls, deps),
        ),
        `}`,
    ];
    return [...forwarders, ...accessor];
}

/**
 * TIER B: `keyma::value_traits<T>` explicit-specialization DECLARATIONS for every
 * same-module struct and every reference target, so a value_traits body that implicitly
 * instantiates a target's value_traits has seen its declaration first (in every TU and
 * include order). Redeclaration across the reference cycle's headers is legal.
 */
function valueTraitsForwardDecls(ns: string, classes: readonly IRClassDeclaration[], deps: ModuleEmitDeps): string[] {
    const out: string[] = [];
    // Forward-declare the same-module structs (defined later in this header) so their own
    // value_traits declaration below — and any sibling's value_traits body — names a
    // declared type. Reference targets are already forward-declared by referenceForwardDecls.
    const sameModule = classes.map((s) => s.sourceName);
    if (sameModule.length > 0) {
        out.push(`namespace ${ns} { ${sameModule.map((c) => `struct ${c};`).join(" ")} }`);
    }
    const fqns = new Set<string>();
    for (const s of classes) {
        const fqn = deps.cppTypeByName.get(s.name);
        if (fqn !== undefined) fqns.add(fqn);
    }
    const fields = classes.flatMap((s) => fullFields(s, deps));
    for (const target of collectTargetsByKind(fields, "reference")) {
        const fqn = deps.cppTypeByName.get(target);
        if (fqn !== undefined) fqns.add(fqn);
    }
    for (const fqn of [...fqns].sort()) out.push(`namespace keyma { template <> struct value_traits<${fqn}>; }`);
    return out;
}

/**
 * Block 2a: the `keyma::value_traits<T>` specialization for one class — the only
 * per-struct serialization code emitted. `from_value` delegates each field to the
 * runtime's generic `keyma::from_value<MemberType>` (or `from_value_field` for a two-axis
 * `Field`); `to_value` rebuilds the record via deduced `keyma::to_value(member, a)` (a
 * scalar selects a runtime overload, a composite the constrained template). A reference
 * target also gets `set_id`/`id_value` so the generic `shared_ptr<T>` traits can build /
 * serialize an id-stub.
 */
/** The `keyma::Value` expression for a field's construction-time default (built on the from_value
 *  allocator `a`), or null when nothing applies (no default, or a null/array literal — the Value
 *  API has no array builder). Field refs inside an expression default
 *  read `v.at("x")` (the input record). */
function fromValueDefaultExpr(def: IRMember["default"]): string | null {
    if (def === undefined) return null;
    const vopts: ExprOpts = { fieldExpr: (n) => `v.at(${JSON.stringify(n)})` };
    if (def.kind === "expression") return `keyma::to_value(${exprToCpp(def.expression, vopts)}, a)`;
    const val = def.value;
    if (val === null || Array.isArray(val)) return null;
    return `keyma::to_value(${exprToCpp({ kind: "literal", value: val } as IRExpression, vopts)}, a)`;
}

function emitValueTraits(cls: IRClassDeclaration, deps: ModuleEmitDeps): string[] {
    const C = deps.cppTypeByName.get(cls.name) ?? cls.sourceName;
    // The traits are self-contained: enumerate the FULL (own + inherited) field set and assign on
    // the derived object — base members are accessible through inheritance. Keeps wire bytes intact.
    const stored = fullFields(cls, deps);

    const fromBody: string[] = [];
    for (const f of stored) {
        const key = JSON.stringify(f.name);
        const { tmpl, field } = traitsArg(f, deps.cppTypeByName, deps.enumTypeByName);
        // Defaults apply at CONSTRUCTION: when the key is absent (a null Value), the field takes its
        // default (round-tripped through a `keyma::Value` so every default kind — literal, enum,
        // expression — flows through the same typed `from_value`). Matches the runtime
        // `apply_defaults` absence test (`v.at(key).is_null()`). Two-axis `Field<T>` + null/array
        // defaults keep the plain path (no construction-time default).
        const dflt = field ? null : fromValueDefaultExpr(f.default);
        if (dflt !== null) {
            fromBody.push(`            __o.${f.name} = v.at(${key}).is_null() ? keyma::from_value<${tmpl}>(${dflt}, a) : keyma::from_value<${tmpl}>(v.at(${key}), a);`);
        } else {
            fromBody.push(field
                ? `            __o.${f.name} = keyma::from_value_field<${tmpl}>(v.find(${key}), a);`
                : `            __o.${f.name} = keyma::from_value<${tmpl}>(v.at(${key}), a);`);
        }
    }
    const toBody = stored.map((f) => `        __v.set(${JSON.stringify(f.name)}, keyma::to_value(x.${f.name}, a));`);

    const lines: string[] = [
        `namespace keyma {`,
        `template <>`,
        `struct value_traits<${C}> {`,
        `    using T = ${C};`,
        `    static T from_value(const keyma::Value& v, keyma::alloc_t a) {`,
        `        T __o(a);`,
        `        if (v.is_object()) {`,
        ...fromBody,
        `        }`,
        `        return __o;`,
        `    }`,
        `    static keyma::Value to_value(const T& x, keyma::alloc_t a) {`,
        `        keyma::Value __v = keyma::Value::object(a);`,
        ...toBody,
        `        return __v;`,
        `    }`,
    ];

    if (deps.referenceTargetNames.has(cls.name)) {
        const idName = deps.idFieldByName.get(cls.name) ?? "id";
        // The id field may be inherited — search the full chain to type the id stub correctly.
        const idField = inheritedFields(cls, deps.classBySourceName).find((f) => f.name === idName);
        const idTmpl = idField !== undefined ? memberType(idField, deps.cppTypeByName, deps.enumTypeByName) : "std::pmr::string";
        lines.push(
            `    static void set_id(T& t, const keyma::Value& idv, keyma::alloc_t a) { t.${idName} = keyma::from_value<${idTmpl}>(idv, a); }`,
            `    static keyma::Value id_value(const T& x, keyma::alloc_t a) { return keyma::to_value(x.${idName}, a); }`,
        );
    }

    lines.push(`};`, `}  // namespace keyma`);
    return lines;
}

// ─── Typed binary codec (keyma::binary_traits<T>) ─────────────────────────────
//
// The struct↔bytes counterpart of value_traits<T>, mirroring it 1:1: forward-declared like
// value_traits (so reference cycles compile), defined in Block 2a after each emitValueTraits.
// encode_record writes per-field key + presence/null framing + payload; decode_record is
// tag-keyed and order-independent. The leaves in keyma/binary-typed.hpp own all payload
// bytes, so the typed path is byte-identical to the dynamic codec (binary.hpp). Reference
// targets additionally get id helpers (the binary analogues of value_traits' set_id/id_value).

/** `keyma::binary_traits<T>` forward declarations for same-module structs + reference targets. */
function binaryTraitsForwardDecls(classes: readonly IRClassDeclaration[], deps: ModuleEmitDeps): string[] {
    const fqns = new Set<string>();
    for (const s of classes) {
        const fqn = deps.cppTypeByName.get(s.name);
        if (fqn !== undefined) fqns.add(fqn);
    }
    const fields = classes.flatMap((s) => fullFields(s, deps));
    for (const target of collectTargetsByKind(fields, "reference")) {
        const fqn = deps.cppTypeByName.get(target);
        if (fqn !== undefined) fqns.add(fqn);
    }
    return [...fqns].sort().map((fqn) => `namespace keyma { template <> struct binary_traits<${fqn}>; }`);
}

/** Block 2a: the `keyma::binary_traits<T>` specialization for one class. */
function emitBinaryTraits(cls: IRClassDeclaration, deps: ModuleEmitDeps): string[] {
    const C = deps.cppTypeByName.get(cls.name) ?? cls.sourceName;
    // Full (own + inherited) set, like value_traits — chain-unique tags keep the flat record valid.
    const stored = fullFields(cls, deps);
    const plans = stored.map((f, i) => binaryFieldPlan(f, i, deps.cppTypeByName, deps.enumTypeByName));

    const encodeLines = plans.flatMap((p) => binaryEncodeField(p));
    const decodeCases = plans.map((p) => binaryDecodeCase(p));

    const lines: string[] = [
        `namespace keyma {`,
        `template <>`,
        `struct binary_traits<${C}> {`,
        `    using T = ${C};`,
        `    static void encode_record(keyma::ByteBuf& out, const T& x, keyma::alloc_t a) {`,
        ...encodeLines,
        `    }`,
        `    static T decode_record(keyma::binary_detail::Reader& r, keyma::alloc_t a) {`,
        `        T __o(a);`,
        `        while (r.pos < r.end) {`,
        `            std::uint64_t __key = keyma::binary_detail::read_varint(r);`,
        `            std::uint32_t tag = (std::uint32_t)(__key >> 3);`,
        `            std::uint8_t wt = (std::uint8_t)(__key & 7);`,
        `            switch (tag) {`,
        ...decodeCases,
        `                default: keyma::binary_detail::skip_value(r, wt);`,
        `            }`,
        `        }`,
        `        return __o;`,
        `    }`,
        // Length-windowed payload methods (+ wiretype), so this struct can itself be an
        // embedded field OR a vector<T> array element — routed via binary_traits<T> like any
        // leaf. encode_record/decode_record stay the top-level (unframed) entry points.
        `    static constexpr std::uint8_t wiretype = keyma::binary_detail::WIRE_LENGTH;`,
        `    static void encode_payload(keyma::ByteBuf& out, const T& x, keyma::alloc_t a) {`,
        `        keyma::ByteBuf __b(a); encode_record(__b, x, a);`,
        `        keyma::binary_detail::write_len_raw(out, std::span<const std::byte>(__b.data(), __b.size()));`,
        `    }`,
        `    static T decode_payload(keyma::binary_detail::Reader& r, std::uint8_t, keyma::alloc_t a) {`,
        `        keyma::binary_detail::Reader __inner = keyma::binary_detail::read_len_window(r);`,
        `        return decode_record(__inner, a);`,
        `    }`,
    ];

    // Reference-target id helpers (route through binary_traits<IdType> so signed-int ids
    // zigzag, unsigned plain, string/Id length — matching the dynamic reference branch).
    if (deps.referenceTargetNames.has(cls.name)) {
        const idName = deps.idFieldByName.get(cls.name) ?? "id";
        // The id field may be inherited — search the full chain.
        const idField = inheritedFields(cls, deps.classBySourceName).find((f) => f.name === idName);
        const idTmpl = idField !== undefined ? memberType(idField, deps.cppTypeByName, deps.enumTypeByName) : "std::pmr::string";
        lines.push(
            `    static constexpr std::uint8_t id_wiretype = keyma::binary_traits<${idTmpl}>::wiretype;`,
            `    static void encode_id_payload(keyma::ByteBuf& out, const T& t, keyma::alloc_t a) { keyma::encode_payload<${idTmpl}>(out, t.${idName}, a); }`,
            `    static void decode_id_into(T& t, keyma::binary_detail::Reader& r, std::uint8_t wt, keyma::alloc_t a) { t.${idName} = keyma::decode_payload<${idTmpl}>(r, wt, a); }`,
        );
    }

    lines.push(`};`, `}  // namespace keyma`);
    return lines;
}

const BIN_NULL = "keyma::binary_detail::WIRE_NULL";

/** Encode lines for one field (8-space indented, inside encode_record's body). */
function binaryEncodeField(p: BinaryFieldPlan): string[] {
    const I = "        ";
    const m = `x.${p.name}`;
    const writeNull = `keyma::binary_detail::write_key(out, ${p.tag}, ${BIN_NULL});`;

    if (p.kind === "reference") {
        const T = p.target!;
        const enc = [
            `${I}if (${m}) { keyma::binary_detail::write_key(out, ${p.tag}, keyma::binary_traits<${T}>::id_wiretype); keyma::binary_traits<${T}>::encode_id_payload(out, *${m}, a); }`,
        ];
        if (p.framing === "null") enc.push(`${I}else { ${writeNull} }`);
        return enc;
    }

    // A writer producing the full "key + payload" for one present, non-null value lvalue.
    // scalar covers embedded (core = target struct, whose binary_traits owns the length window)
    // and arrays (core = vector type) uniformly; json special-cases its inner null.
    const writeKV =
        p.kind === "json"
            ? (lv: string) =>
                // json carries its null INSIDE the Value, so the writer decides WIRE_NULL vs payload.
                `if ((${lv}).is_null()) { ${writeNull} } else { ` +
                `keyma::binary_detail::write_key(out, ${p.tag}, keyma::binary_traits<keyma::Value>::wiretype); ` +
                `keyma::encode_payload<keyma::Value>(out, ${lv}, a); }`
            : (lv: string) =>
                `keyma::binary_detail::write_key(out, ${p.tag}, keyma::binary_traits<${p.core}>::wiretype); ` +
                `keyma::encode_payload<${p.core}>(out, ${lv}, a);`;

    switch (p.framing) {
        case "always":
            return [`${I}${writeKV(m)}`];
        case "omit":
            return [`${I}if (${m}.has_value()) { ${writeKV(`*${m}`)} }`];
        case "null":
            return [`${I}if (${m}.has_value()) { ${writeKV(`*${m}`)} } else { ${writeNull} }`];
        case "field":
            return [
                `${I}if (${m}.present) {`,
                `${I}    if (${m}.value.has_value()) { ${writeKV(`*${m}.value`)} } else { ${writeNull} }`,
                `${I}}`,
            ];
    }
}

/** The `case TAG:` decode line for one field (16-space indented, inside decode_record's switch). */
function binaryDecodeCase(p: BinaryFieldPlan): string {
    const I = "                ";
    const m = `__o.${p.name}`;

    if (p.kind === "reference") {
        const T = p.target!;
        return `${I}case ${p.tag}: if (wt == ${BIN_NULL}) ${m} = nullptr; else { auto __p = std::allocate_shared<${T}>(a); keyma::binary_traits<${T}>::decode_id_into(*__p, r, wt, a); ${m} = __p; } break;`;
    }

    // scalar (incl. embedded & arrays) & json decode identically: decode_payload<core> reads
    // the length-windowed record (embedded), the count-prefixed body (array), or the leaf
    // payload. json's core is keyma::Value; a default Value is null.
    const read = `keyma::decode_payload<${p.core}>(r, wt, a)`;
    switch (p.framing) {
        case "always": return `${I}case ${p.tag}: if (wt == ${BIN_NULL}) {} else ${m} = ${read}; break;`;
        case "omit":
        case "null": return `${I}case ${p.tag}: if (wt == ${BIN_NULL}) ${m} = std::nullopt; else ${m} = ${read}; break;`;
        case "field": return `${I}case ${p.tag}: ${m}.present = true; if (wt == ${BIN_NULL}) ${m}.value.reset(); else ${m}.value = ${read}; break;`;
    }
}

// ─── Member construction helpers ──────────────────────────────────────────────

type Cat = "pmr" | "optPmr" | "optPlain" | "field" | "shared" | "plain";

function memberCat(field: IRMember): Cat {
    // A scalar reference is a shared_ptr: copy/move share ownership (no allocator
    // re-threading); a bare allocate-only ctor leaves it null.
    if (field.type.kind === "reference") return "shared";
    const optional = !field.required;
    const nullable = field.nullable === true;
    const aware = fieldAllocAware(field);
    if (optional && nullable) return "field";
    if (optional || nullable) return aware ? "optPmr" : "optPlain";
    return aware ? "pmr" : "plain";
}

function fieldAllocAware(field: IRMember): boolean {
    return scalarAllocAware(field.type);
}

function scalarAllocAware(t: IRType): boolean {
    switch (t.kind) {
        case "string": case "id": case "date": case "time": case "decimal":
        case "json": case "array": case "bytes":
            return true;
        case "enum":
            // A named enum lowers to a plain `enum class`; an inline union to a pmr string.
            return t.name === undefined;
        default:
            return false;
    }
}

function initAllocOnly(f: IRMember): string {
    switch (memberCat(f)) {
        case "pmr": return `${f.name}(a)`;
        case "plain": return `${f.name}{}`;
        default: return `${f.name}()`;
    }
}
function initCopy(f: IRMember): string {
    switch (memberCat(f)) {
        case "pmr": return `${f.name}(o.${f.name}, a)`;
        case "optPmr": return `${f.name}(keyma::alloc_opt(o.${f.name}, a))`;
        default: return `${f.name}(o.${f.name})`;
    }
}
function initMove(f: IRMember): string {
    switch (memberCat(f)) {
        case "pmr": return `${f.name}(std::move(o.${f.name}), a)`;
        case "optPmr": return `${f.name}(keyma::alloc_opt(std::move(o.${f.name}), a))`;
        default: return `${f.name}(std::move(o.${f.name}))`;
    }
}

// ─── refs / includes / collectors ─────────────────────────────────────────────

function classRefs(fields: IRMember[], deps: ModuleEmitDeps): MetadataRef[] {
    return [...collectRefTargets(fields)]
        .filter((t) => deps.cppTypeByName.has(t))
        .map((name) => ({ name, target: deps.cppTypeByName.get(name)! }));
}

/** Top-of-file includes: embedded targets (by-value, complete type needed), named enums used
 *  by value, and the SOURCE modules of every referenced function — validator/formatter
 *  factories (called by the class metadata) and utility helpers (called by bodies). Reference
 *  targets are deliberately excluded here — see referenceIncludes. */
function buildIncludes(moduleRef: string, classes: readonly IRClassDeclaration[], functions: readonly IRFunctionDeclaration[], deps: ModuleEmitDeps): string[] {
    const refs = new Set<string>();
    // The value/binary traits enumerate the full set, so embedded/enum target headers are needed
    // for inherited fields too (a base member's complete type).
    const allFields = classes.flatMap((s) => fullFields(s, deps));

    // Base class headers: real inheritance needs the complete base type (and transitively brings
    // in the base's own embedded/reference/enum field headers).
    for (const s of classes) {
        if (s.extends === undefined) continue;
        const ref = deps.classModule.get(s.extends);
        if (ref !== undefined && ref !== moduleRef) refs.add(includePath(ref));
    }

    for (const target of collectTargetsByKind(allFields, "embedded")) {
        const className = deps.classNameByName.get(target);
        if (className === undefined) continue;
        const ref = deps.classModule.get(className);
        if (ref !== undefined && ref !== moduleRef) refs.add(includePath(ref));
    }
    for (const enumName of collectEnumTargets(allFields)) {
        const ref = deps.enumModuleByName.get(enumName);
        if (ref !== undefined && ref !== moduleRef) refs.add(includePath(ref));
    }

    // Every referenced function's source module: utility refs from class behaviors/defaults
    // (including the synthesized validate/format* method bodies, which name the factory functions
    // they call), and the helpers the functions homed here call in turn.
    const fnRefs = new Set<string>([
        ...collectFunctionRefs(classes, deps),
    ]);
    for (const fn of functions) {
        const ids = new Set<string>();
        for (const stmt of fn.statements) collectStatementIdentifiers(stmt, ids);
        for (const id of ids) if (deps.functionModule.has(id)) fnRefs.add(id);
    }
    for (const n of fnRefs) {
        const ref = deps.functionModule.get(n);
        if (ref !== undefined && ref !== moduleRef) refs.add(includePath(ref));
    }

    return [...refs].sort();
}

/** Forward declarations (grouped by namespace) for every reference target — full field set, since
 *  the value/binary traits reference inherited fields' targets too. */
function referenceForwardDecls(classes: readonly IRClassDeclaration[], deps: ModuleEmitDeps): string[] {
    const fields = classes.flatMap((s) => fullFields(s, deps));
    const byNs = new Map<string, Set<string>>();
    for (const name of collectTargetsByKind(fields, "reference")) {
        const cls = deps.classNameByName.get(name);
        if (cls === undefined) continue;
        const ref = deps.classModule.get(cls);
        if (ref === undefined) continue;
        const ns = namespaceOf(ref, deps.nsRoot);
        (byNs.get(ns) ?? byNs.set(ns, new Set()).get(ns)!).add(cls);
    }
    return [...byNs.keys()].sort().map((ns) => {
        const decls = [...byNs.get(ns)!].sort().map((c) => `struct ${c};`).join(" ");
        return `namespace ${ns} { ${decls} }`;
    });
}

/** Cross-module reference-target headers, included after the struct definitions — full field set. */
function referenceIncludes(moduleRef: string, classes: readonly IRClassDeclaration[], deps: ModuleEmitDeps): string[] {
    const fields = classes.flatMap((s) => fullFields(s, deps));
    const incs = new Set<string>();
    for (const name of collectTargetsByKind(fields, "reference")) {
        const cls = deps.classNameByName.get(name);
        if (cls === undefined) continue;
        const ref = deps.classModule.get(cls);
        if (ref !== undefined && ref !== moduleRef) incs.add(includePath(ref));
    }
    return [...incs].sort();
}

/** Embedded + reference targets (for the refs metadata map). */
/** Targets of one relation kind (recursing through arrays). */
function collectTargetsByKind(fields: IRMember[], kind: "embedded" | "reference"): Set<string> {
    const out = new Set<string>();
    const collect = (type: IRType): void => {
        if (type.kind === kind) out.add(type.target);
        else if (type.kind === "array") collect(type.of);
    };
    for (const f of fields) collect(f.type);
    return out;
}

/** Names of named enums used by these fields (recursing through arrays). */
function collectEnumTargets(fields: IRMember[]): Set<string> {
    const out = new Set<string>();
    const collect = (type: IRType): void => {
        if (type.kind === "enum" && type.name !== undefined) out.add(type.name);
        else if (type.kind === "array") collect(type.of);
    };
    for (const f of fields) collect(f.type);
    return out;
}

/** Order classes so a same-module base class or embedded target is defined before its user
 *  (real inheritance and by-value embeds both need the complete dependency type first). */
function topoSort(classes: readonly IRClassDeclaration[], deps: ModuleEmitDeps): IRClassDeclaration[] {
    const inModule = new Map(classes.map((s) => [s.sourceName, s]));
    const result: IRClassDeclaration[] = [];
    const seen = new Set<string>();
    const visit = (s: IRClassDeclaration): void => {
        if (seen.has(s.sourceName)) return;
        seen.add(s.sourceName);
        // A same-module base class must be fully defined before the derived struct.
        const baseInModule = s.extends !== undefined ? inModule.get(s.extends) : undefined;
        if (baseInModule !== undefined && baseInModule !== s) visit(baseInModule);
        for (const f of filterVisibleFields(s, deps.includePrivate)) {
            const inner = unwrapArray(f.type);
            if (inner.kind === "embedded") {
                const targetClass = deps.classNameByName.get(inner.target);
                const dep = targetClass !== undefined ? inModule.get(targetClass) : undefined;
                if (dep !== undefined && dep !== s) visit(dep);
            }
        }
        result.push(s);
    };
    for (const s of classes) visit(s);
    return result;
}

