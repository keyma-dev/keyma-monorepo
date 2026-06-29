import type { IRService, IRServiceMethod, IRType } from "@keyma/core/ir";
import { filterVisible } from "@keyma/core/util";
import { irTypeToCpp } from "./ir-type-to-cpp.js";
import { includePath } from "./module-path.js";
import {
    jsonEncode, jsonDecode, binaryEncode, binaryDecode, cppType, passByRef,
} from "./emit-service-marshal.js";

/** Bundle-relative module ref (filename stem) of the opt-in service-client header. */
export const SERVICE_CLIENT_REF = "service-client";

/** The deps the bundle shell passes to the built-in service-client emitter. */
export type ServiceClientEmitDeps = {
    /** Include private services/methods (server/library bundles). */
    includePrivate: boolean;
    nsRoot: string;
    /** Complete `#include` token (with delimiters) for the runtime header (the umbrella). */
    runtimeInclude: string;
    /** Typed binary codec is enabled (see {@link ServiceEmitDeps.binary}). */
    binary: boolean;
    /** sourceName → bundle-relative model module ref (e.g. "models/user"). */
    classModule: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → emitted C++ class (`sourceName`). */
    classNameByName: ReadonlyMap<string, string>;
    /** Reference/embedded target `name` → fully-qualified C++ struct type. */
    cppTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → fully-qualified `enum class` type. */
    enumTypeByName: ReadonlyMap<string, string>;
    /** Named enum `name` → bundle-relative module ref of its declaring file. */
    enumModuleByName: ReadonlyMap<string, string>;
};

// `@Service`/RPC is a base-language concern the compiler owns end-to-end: the bundle shell calls
// this emitter directly on `ir.services`. No domain pack participates.
//
// The C++ client bundle emits, per `@Service`, a per-service client class bound to a
// `keyma::transport`, with one coroutine method per RPC. Each method reads the transport's
// `wire_encoding()`, marshals its declared args into the call payload (a named-arg Value object in
// JSON mode, or the positional binary blob), round-trips the envelope via `keyma::client_invoke`,
// and decodes the OK payload into the typed return — yielding
// `keyma::task<keyma::result<Ret, keyma::error>>`. NO exception crosses the RPC boundary: a failure
// envelope becomes a `keyma::error` value in the `result`.
//
// Unlike the model headers this one inherently needs the runtime transport, so it is an OPT-IN
// header (not pulled in by index.hpp) — a vendored model bundle stays self-contained.

/**
 * Emit `service-client.hpp`: one client class per service in `<nsRoot>::client`, bound to a
 * `keyma::transport`. Generated from `<keyma/runtime.hpp>` (the umbrella) only.
 */
export function emitServiceClientCpp(services: readonly IRService[], deps: ServiceClientEmitDeps): string {
    const shown = filterVisible(services, deps.includePrivate);
    const lines: string[] = ["#pragma once", `#include ${deps.runtimeInclude}`];
    for (const inc of buildIncludes(shown, deps)) lines.push(`#include "${inc}"`);
    lines.push("", `namespace ${deps.nsRoot}::client {`, "");
    for (const svc of shown) lines.push(...emitClient(svc, deps), "");
    lines.push(`}  // namespace ${deps.nsRoot}::client`, "");
    return lines.join("\n");
}

function emitClient(svc: IRService, deps: ServiceClientEmitDeps): string[] {
    const methods = filterVisible(svc.methods, deps.includePrivate);
    const lines: string[] = [];
    if (svc.description !== undefined) lines.push(`// Typed client — ${svc.description}`);
    lines.push(`class ${svc.sourceName} {`, `public:`);
    lines.push(`    explicit ${svc.sourceName}(keyma::transport& transport, keyma::alloc_t alloc = {})`);
    lines.push(`        : __tx(&transport), __alloc(alloc) {}`, "");
    for (const m of methods) lines.push(...emitMethod(svc, m, deps).map((l) => `    ${l}`), "");
    lines.push(`private:`);
    lines.push(`    keyma::transport* __tx;`);
    lines.push(`    keyma::alloc_t __alloc;`);
    lines.push(`};`);
    return lines;
}

