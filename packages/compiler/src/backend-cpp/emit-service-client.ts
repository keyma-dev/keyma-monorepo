import type { IRService, IRType } from "@keyma/core/ir";
import { filterVisible } from "@keyma/core/util";
import { irTypeToCpp } from "./ir-type-to-cpp.js";
import { includePath } from "./module-path.js";
import type { ServiceClientEmitDeps } from "./emitter-registry.js";

// `@Service`/RPC is a base-language concern the compiler owns end-to-end: the bundle shell
// calls this emitter directly on `ir.services`. No domain pack participates.

/**
 * Emit `service-client.hpp`: one struct per service in `<nsRoot>::client`, with a static
 * typed builder per method returning a `keyma::CallLeaf<Ret>`. It is the C++ counterpart of
 * the typed `Keyma.call` in runtime-js's query builder — the args object is built from the
 * IR-declared params (typed in, lowered via keyma::to_value), the call is dispatched as a
 * leaf, and `keyma::send` hydrates the response to `Ret` (a scalar/struct/vector/void).
 *
 * Unlike the model headers, this one depends on <keyma/client.hpp> (for CallLeaf / Keyma::call):
 * calling a service inherently needs the runtime transport, so it is never zero-dependency.
 * It is therefore an OPT-IN header — not pulled in by index.hpp — so a vendored model bundle
 * stays self-contained.
 */
export function emitServiceClientCpp(services: readonly IRService[], deps: ServiceClientEmitDeps): string {
    const shown = filterVisible(services, deps.includePrivate);
    const lines: string[] = ["#pragma once", "#include <keyma/client.hpp>"];
    for (const inc of buildIncludes(shown, deps)) lines.push(`#include "${inc}"`);
    lines.push("", `namespace ${deps.nsRoot}::client {`, "");
    for (const svc of shown) lines.push(...emitClientStub(svc, deps), "");
    lines.push(`}  // namespace ${deps.nsRoot}::client`, "");
    return lines.join("\n");
}

function emitClientStub(svc: IRService, deps: ServiceClientEmitDeps): string[] {
    const lines: string[] = [];
    if (svc.description !== undefined) lines.push(`// Typed client stub — ${svc.description}`);
    lines.push(`struct ${svc.sourceName} {`);
    for (const m of filterVisible(svc.methods, deps.includePrivate)) {
        const ret = returnLeafType(m.returnType, deps);
        const sig = [...m.params.map((p) => paramDecl(p.name, p.type, deps)), "keyma::alloc_t __alloc = {}"].join(", ");
        lines.push(`    static keyma::CallLeaf<${ret}> ${m.name}(${sig}) {`);
        lines.push(`        keyma::Value __args = keyma::Value::object(__alloc);`);
        for (const p of m.params) lines.push(...argLines(p.name, p.type, deps));
        lines.push(
            `        return keyma::CallLeaf<${ret}>{ keyma::Keyma::call(${JSON.stringify(svc.name)}, ` +
            `${JSON.stringify(m.name)}, std::move(__args), __alloc) };`,
        );
        lines.push(`    }`);
    }
    lines.push(`};`);
    return lines;
}

/** The target class `name` of a shared_ptr-shaped schema type — a `reference`
 *  (id handle) or an `instance` (a live value of class T). Both lower to
 *  `std::shared_ptr<T>` and share the client's full-object hydration/serialization. */
function sharedPtrTarget(t: IRType): string | undefined {
    if (t.kind === "reference") return t.schema;
    if (t.kind === "instance") return t.name;
    return undefined;
}

/**
 * The CallLeaf element type for a method's return — what `keyma::send` hydrates to. A
 * schema return is modelled in the IR as a `reference`/`instance`; the client hydrates the
 * FULL wire object to the value type (not a shared_ptr id-stub), so it unwraps to its target
 * struct and an array of them to a vector. `void` for a no-return method.
 */
function returnLeafType(rt: IRType | undefined, deps: ServiceClientEmitDeps): string {
    if (rt === undefined) return "void";
    const direct = sharedPtrTarget(rt);
    if (direct !== undefined) return deps.cppTypeByName.get(direct) ?? direct;
    if (rt.kind === "array") {
        const elem = sharedPtrTarget(rt.of);
        if (elem !== undefined) return `std::pmr::vector<${deps.cppTypeByName.get(elem) ?? elem}>`;
    }
    return irTypeToCpp(rt, deps.cppTypeByName, deps.enumTypeByName);
}

/**
 * Serialize one argument into `__args`. A schema-typed (reference/instance) param is a
 * shared_ptr; its FULL object is the payload (a service input is not a stored relation), so
 * it is serialized via the struct's own to_value — never the id-only shared_ptr value_traits.
 * Everything else lowers through keyma::to_value.
 */
function argLines(name: string, type: IRType, deps: ServiceClientEmitDeps): string[] {
    const key = JSON.stringify(name);
    if (sharedPtrTarget(type) !== undefined) {
        return [`        __args.set(${key}, ${name} ? ${name}->to_value(__alloc) : keyma::Value(nullptr, __alloc));`];
    }
    if (type.kind === "array" && sharedPtrTarget(type.of) !== undefined) {
        return [
            `        { keyma::Value __a = keyma::Value::array(__alloc);`,
            `          for (const auto& __e : ${name}) __a.push(__e ? __e->to_value(__alloc) : keyma::Value(nullptr, __alloc));`,
            `          __args.set(${key}, std::move(__a)); }`,
        ];
    }
    return [`        __args.set(${key}, keyma::to_value(${name}, __alloc));`];
}

/** A method parameter declaration: heavyweight types by const-ref, scalars by value. */
function paramDecl(name: string, type: IRType, deps: ServiceClientEmitDeps): string {
    const ty = irTypeToCpp(type, deps.cppTypeByName, deps.enumTypeByName);
    return passByRef(type) ? `const ${ty}& ${name}` : `${ty} ${name}`;
}

function passByRef(type: IRType): boolean {
    switch (type.kind) {
        case "string": case "id": case "date": case "time": case "decimal":
        case "bytes": case "json": case "array": case "embedded":
            return true;
        case "enum":
            return type.name === undefined; // inline union → pmr string (by ref); named enum → by value
        default:
            return false; // number/integer/bigint/boolean/dateTime/reference (shared_ptr) → by value
    }
}

// ─── includes ─────────────────────────────────────────────────────────────────

/** Model/enum headers for every schema/enum referenced by a service's params/returns. */
function buildIncludes(services: readonly IRService[], deps: ServiceClientEmitDeps): string[] {
    const incs = new Set<string>();
    for (const svc of services) {
        for (const m of filterVisible(svc.methods, deps.includePrivate)) {
            for (const p of m.params) addTypeIncludes(p.type, deps, incs);
            if (m.returnType !== undefined) addTypeIncludes(m.returnType, deps, incs);
        }
    }
    return [...incs].sort();
}

function addTypeIncludes(type: IRType, deps: ServiceClientEmitDeps, out: Set<string>): void {
    const t = type.kind === "array" ? type.of : type;
    if (t.kind === "embedded" || t.kind === "reference" || t.kind === "instance") {
        const targetName = t.kind === "instance" ? t.name : t.schema;
        const cls = deps.classNameByName.get(targetName);
        const ref = cls !== undefined ? deps.schemaModule.get(cls) : undefined;
        if (ref !== undefined) out.add(includePath(ref));
    } else if (t.kind === "enum" && t.name !== undefined) {
        const ref = deps.enumModuleByName.get(t.name);
        if (ref !== undefined) out.add(includePath(ref));
    }
}
