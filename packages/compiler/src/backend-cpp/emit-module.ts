import type {
    IRClassDeclaration, IRField, IRType, IRMethod, IREnumDeclaration,
    IRFunctionDeclaration,
} from "@keyma/core/ir";
import { collectRefTargets, collectFunctionRefs, collectStatementIdentifiers, unwrapArray, filterVisibleFields, filterVisibleMethods } from "@keyma/core/util";
import { exprToCpp, type ExprOpts } from "./emit-expression.js";
import { stmtToCpp, plainReturn, factoryIdent, type ReturnLowerer } from "./emit-validators.js";
import { irTypeToCpp, memberType, traitsArg, whereValueType, fieldKind, refTargetType, binaryFieldPlan, type BinaryFieldPlan } from "./ir-type-to-cpp.js";
import type { BuildSchemaMeta, EmitEnumClass, EmitEnumConversions } from "./emitter-registry.js";
import { buildApplyDefaults } from "./emit-defaults.js";
import { includePath, namespaceOf, cppSanitizer } from "./module-path.js";

export type ModuleEmitDeps = {
    includePrivate: boolean;
    includeIndexes: boolean;
    formPhasesOnly: boolean;
    includeDefaults: boolean;
    /** Emit the typed binary codec (keyma::binary_traits<T>) alongside value_traits. Driven
     *  by the project's `binary` config; off ⇒ JSON-only output is byte-for-byte unchanged. */
    binary: boolean;
    nsRoot: string;
    /** sourceName → bundle-relative module ref (e.g. "models/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** Reference/embedded/edge target `name` → emitted C++ class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → fully-qualified C++ struct type. */
    cppTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → fully-qualified C++ `enum class` type. */
    enumTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → bundle-relative module ref of its declaring file. */
    enumModuleByName: ReadonlyMap<string, string>;
    /** Schema `name` → its id field's name (for reference id-stubs). */
    idFieldByName: ReadonlyMap<string, string>;
    /** Schema `name`s that are the target of some reference (carry id-stub helpers). */
    referenceTargetNames: ReadonlySet<string>;
    /** Every project-local function declaration keyed by name (a domain pack reads a
     *  validator/formatter factory's params for factory-call arg ordering). */
    functionDecls: ReadonlyMap<string, IRFunctionDeclaration>;
    functionNames: ReadonlySet<string>;
    /** Function name → bundle-relative module ref of its declaring file (e.g. "src/validators",
     *  "vendor"). Cross-module function refs resolve through here, like reference targets. */
    functionModule: ReadonlyMap<string, string>;
    /** Names of the functions rendered with the domain wrapper (validators/formatters) rather
     *  than as plain functions. The matching renderings come from `renderClaimedFunctions`. */
    claimedFunctionNames: ReadonlySet<string>;
    /** Render the claimed (validator/formatter) functions a module owns, with the domain
     *  wrapper. Present whenever `claimedFunctionNames` is non-empty. */
    renderClaimedFunctions?: (decls: readonly IRFunctionDeclaration[]) => readonly string[];
    /** Complete `#include` token (with delimiters) for the runtime header. */
    runtimeInclude: string;
    /** Domain-supplied builders (from the emitter registry's schema pack) — keep the
     *  generic module emitter domain-agnostic: the per-schema `schema()` metadata body
     *  and the named-enum `class` + keyma conversions. */
    buildSchemaMeta: BuildSchemaMeta;
    emitEnumClass: EmitEnumClass;
    emitEnumConversions: EmitEnumConversions;
};

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

