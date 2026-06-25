import type { IRService, IRType } from "@keyma/ir";
import { filterVisible } from "@keyma/compiler-util";
import { irTypeToCpp } from "./ir-type-to-cpp.js";
import { includePath } from "./module-path.js";

/** Bundle-relative module ref of the services header (sits at the bundle root). */
export const SERVICES_REF = "services";

export type ServiceEmitDeps = {
    /** Include private services and private methods (server/library bundles). */
    includePrivate: boolean;
    nsRoot: string;
    /** Complete `#include` token (with delimiters) for the runtime header. */
    runtimeInclude: string;
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
 * Emit `services.hpp`: one abstract class per service with a pure virtual function per
 * method (mirroring the JS backend's server abstract base class). Generation-only — no
 * runtime transport/`ctx` is woven in; methods carry exactly the IR-declared params and
 * return type. The application subclasses these and overrides the pure virtuals.
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
    const lines: string[] = [];
    if (svc.description !== undefined) lines.push(`// ${svc.description}`);
    lines.push(`class ${svc.sourceName} {`, `public:`, `    virtual ~${svc.sourceName}() = default;`);
    for (const m of filterVisible(svc.methods, deps.includePrivate)) {
        const params = m.params.map((p) => paramDecl(p.name, p.type, deps)).join(", ");
        const ret = m.returnType !== undefined ? irTypeToCpp(m.returnType, deps.cppTypeByName, deps.enumTypeByName) : "void";
        lines.push(`    virtual ${ret} ${m.name}(${params}) = 0;`);
    }
    lines.push(`};`);
    return lines;
}

/** A method parameter declaration: heavyweight types by const-ref, scalars by value. */
function paramDecl(name: string, type: IRType, deps: ServiceEmitDeps): string {
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
    if (t.kind === "embedded" || t.kind === "reference") {
        const cls = deps.classNameByName.get(t.schema);
        const ref = cls !== undefined ? deps.schemaModule.get(cls) : undefined;
        if (ref !== undefined) out.add(includePath(ref));
    } else if (t.kind === "enum" && t.name !== undefined) {
        const ref = deps.enumModuleByName.get(t.name);
        if (ref !== undefined) out.add(includePath(ref));
    }
}