function emitMethod(svc: IRService, m: IRServiceMethod, deps: ServiceClientEmitDeps): string[] {
    const ret = m.returnType !== undefined ? cppType(m.returnType, deps) : "void";
    const params = m.params.map((p) => paramDecl(p.name, p.type, deps)).join(", ");
    const lines: string[] = [`keyma::task<keyma::result<${ret}, keyma::error>> ${m.name}(${params}) {`];
    lines.push(`    keyma::encoding __enc = __tx->wire_encoding();`);
    lines.push(...emitBuildArgs(m, deps).map((l) => `    ${l}`));
    lines.push(`    keyma::result<keyma::wire_payload, keyma::error> __r =`);
    lines.push(`        co_await keyma::client_invoke(*__tx, ${JSON.stringify(svc.name)}, ${JSON.stringify(m.name)}, std::move(__args));`);
    lines.push(`    if (!__r.has_value()) co_return std::unexpected(__r.error());`);
    lines.push(...emitDecodeResult(m.returnType, ret, deps).map((l) => `    ${l}`));
    lines.push(`}`);
    return lines;
}

/** Build the call payload (`__args`) from the declared params, per the transport encoding. */
function emitBuildArgs(m: IRServiceMethod, deps: ServiceClientEmitDeps): string[] {
    if (m.params.length === 0) {
        return [`keyma::wire_payload __args = keyma::empty_payload(__enc, __alloc);`];
    }
    const jsonBlock = [
        `keyma::Value __obj = keyma::Value::object(__alloc);`,
        ...m.params.map((p) => `__obj.set(${JSON.stringify(p.name)}, ${jsonEncode(p.type, p.name, "__alloc", deps)});`),
        `__args = keyma::wire_payload(std::move(__obj));`,
    ];
    if (!deps.binary) {
        return [`keyma::wire_payload __args;`, ...jsonBlock];
    }
    const binaryBlock = [
        `keyma::ByteBuf __buf(__alloc);`,
        ...m.params.map((p) => binaryEncode(p.type, p.name, "__buf", "__alloc", deps)),
        `__args = keyma::wire_payload(std::move(__buf));`,
    ];
    return [
        `keyma::wire_payload __args;`,
        `if (__enc == keyma::encoding::binary) {`,
        ...binaryBlock.map((l) => `    ${l}`),
        `} else {`,
        ...jsonBlock.map((l) => `    ${l}`),
        `}`,
    ];
}

/** Decode the OK payload (`*__r`) into the typed return value, per the transport encoding. */
function emitDecodeResult(rt: IRType | undefined, ret: string, deps: ServiceClientEmitDeps): string[] {
    if (rt === undefined) {
        return [`co_return keyma::result<void, keyma::error>{};`];
    }
    const jsonLine = `co_return keyma::result<${ret}, keyma::error>(${jsonDecode(rt, "std::get<keyma::Value>(*__r)", "__alloc", deps)});`;
    if (!deps.binary) return [jsonLine];
    return [
        `if (__enc == keyma::encoding::binary) {`,
        `    const keyma::ByteBuf& __b = std::get<keyma::ByteBuf>(*__r);`,
        `    keyma::binary_detail::Reader __rd{std::span<const std::byte>(__b.data(), __b.size()), 0, __b.size()};`,
        `    co_return keyma::result<${ret}, keyma::error>(${binaryDecode(rt, "__rd", "__alloc", deps)});`,
        `}`,
        jsonLine,
    ];
}

/** A method parameter declaration: heavyweight types by const-ref, scalars by value. */
function paramDecl(name: string, type: IRType, deps: ServiceClientEmitDeps): string {
    const ty = irTypeToCpp(type, deps.cppTypeByName, deps.enumTypeByName);
    return passByRef(type) ? `const ${ty}& ${name}` : `${ty} ${name}`;
}

// ─── includes ─────────────────────────────────────────────────────────────────

/** Model/enum headers for every class/enum referenced by a service's params/returns. */
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
        const targetName = t.kind === "instance" ? t.name : t.target;
        const cls = deps.classNameByName.get(targetName);
        const ref = cls !== undefined ? deps.classModule.get(cls) : undefined;
        if (ref !== undefined) out.add(includePath(ref));
    } else if (t.kind === "enum" && t.name !== undefined) {
        const ref = deps.enumModuleByName.get(t.name);
        if (ref !== undefined) out.add(includePath(ref));
    }
}