export function emitModuleCpp(
    moduleRef: string,
    schemas: readonly IRClassDeclaration[],
    enums: readonly IREnumDeclaration[],
    functions: readonly IRFunctionDeclaration[],
    deps: ModuleEmitDeps,
): string {
    const ordered = topoSort(schemas, deps);
    const ns = namespaceOf(moduleRef, deps.nsRoot);

    // Cross-module utility-function home namespaces this module's bodies call by bare name
    // (class behaviors/defaults + the bodies of the functions homed here). They resolve via
    // per-module using-directives — replacing the old shared `using namespace <root>::functions`.
    // Validator/formatter factory refs in the schema metadata are fully qualified separately
    // (like reference targets), so they are not part of this set.
    const usingDirectives = crossModuleFnUsings(moduleRef, schemas, functions, deps);
    const useLines = usingDirectives.map((u) => `using namespace ${u};`);

    const lines: string[] = ["#pragma once", `#include ${deps.runtimeInclude}`];
    // A claimed formatter's runtime guard throws std::runtime_error, so a module that owns any
    // domain-wrapped factory pulls in <stdexcept> (the old shared formatters.hpp did the same).
    if (functions.some((d) => deps.claimedFunctionNames.has(d.name))) lines.push(`#include <stdexcept>`);
    // The typed binary codec lives in a separate runtime header (keeps the binary-only
    // primitives out of the baked runtime.hpp); pulled in only when binary is enabled.
    if (deps.binary && schemas.length > 0) lines.push(`#include <keyma/binary-typed.hpp>`);
    for (const inc of buildIncludes(moduleRef, schemas, functions, deps)) lines.push(`#include "${inc}"`);

    if (schemas.length > 0) {
        // Forward declarations for every reference target (same- and cross-module). A
        // std::shared_ptr<T> member needs only a forward declaration, which lets legal
        // reference cycles compile (the complete type is pulled in after the structs).
        const fwd = referenceForwardDecls(schemas, deps);
        if (fwd.length > 0) { lines.push(""); lines.push(...fwd); }

        // value_traits explicit-specialization DECLARATIONS for every same-module struct and
        // reference target, before any struct whose value_traits would implicitly instantiate
        // a target's. This guarantees "declared before first use" in every translation unit
        // and both include orders — required for the reference cycle to be well-formed
        // ([temp.expl.spec]); redeclaration across the cycle's headers is legal.
        const traitDecls = valueTraitsForwardDecls(ns, schemas, deps);
        if (traitDecls.length > 0) { lines.push(""); lines.push(...traitDecls); }

        // binary_traits explicit-specialization forward declarations (same discipline as
        // value_traits) so a binary_traits body that names a sibling's or a reference target's
        // binary_traits has seen its declaration first. Gated on deps.binary.
        if (deps.binary) {
            const binDecls = binaryTraitsForwardDecls(schemas, deps);
            if (binDecls.length > 0) lines.push(...binDecls);
        }
    }

    // ── Enums first: definitions + keyma:: conversions + std::formatter, all BEFORE
    // the structs. A getter may interpolate an enum via std::format (analyzed
    // in complete-class context), so the formatter specialization must already be seen. ──
    if (enums.length > 0) {
        lines.push("", `namespace ${ns} {`);
        for (const e of enums) lines.push(deps.emitEnumClass(e));
        lines.push(`}  // namespace ${ns}`, "");
        for (const e of enums) {
            lines.push(deps.emitEnumConversions(e, deps.enumTypeByName.get(e.name) ?? `${ns}::${cppSanitizer(e.name)}`, deps.binary), "");
        }
    }

    // ── Functions homed in this module: plain utilities + the domain-wrapped validator/
    // formatter factories. Emitted before the structs so same-module behaviors can call them;
    // a function-only source file (e.g. validators.ts) produces just this block. ──
    if (functions.length > 0) {
        const utility = functions.filter((d) => !deps.claimedFunctionNames.has(d.name));
        const claimed = functions.filter((d) => deps.claimedFunctionNames.has(d.name));
        const claimedRenderings = claimed.length > 0 && deps.renderClaimedFunctions !== undefined
            ? deps.renderClaimedFunctions(claimed) : [];
        lines.push("", `namespace ${ns} {`);
        if (useLines.length > 0) { lines.push(...useLines); }
        lines.push("");
        for (const decl of utility) { lines.push(...emitFunctionCpp(decl)); lines.push(""); }
        for (const r of claimedRenderings) { lines.push(r, ""); }
        lines.push(`}  // namespace ${ns}`, "");
    }

    if (schemas.length === 0) return lines.join("\n");

    // ── Structs ──
    lines.push(`namespace ${ns} {`);
    if (useLines.length > 0) lines.push(...useLines);
    lines.push("");
    for (const schema of ordered) {
        lines.push(...emitStruct(schema, deps));
        lines.push(`static_assert(std::uses_allocator_v<${schema.sourceName}, ${schema.sourceName}::allocator_type>);`, "");
    }
    lines.push(`}  // namespace ${ns}`, "");

    // Reference-target includes — at file scope, AFTER the struct definitions so
    // from_value sees the complete target types. With #pragma once this ordering
    // breaks reference cycles: every struct in a cycle is defined before any
    // from_value body (which allocate_shared's the target) is parsed.
    const refIncludes = referenceIncludes(moduleRef, schemas, deps);
    if (refIncludes.length > 0) { for (const inc of refIncludes) lines.push(`#include "${inc}"`); lines.push(""); }

    // ── Block 2a: value_traits specializations (namespace keyma, file scope). Every
    // same-module struct and reference target is now a complete type, and every
    // value_traits is at least declared above, so the per-field cross-references resolve.
    // All cross-trait references live in function bodies → instantiated lazily at the
    // consumer's odr-use, where every specialization is fully defined. ──
    for (const schema of ordered) {
        lines.push(...emitValueTraits(schema, deps));
        if (deps.binary) lines.push(...emitBinaryTraits(schema, deps));
        lines.push("");
    }

    // ── Block 2b: out-of-line apply_defaults / schema() + the thin
    // from_value/to_value forwarder definitions (after the value_traits they delegate to). ──
    lines.push(`namespace ${ns} {`);
    if (useLines.length > 0) lines.push(...useLines);
    lines.push("");

    if (deps.includeDefaults) {
        for (const schema of ordered) {
            const ad = buildApplyDefaults(schema, deps.includePrivate);
            if (ad !== null) lines.push(ad.def, "");
        }
    }
    for (const schema of ordered) {
        lines.push(...emitSchemaAccessor(schema, deps));
        lines.push("");
    }

    lines.push(`}  // namespace ${ns}`, "");
    return lines.join("\n");
}

