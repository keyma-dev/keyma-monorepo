import type { IRService, IRServiceMethod, IRType } from "@keyma/core/ir";
import { filterVisible } from "@keyma/core/util";
import { irTypeToCpp } from "./ir-type-to-cpp.js";
import { includePath } from "./module-path.js";
import {
    jsonEncode, jsonDecode, binaryEncode, binaryDecode, cppType, passByRef,
} from "./emit-service-marshal.js";
import type { ServiceEmitDeps } from "./emitter-registry.js";

// `@Service`/RPC is a base-language concern the compiler owns end-to-end: the bundle shell calls
// this emitter directly on `ir.services` (gated by visibility like classes). No domain pack
// participates — services emit identically for any (or no) registered domain.
//
// The C++ server bundle emits, per `@Service`, an abstract base deriving `keyma::service` (the C++
// mirror of the JS backend's server class). It carries three pieces the application/host need:
//   * typed pure virtuals the app overrides — each returns `keyma::task<Ret>` and takes the
//     declared params plus a trailing `const keyma::RequestContext&` (injected LAST);
//   * `meta()` — name / per-method visibility, for the host's resolution + visibility gate;
//   * a generated `dispatch(method, payload, ctx, encoding, a)` switch — decode args (named-arg
//     JSON object, or the positional binary blob), call the typed override, encode the result into
//     the slim envelope, turning any handler exception into a HANDLER_ERROR failure.

/**
 * Emit `services.hpp`: one `keyma::service` base per service in `<nsRoot>::services`. The
 * application subclasses these and overrides the pure virtuals; the host calls the generated
 * `dispatch`. Generated from `<keyma/runtime.hpp>` (the umbrella) only.
 */
export function emitServicesCpp(services: readonly IRService[], deps: ServiceEmitDeps): string {
    const shown = filterVisible(services, deps.includePrivate);
    const lines: string[] = ["#pragma once", `#include ${deps.runtimeInclude}`];
    for (const inc of buildIncludes(shown, deps)) lines.push(`#include "${inc}"`);
    lines.push("", `namespace ${deps.nsRoot}::services {`, "");
    for (const svc of shown) lines.push(...emitServiceClass(svc, deps), "");
    lines.push(`}  // namespace ${deps.nsRoot}::services`, "");
    return lines.join("\n");
}

function emitServiceClass(svc: IRService, deps: ServiceEmitDeps): string[] {
    const methods = filterVisible(svc.methods, deps.includePrivate);
    const lines: string[] = [];
    if (svc.description !== undefined) lines.push(`// ${svc.description}`);
    lines.push(`class ${svc.sourceName} : public keyma::service {`, `public:`,
        `    virtual ~${svc.sourceName}() = default;`);

    // Typed pure virtuals (ctx injected LAST). Remote calls are async, so every method returns a
    // keyma::task<Ret>; the application's override supplies the body.
    for (const m of methods) {
        const params = [...m.params.map((p) => paramDecl(p.name, p.type, deps)),
            "const keyma::RequestContext& ctx"].join(", ");
        const ret = m.returnType !== undefined ? cppType(m.returnType, deps) : "void";
        lines.push(`    virtual keyma::task<${ret}> ${m.name}(${params}) = 0;`);
    }

    lines.push("", ...emitMeta(svc, methods).map((l) => `    ${l}`));
    lines.push("", ...emitDispatch(svc, methods, deps).map((l) => `    ${l}`));
    lines.push(`};`);
    return lines;
}

// ── meta() ──────────────────────────────────────────────────────────────────────

/** The slim `meta()` accessor: name + per-method name/visibility for host resolution + gating. */
function emitMeta(svc: IRService, methods: readonly IRServiceMethod[]): string[] {
    const lines: string[] = [`const keyma::service_meta& meta() const override {`];
    for (const m of methods) {
        if (m.params.length === 0) continue;
        const params = m.params.map((p) => `{${JSON.stringify(p.name)}}`).join(", ");
        lines.push(`    static const keyma::service_param_meta ${m.name}_params[] = { ${params} };`);
    }
    const methodEntries = methods.map((m) => {
        const vis = m.visibility === "private" ? "keyma::Visibility::Private" : "keyma::Visibility::Public";
        const params = m.params.length === 0
            ? "{}"
            : `std::span<const keyma::service_param_meta>(${m.name}_params)`;
        return `{${JSON.stringify(m.name)}, ${vis}, ${params}}`;
    });
    lines.push(`    static const keyma::service_method_meta methods[] = { ${methodEntries.join(", ")} };`);
    const svis = svc.visibility === "private" ? "keyma::Visibility::Private" : "keyma::Visibility::Public";
    lines.push(`    static const keyma::service_meta m{${JSON.stringify(svc.name)}, ${svis}, ` +
        `std::span<const keyma::service_method_meta>(methods)};`);
    lines.push(`    return m;`, `}`);
    return lines;
}

// ── dispatch() ────────────────────────────────────────────────────────────────────

