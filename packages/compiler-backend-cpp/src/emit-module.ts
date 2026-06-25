import type {
    IRSchema, IRField, IRType, IRMethod, IREnumDeclaration,
    IRValidatorDeclaration, IRFormatterDeclaration,
} from "@keyma/ir";
import { collectRefTargets, collectFunctionRefs, unwrapArray, filterVisibleFields, filterVisibleMethods } from "@keyma/compiler-util";
import { exprToCpp, type ExprOpts } from "./emit-expression.js";
import { stmtToCpp, factoryIdent, type ReturnLowerer } from "./emit-validators.js";
import { irTypeToCpp, memberType, traitsArg, whereValueType, fieldKind, refTargetType } from "./ir-type-to-cpp.js";
import { buildSchemaMeta } from "./schema-data.js";
import { buildApplyDefaults } from "./emit-defaults.js";
import { emitEnumClass, emitEnumConversions } from "./emit-enum.js";
import { includePath, namespaceOf, cppSanitizer } from "./module-path.js";

export type ModuleEmitDeps = {
    includePrivate: boolean;
    includeIndexes: boolean;
    formPhasesOnly: boolean;
    includeDefaults: boolean;
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
    validatorDecls: ReadonlyMap<string, IRValidatorDeclaration>;
    formatterDecls: ReadonlyMap<string, IRFormatterDeclaration>;
    functionNames: ReadonlySet<string>;
    validatorsModuleRef: string;
    formattersModuleRef: string;
    functionsModuleRef: string;
    /** Complete `#include` token (with delimiters) for the runtime header. */
    runtimeInclude: string;
};

const CLIENT_PHASES = new Set(["change", "blur", "submit"]);

export function emitModuleCpp(
    moduleRef: string,
    schemas: readonly IRSchema[],
    enums: readonly IREnumDeclaration[],
    deps: ModuleEmitDeps,
): string {
    const ordered = topoSort(schemas, deps);
    const ns = namespaceOf(moduleRef, deps.nsRoot);
    const funcsUsed = collectFunctionRefs(schemas, deps);

    const lines: string[] = ["#pragma once", `#include ${deps.runtimeInclude}`];
    for (const inc of buildIncludes(moduleRef, schemas, deps, funcsUsed.size > 0)) lines.push(`#include "${inc}"`);

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

    // ── Enums first: definitions + keyma:: conversions + std::formatter, all BEFORE
    // the structs. A getter may interpolate an enum via std::format (analyzed
    // in complete-class context), so the formatter specialization must already be seen. ──
    if (enums.length > 0) {
        lines.push("", `namespace ${ns} {`);
        for (const e of enums) lines.push(emitEnumClass(e));
        lines.push(`}  // namespace ${ns}`, "");
        for (const e of enums) {
            lines.push(emitEnumConversions(e, deps.enumTypeByName.get(e.name) ?? `${ns}::${cppSanitizer(e.name)}`), "");
        }
    }

    // ── Structs ──
    lines.push(`namespace ${ns} {`);
    if (funcsUsed.size > 0) lines.push(`using namespace ${deps.nsRoot}::functions;`);
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
    for (const schema of ordered) { lines.push(...emitValueTraits(schema, deps)); lines.push(""); }

    // ── Block 2b: out-of-line apply_defaults / schema() + the thin
    // from_value/to_value forwarder definitions (after the value_traits they delegate to). ──
    lines.push(`namespace ${ns} {`);
    if (funcsUsed.size > 0) lines.push(`using namespace ${deps.nsRoot}::functions;`);
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

// ─── Struct ───────────────────────────────────────────────────────────────────

function emitStruct(schema: IRSchema, deps: ModuleEmitDeps): string[] {
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

function emitSchemaAccessor(schema: IRSchema, deps: ModuleEmitDeps): string[] {
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
        buildSchemaMeta(schema, {
            includePrivate: deps.includePrivate,
            includeIndexes: deps.includeIndexes,
            formPhasesOnly: deps.formPhasesOnly,
            validatorDecls: deps.validatorDecls,
            formatterDecls: deps.formatterDecls,
            nsRoot: deps.nsRoot,
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
function valueTraitsForwardDecls(ns: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps): string[] {
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
function emitValueTraits(schema: IRSchema, deps: ModuleEmitDeps): string[] {
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

/** Top-of-file includes: embedded targets (by-value, complete type needed) and named
 *  enums used by value, plus the validator/formatter/function bundles. Reference
 *  targets are deliberately excluded here — see referenceIncludes. */
function buildIncludes(moduleRef: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps, hasFunctions: boolean): string[] {
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

    let anyValidators = false;
    let anyFormatters = false;
    for (const f of allFields) {
        if (f.validators.length > 0) anyValidators = true;
        const fmts = deps.formPhasesOnly ? f.formatters.filter((fm) => CLIENT_PHASES.has(fm.phase)) : f.formatters;
        if (fmts.length > 0) anyFormatters = true;
    }
    if (anyValidators) refs.add(includePath(deps.validatorsModuleRef));
    if (anyFormatters) refs.add(includePath(deps.formattersModuleRef));
    if (hasFunctions) refs.add(includePath(deps.functionsModuleRef));

    return [...refs].sort();
}

/** Forward declarations (grouped by namespace) for every reference target. */
function referenceForwardDecls(schemas: readonly IRSchema[], deps: ModuleEmitDeps): string[] {
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
function referenceIncludes(moduleRef: string, schemas: readonly IRSchema[], deps: ModuleEmitDeps): string[] {
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
function topoSort(schemas: readonly IRSchema[], deps: ModuleEmitDeps): IRSchema[] {
    const inModule = new Map(schemas.map((s) => [s.sourceName, s]));
    const result: IRSchema[] = [];
    const seen = new Set<string>();
    const visit = (s: IRSchema): void => {
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