/** Emit a plain project-local utility function as an inline free function. */
function emitFunctionCpp(decl: IRFunctionDeclaration): string[] {
    const params = decl.params.map((p) => `${irTypeToCpp(p.type)} ${p.name}`).join(", ");
    const lines = [`inline auto ${decl.name}(${params}) {`];
    for (const stmt of decl.statements) lines.push(stmtToCpp(stmt, "    ", plainReturn));
    lines.push(`}`);
    return lines;
}

/** The distinct cross-module utility-function home namespaces this module references by bare
 *  name (from class behaviors/defaults and the bodies of the functions homed here). */
function crossModuleFnUsings(
    moduleRef: string,
    schemas: readonly IRClassDeclaration[],
    functions: readonly IRFunctionDeclaration[],
    deps: ModuleEmitDeps,
): string[] {
    const names = new Set<string>(collectFunctionRefs(schemas, deps));
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

function emitStruct(schema: IRClassDeclaration, deps: ModuleEmitDeps): string[] {
    const fields = filterVisibleFields(schema, deps.includePrivate);
    const stored = fields;
    // Getter behaviors are member functions, so a reference to one is a call `this->n()`.
    const getterNames = new Set(filterVisibleMethods(schema, deps.includePrivate).filter((m) => m.kind === "getter").map((m) => m.name));
    const refFieldNames = new Set(fields.filter((f) => f.type.kind === "reference").map((f) => f.name));
    const opts: ExprOpts = {
        fieldExpr: (n) => (getterNames.has(n) ? `this->${n}()` : `this->${n}`),
        isRefField: (n) => refFieldNames.has(n),
    };
    const C = schema.sourceName;
    const lines: string[] = [`struct ${C} {`];
    lines.push(`    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;`, "");

    // Members.
    for (const f of stored) lines.push(`    ${memberType(f, deps.cppTypeByName, deps.enumTypeByName)} ${f.name};`);
    lines.push("");

    // Constructors (allocator-aware).
    lines.push(`    ${C}() = default;`);
    if (stored.length > 0) {
        lines.push(`    explicit ${C}(const allocator_type& a) : ${stored.map((f) => initAllocOnly(f)).join(", ")} {}`);
        lines.push(`    ${C}(const ${C}& o, const allocator_type& a) : ${stored.map((f) => initCopy(f)).join(", ")} {}`);
        lines.push(`    ${C}(${C}&& o, const allocator_type& a) : ${stored.map((f) => initMove(f)).join(", ")} {}`);
    } else {
        lines.push(`    explicit ${C}(const allocator_type&) {}`);
        lines.push(`    ${C}(const ${C}&, const allocator_type&) {}`);
        lines.push(`    ${C}(${C}&&, const allocator_type&) {}`);
    }
    lines.push(`    ${C}(const ${C}&) = default;`);
    lines.push(`    ${C}(${C}&&) = default;`);
    lines.push(`    ${C}& operator=(const ${C}&) = default;`);
    lines.push(`    ${C}& operator=(${C}&&) = default;`);

    // get_allocator delegates to the first directly-pmr member, if any.
    const allocSrc = stored.find((f) => memberCat(f) === "pmr");
    lines.push(
        allocSrc !== undefined
            ? `    allocator_type get_allocator() const noexcept { return ${allocSrc.name}.get_allocator(); }`
            : `    allocator_type get_allocator() const noexcept { return {}; }`,
    );
    lines.push("");

    // from_value / to_value: thin members forwarding to keyma::value_traits<C> (defined
    // out-of-line below, after the value_traits specialization).
    lines.push(`    static ${C} from_value(const keyma::Value& v, const allocator_type& a);`);
    lines.push(`    keyma::Value to_value(const allocator_type& a) const;`);

    // Getters, setters, and methods — all behaviors re-emitted as member functions.
    for (const m of filterVisibleMethods(schema, deps.includePrivate)) lines.push(...emitMethod(m, opts, deps));

    // Typed field descriptors (consumed by keyma/query.hpp's where/projection DSL).
    lines.push(...emitFieldDescriptors(C, stored, deps));

    lines.push(`    static const keyma::SchemaMeta& schema();`);
    lines.push(`};`);
    return lines;
}

// ─── Field descriptors (`struct f`) ───────────────────────────────────────────
//
// A nested tag per stored field, carrying its JSON key, logical value type, reference
// target, and FieldKind, so keyma::query.hpp can build COMPILE-TIME-checked typed
// where-clauses / projections (User::f::age) that lower to the same keyma::Value the raw
// API produces. Additive and compile-time only — the runtime metadata (schema()) is
// unaffected.
function emitFieldDescriptors(C: string, stored: readonly IRField[], deps: ModuleEmitDeps): string[] {
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

function emitMethod(method: IRMethod, opts: ExprOpts, deps: ModuleEmitDeps): string[] {
    const ret: ReturnLowerer = (v, indent) =>
        v === null ? `${indent}return;` : `${indent}return ${exprToCpp(v, opts)};`;
    const body = method.statements.map((s) => stmtToCpp(s, "        ", ret, opts));
    if (method.kind === "getter") {
        // A getter is a const accessor with a deduced (`auto`) return type.
        return [`    auto ${method.name}() const {`, ...body, `    }`];
    }
    const params = method.params.map((p) => `${irTypeToCpp(p.type, deps.cppTypeByName, deps.enumTypeByName)} ${p.name}`).join(", ");
    if (method.kind === "setter") {
        return [`    void set_${method.name}(${params}) {`, ...body, `    }`];
    }
    const retType = method.returnType !== undefined ? "auto" : "void";
    return [`    ${retType} ${method.name}(${params}) {`, ...body, `    }`];
}

// ─── from_value / schema() out-of-line definitions ────────────────────────────

function emitSchemaAccessor(schema: IRClassDeclaration, deps: ModuleEmitDeps): string[] {
    const C = schema.sourceName;
    const stored = filterVisibleFields(schema, deps.includePrivate);

    // Thin forwarders to the value_traits<C> specialization (defined just above, in
    // namespace keyma). Keeping the members means consumer code keeps
    // calling `C::from_value(...)` / `obj.to_value(a)` unchanged.
    const forwarders: string[] = [
        `inline ${C} ${C}::from_value(const keyma::Value& v, const allocator_type& a) { return keyma::from_value<${C}>(v, a); }`,
        `inline keyma::Value ${C}::to_value(const allocator_type& a) const { return keyma::value_traits<${C}>::to_value(*this, a); }`,
    ];

    // apply_defaults reference (server only).
    const ad = deps.includeDefaults ? buildApplyDefaults(schema, deps.includePrivate) : null;

    const accessor: string[] = [
        `inline const keyma::SchemaMeta& ${C}::schema() {`,
        deps.buildSchemaMeta(schema, {
            includePrivate: deps.includePrivate,
            includeIndexes: deps.includeIndexes,
            formPhasesOnly: deps.formPhasesOnly,
            functionDecls: deps.functionDecls,
            nsRoot: deps.nsRoot,
            functionNamespace: (name) => {
                const home = deps.functionModule.get(name);
                return home !== undefined ? namespaceOf(home, deps.nsRoot) : deps.nsRoot;
            },
            refs: schemaRefs(stored, deps),
            ...(ad !== null ? { applyDefaultsName: ad.name } : {}),
        }),
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
function valueTraitsForwardDecls(ns: string, schemas: readonly IRClassDeclaration[], deps: ModuleEmitDeps): string[] {
    const out: string[] = [];
    // Forward-declare the same-module structs (defined later in this header) so their own
    // value_traits declaration below — and any sibling's value_traits body — names a
    // declared type. Reference targets are already forward-declared by referenceForwardDecls.
    const sameModule = schemas.map((s) => s.sourceName);
    if (sameModule.length > 0) {
        out.push(`namespace ${ns} { ${sameModule.map((c) => `struct ${c};`).join(" ")} }`);
    }
    const fqns = new Set<string>();
    for (const s of schemas) {
        const fqn = deps.cppTypeByName.get(s.name);
        if (fqn !== undefined) fqns.add(fqn);
    }
    const fields = schemas.flatMap((s) => filterVisibleFields(s, deps.includePrivate));
    for (const target of collectTargetsByKind(fields, "reference")) {
        const fqn = deps.cppTypeByName.get(target);
        if (fqn !== undefined) fqns.add(fqn);
    }
    for (const fqn of [...fqns].sort()) out.push(`namespace keyma { template <> struct value_traits<${fqn}>; }`);
    return out;
}

/**
 * Block 2a: the `keyma::value_traits<T>` specialization for one schema — the only
 * per-struct serialization code emitted. `from_value` delegates each field to the
 * runtime's generic `keyma::from_value<MemberType>` (or `from_value_field` for a two-axis
 * `Field`); `to_value` rebuilds the record via deduced `keyma::to_value(member, a)` (a
 * scalar selects a runtime overload, a composite the constrained template). A reference
 * target also gets `set_id`/`id_value` so the generic `shared_ptr<T>` traits can build /
 * serialize an id-stub.
 */
function emitValueTraits(schema: IRClassDeclaration, deps: ModuleEmitDeps): string[] {
    const C = deps.cppTypeByName.get(schema.name) ?? schema.sourceName;
    const stored = filterVisibleFields(schema, deps.includePrivate);

    const fromBody: string[] = [];
    for (const f of stored) {
        const key = JSON.stringify(f.name);
        const { tmpl, field } = traitsArg(f, deps.cppTypeByName, deps.enumTypeByName);
        fromBody.push(field
            ? `            __o.${f.name} = keyma::from_value_field<${tmpl}>(v.find(${key}), a);`
            : `            __o.${f.name} = keyma::from_value<${tmpl}>(v.at(${key}), a);`);
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

    if (deps.referenceTargetNames.has(schema.name)) {
        const idName = deps.idFieldByName.get(schema.name) ?? "id";
        const idField = schema.fields.find((f) => f.name === idName);
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
function binaryTraitsForwardDecls(schemas: readonly IRClassDeclaration[], deps: ModuleEmitDeps): string[] {
    const fqns = new Set<string>();
    for (const s of schemas) {
        const fqn = deps.cppTypeByName.get(s.name);
        if (fqn !== undefined) fqns.add(fqn);
    }
    const fields = schemas.flatMap((s) => filterVisibleFields(s, deps.includePrivate));
    for (const target of collectTargetsByKind(fields, "reference")) {
        const fqn = deps.cppTypeByName.get(target);
        if (fqn !== undefined) fqns.add(fqn);
    }
    return [...fqns].sort().map((fqn) => `namespace keyma { template <> struct binary_traits<${fqn}>; }`);
}

/** Block 2a: the `keyma::binary_traits<T>` specialization for one schema. */
function emitBinaryTraits(schema: IRClassDeclaration, deps: ModuleEmitDeps): string[] {
    const C = deps.cppTypeByName.get(schema.name) ?? schema.sourceName;
    const stored = filterVisibleFields(schema, deps.includePrivate);
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
    if (deps.referenceTargetNames.has(schema.name)) {
        const idName = deps.idFieldByName.get(schema.name) ?? "id";
        const idField = schema.fields.find((f) => f.name === idName);
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

function memberCat(field: IRField): Cat {
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

function fieldAllocAware(field: IRField): boolean {
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

function initAllocOnly(f: IRField): string {
    switch (memberCat(f)) {
        case "pmr": return `${f.name}(a)`;
        case "plain": return `${f.name}{}`;
        default: return `${f.name}()`;
    }
}
function initCopy(f: IRField): string {
    switch (memberCat(f)) {
        case "pmr": return `${f.name}(o.${f.name}, a)`;
        case "optPmr": return `${f.name}(keyma::alloc_opt(o.${f.name}, a))`;
        default: return `${f.name}(o.${f.name})`;
    }
}
function initMove(f: IRField): string {
    switch (memberCat(f)) {
        case "pmr": return `${f.name}(std::move(o.${f.name}), a)`;
        case "optPmr": return `${f.name}(keyma::alloc_opt(std::move(o.${f.name}), a))`;
        default: return `${f.name}(std::move(o.${f.name}))`;
    }
}

// ─── refs / includes / collectors ─────────────────────────────────────────────

function schemaRefs(fields: IRField[], deps: ModuleEmitDeps): { name: string; cppClass: string }[] {
    return [...collectRefTargets(fields)]
        .filter((t) => deps.cppTypeByName.has(t))
        .map((name) => ({ name, cppClass: deps.cppTypeByName.get(name)! }));
}

// Validator/formatter attachments now ride in the field's `extensions['schema']` slice
// (a schema-domain concern). The generic module emitter still needs the referenced factory
// names to wire each model header's `#include` of the factory's SOURCE module — a transitional
// read of the well-known slice keeps that include wiring here without depending on `@keyma/schema`.
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

/** Top-of-file includes: embedded targets (by-value, complete type needed), named enums used
 *  by value, and the SOURCE modules of every referenced function — validator/formatter
 *  factories (called by the schema metadata) and utility helpers (called by bodies). Reference
 *  targets are deliberately excluded here — see referenceIncludes. */
function buildIncludes(moduleRef: string, schemas: readonly IRClassDeclaration[], functions: readonly IRFunctionDeclaration[], deps: ModuleEmitDeps): string[] {
    const refs = new Set<string>();
    const allFields = schemas.flatMap((s) => filterVisibleFields(s, deps.includePrivate));

    for (const target of collectTargetsByKind(allFields, "embedded")) {
        const className = deps.classNameByName.get(target);
        if (className === undefined) continue;
        const ref = deps.schemaModule.get(className);
        if (ref !== undefined && ref !== moduleRef) refs.add(includePath(ref));
    }
    for (const enumName of collectEnumTargets(allFields)) {
        const ref = deps.enumModuleByName.get(enumName);
        if (ref !== undefined && ref !== moduleRef) refs.add(includePath(ref));
    }

    // Every referenced function's source module: factory refs from field metadata, utility refs
    // from class behaviors/defaults, and the helpers the functions homed here call in turn.
    const fnRefs = new Set<string>([
        ...collectFactoryNames(allFields, "validators", deps.formPhasesOnly),
        ...collectFactoryNames(allFields, "formatters", deps.formPhasesOnly),
        ...collectFunctionRefs(schemas, deps),
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

/** Forward declarations (grouped by namespace) for every reference target. */
function referenceForwardDecls(schemas: readonly IRClassDeclaration[], deps: ModuleEmitDeps): string[] {
    const fields = schemas.flatMap((s) => filterVisibleFields(s, deps.includePrivate));
    const byNs = new Map<string, Set<string>>();
    for (const name of collectTargetsByKind(fields, "reference")) {
        const cls = deps.classNameByName.get(name);
        if (cls === undefined) continue;
        const ref = deps.schemaModule.get(cls);
        if (ref === undefined) continue;
        const ns = namespaceOf(ref, deps.nsRoot);
        (byNs.get(ns) ?? byNs.set(ns, new Set()).get(ns)!).add(cls);
    }
    return [...byNs.keys()].sort().map((ns) => {
        const decls = [...byNs.get(ns)!].sort().map((c) => `struct ${c};`).join(" ");
        return `namespace ${ns} { ${decls} }`;
    });
}

/** Cross-module reference-target headers, included after the struct definitions. */
function referenceIncludes(moduleRef: string, schemas: readonly IRClassDeclaration[], deps: ModuleEmitDeps): string[] {
    const fields = schemas.flatMap((s) => filterVisibleFields(s, deps.includePrivate));
    const incs = new Set<string>();
    for (const name of collectTargetsByKind(fields, "reference")) {
        const cls = deps.classNameByName.get(name);
        if (cls === undefined) continue;
        const ref = deps.schemaModule.get(cls);
        if (ref !== undefined && ref !== moduleRef) incs.add(includePath(ref));
    }
    return [...incs].sort();
}

/** Embedded + reference targets (for the refs metadata map). */
/** Targets of one relation kind (recursing through arrays). */
function collectTargetsByKind(fields: IRField[], kind: "embedded" | "reference"): Set<string> {
    const out = new Set<string>();
    const collect = (type: IRType): void => {
        if (type.kind === kind) out.add(type.schema);
        else if (type.kind === "array") collect(type.of);
    };
    for (const f of fields) collect(f.type);
    return out;
}

/** Names of named enums used by these fields (recursing through arrays). */
function collectEnumTargets(fields: IRField[]): Set<string> {
    const out = new Set<string>();
    const collect = (type: IRType): void => {
        if (type.kind === "enum" && type.name !== undefined) out.add(type.name);
        else if (type.kind === "array") collect(type.of);
    };
    for (const f of fields) collect(f.type);
    return out;
}

/** Order schemas so a same-module embedded target is defined before its user (by-value). */
function topoSort(schemas: readonly IRClassDeclaration[], deps: ModuleEmitDeps): IRClassDeclaration[] {
    const inModule = new Map(schemas.map((s) => [s.sourceName, s]));
    const result: IRClassDeclaration[] = [];
    const seen = new Set<string>();
    const visit = (s: IRClassDeclaration): void => {
        if (seen.has(s.sourceName)) return;
        seen.add(s.sourceName);
        for (const f of filterVisibleFields(s, deps.includePrivate)) {
            const inner = unwrapArray(f.type);
            if (inner.kind === "embedded") {
                const targetClass = deps.classNameByName.get(inner.schema);
                const dep = targetClass !== undefined ? inModule.get(targetClass) : undefined;
                if (dep !== undefined && dep !== s) visit(dep);
            }
        }
        result.push(s);
    };
    for (const s of schemas) visit(s);
    return result;
}