/** The generated `dispatch` switch: decode args → call the typed override → encode the result. */
function emitDispatch(svc: IRService, methods: readonly IRServiceMethod[], deps: ServiceEmitDeps): string[] {
    const lines: string[] = [
        `keyma::task<keyma::call_result> dispatch(std::string_view method, const keyma::wire_payload& payload,`,
        `                                         const keyma::RequestContext& ctx, keyma::encoding enc,`,
        `                                         keyma::alloc_t a) override {`,
        `    try {`,
    ];
    if (!deps.binary) lines.push(`        (void)enc;`);
    for (const m of methods) lines.push(...emitMethodCase(svc, m, deps).map((l) => `        ${l}`));
    lines.push(`        co_return keyma::call_result::failure(keyma::error_code::method_not_found, "method not found");`);
    lines.push(`    } catch (const std::exception& __e) {`);
    lines.push(`        co_return keyma::call_result::failure(keyma::error_code::handler_error, __e.what());`);
    lines.push(`    }`, `}`);
    return lines;
}

function emitMethodCase(svc: IRService, m: IRServiceMethod, deps: ServiceEmitDeps): string[] {
    const lines: string[] = [`if (method == ${JSON.stringify(m.name)}) {`];

    // Decode the args into locals BEFORE the co_await (no dangling reference across a suspension).
    const argVars = m.params.map((_, i) => `__a${i}`);
    for (let i = 0; i < m.params.length; i++) {
        lines.push(`    ${cppType(m.params[i]!.type, deps)} ${argVars[i]};`);
    }
    if (m.params.length > 0) {
        if (deps.binary) {
            lines.push(`    if (enc == keyma::encoding::binary) {`);
            lines.push(`        const keyma::ByteBuf& __b = std::get<keyma::ByteBuf>(payload);`);
            lines.push(`        keyma::binary_detail::Reader __r{std::span<const std::byte>(__b.data(), __b.size()), 0, __b.size()};`);
            for (let i = 0; i < m.params.length; i++) {
                lines.push(`        ${argVars[i]} = ${binaryDecode(m.params[i]!.type, "__r", "a", deps)};`);
            }
            lines.push(`    } else {`);
            lines.push(`        const keyma::Value& __args = std::get<keyma::Value>(payload);`);
            for (let i = 0; i < m.params.length; i++) {
                lines.push(`        ${argVars[i]} = ${jsonDecode(m.params[i]!.type, `__args.at(${JSON.stringify(m.params[i]!.name)})`, "a", deps)};`);
            }
            lines.push(`    }`);
        } else {
            lines.push(`    const keyma::Value& __args = std::get<keyma::Value>(payload);`);
            for (let i = 0; i < m.params.length; i++) {
                lines.push(`    ${argVars[i]} = ${jsonDecode(m.params[i]!.type, `__args.at(${JSON.stringify(m.params[i]!.name)})`, "a", deps)};`);
            }
        }
    }

    const callArgs = [...argVars, "ctx"].join(", ");
    if (m.returnType === undefined) {
        lines.push(`    co_await this->${m.name}(${callArgs});`);
        lines.push(...emitEncodeResult(undefined, undefined, deps).map((l) => `    ${l}`));
    } else {
        lines.push(`    ${cppType(m.returnType, deps)} __res = co_await this->${m.name}(${callArgs});`);
        lines.push(...emitEncodeResult(m.returnType, "__res", deps).map((l) => `    ${l}`));
    }
    lines.push(`}`);
    return lines;
}

/** Encode the (possibly void) return value into the slim envelope, per encoding. */
function emitEncodeResult(rt: IRType | undefined, expr: string | undefined, deps: ServiceEmitDeps): string[] {
    const lines: string[] = [];
    const jsonData = rt === undefined ? `keyma::Value(nullptr, a)` : jsonEncode(rt, expr!, "a", deps);
    if (deps.binary) {
        lines.push(`if (enc == keyma::encoding::binary) {`);
        lines.push(`    keyma::ByteBuf __out(a);`);
        if (rt !== undefined) lines.push(`    ${binaryEncode(rt, expr!, "__out", "a", deps)}`);
        lines.push(`    co_return keyma::call_result::success(keyma::wire_payload(std::move(__out)));`);
        lines.push(`}`);
    }
    lines.push(`co_return keyma::call_result::success(keyma::wire_payload(${jsonData}));`);
    return lines;
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** A method parameter declaration: heavyweight types by const-ref, scalars by value. */
function paramDecl(name: string, type: IRType, deps: ServiceEmitDeps): string {
    const ty = irTypeToCpp(type, deps.cppTypeByName, deps.enumTypeByName);
    return passByRef(type) ? `const ${ty}& ${name}` : `${ty} ${name}`;
}

// ─── includes ─────────────────────────────────────────────────────────────────

/** Model/enum headers for every class/enum referenced by a service's params/returns. */
function buildIncludes(services: readonly IRService[], deps: ServiceEmitDeps): string[] {
    const incs = new Set<string>();
    for (const svc of services) {
        for (const m of filterVisible(svc.methods, deps.includePrivate)) {
            for (const p of m.params) addTypeIncludes(p.type, deps, incs);
            if (m.returnType !== undefined) addTypeIncludes(m.returnType, deps, incs);
        }
    }
    return [...incs].sort();
}

function addTypeIncludes(type: IRType, deps: ServiceEmitDeps, out: Set<string>): void {
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
