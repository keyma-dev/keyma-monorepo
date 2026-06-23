import type { IRService, IRServiceMethod, IRType } from "@keyma/ir";
import { irTypeToCpp } from "./ir-type-to-cpp.js";
import { includePath } from "./module-path.js";

/** Bundle-relative module ref of the typed service-client header (bundle root). */
export const SERVICE_CLIENT_REF = "service-client";

export type ServiceClientEmitDeps = {
    /** Include private services/methods (server/library bundles). */
    includePrivate: boolean;
    nsRoot: string;
    /** sourceName → bundle-relative model module ref (e.g. "models/user"). */
    schemaModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted C++ class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → fully-qualified C++ struct type. */
    cppTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → fully-qualified `enum class` type. */
    enumTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → bundle-relative module ref of its declaring file. */
    enumModuleByName: ReadonlyMap<string, string>;
};

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
    const visible = visibleServices(services, deps.includePrivate);
    const lines: string[] = ["#pragma once", "#include <keyma/client.hpp>"];
    for (const inc of buildIncludes(visible, deps)) lines.push(`#include "${inc}"`);
    lines.push("", `namespace ${deps.nsRoot}::client {`, "");
    for (const svc of visible) lines.push(...emitClientStub(svc, deps), "");
    lines.push(`}  // namespace ${deps.nsRoot}::client`, "");
    return lines.join("\n");
}

function emitClientStub(svc: IRService, deps: ServiceClientEmitDeps): string[] {
    const lines: string[] = [];
    if (svc.description !== undefined) lines.push(`// Typed client stub — ${svc.description}`);
    lines.push(`struct ${svc.sourceName} {`);
    for (const m of visibleMethods(svc, deps.includePrivate)) {
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

/**
 * The CallLeaf element type for a method's return — what `keyma::send` hydrates to. A
 * schema return is modelled in the IR as a `reference`; the client hydrates the FULL wire
 * object to the value type (not a shared_ptr id-stub), so a reference unwraps to its target
 * struct and an array-of-reference to a vector of them. `void` for a no-return method.
 */
function returnLeafType(rt: IRType | undefined, deps: ServiceClientEmitDeps): string {
    if (rt === undefined) return "void";
    if (rt.kind === "reference") return deps.cppTypeByName.get(rt.schema) ?? rt.schema;
    if (rt.kind === "array" && rt.of.kind === "reference") {
        return `std::pmr::vector<${deps.cppTypeByName.get(rt.of.schema) ?? rt.of.schema}>`;
    }
    return irTypeToCpp(rt, deps.cppTypeByName, deps.enumTypeByName);
}

/**
 * Serialize one argument into `__args`. A schema-typed (reference) param is a shared_ptr;
 * its FULL object is the payload (a service input is not a stored relation), so it is
 * serialized via the struct's own to_value — never the id-only shared_ptr value_traits.
 * Everything else lowers through keyma::to_value.
 */
function argLines(name: string, type: IRType, deps: ServiceClientEmitDeps): string[] {
    const key = JSON.stringify(name);
    if (type.kind === "reference") {
        return [`        __args.set(${key}, ${name} ? ${name}->to_value(__alloc) : keyma::Value(nullptr, __alloc));`];
    }
    if (type.kind === "array" && type.of.kind === "reference") {
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
        case "string": case "id": case "date": case "time": case "decimal": case "regexp":
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
        for (const m of visibleMethods(svc, deps.includePrivate)) {
            for (const p of m.params) addTypeIncludes(p.type, deps, incs);
            if (m.returnType !== undefined) addTypeIncludes(m.returnType, deps, incs);
        }
    }
    return [...incs].sort();
}

function addTypeIncludes(type: IRType, deps: ServiceClientEmitDeps, out: Set<string>): void {
    const t = type.kind === "array" ? type.of : type;
    if (t.kind === "embedded" || t.kind === "reference") {
        const cls = deps.classNameByName.get(t.schema);
        const ref = cls !== undefined ? deps.schemaModule.get(cls) : undefined;
        if (ref !== undefined) out.add(includePath(ref));
    } else if (t.kind === "enum" && t.name !== undefined) {
        const ref = deps.enumModuleByName.get(t.name);
        if (ref !== undefined) out.add(includePath(ref));
    }
}

// ─── visibility ───────────────────────────────────────────────────────────────

function visibleServices(services: readonly IRService[], includePrivate: boolean): IRService[] {
    return includePrivate ? [...services] : services.filter((s) => s.visibility === "public");
}

function visibleMethods(svc: IRService, includePrivate: boolean): IRServiceMethod[] {
    return includePrivate ? svc.methods : svc.methods.filter((m) => m.visibility === "public");
}
