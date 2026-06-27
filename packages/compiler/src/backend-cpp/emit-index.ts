import type { IRClassDeclaration, IREnumDeclaration, IRService } from "@keyma/core/ir";
import { includePath, namespaceOf, cppSanitizer } from "./module-path.js";
import { SERVICES_REF } from "./emitter-registry.js";

type IndexEmitOptions = {
    includePrivate: boolean;
    nsRoot: string;
    /** Named enums (any bundle) and their declaring module refs, for hoisting. */
    enums: readonly IREnumDeclaration[];
    enumModule: ReadonlyMap<string, string>;
    /** Visible services (already visibility-filtered), for hoisting + the include. */
    services: readonly IRService[];
};

/**
 * Emit `index.hpp`: include every model header (and `services.hpp` when present) and
 * hoist each visible class, named enum, and service from its nested namespace into
 * the bundle's root namespace via `using` aliases. No registry —
 * validators/formatters/defaults ride directly in the class metadata.
 */
export function emitIndexCpp(
    classes: readonly IRClassDeclaration[],
    classModule: ReadonlyMap<string, string>,
    opts: IndexEmitOptions,
): string {
    const visible = opts.includePrivate ? classes : classes.filter((s) => s.visibility === "public");

    const classesByModule = new Map<string, IRClassDeclaration[]>();
    for (const cls of visible) {
        const ref = classModule.get(cls.sourceName);
        if (ref === undefined) continue;
        (classesByModule.get(ref) ?? classesByModule.set(ref, []).get(ref)!).push(cls);
    }
    const enumsByModule = new Map<string, IREnumDeclaration[]>();
    for (const e of opts.enums) {
        const ref = opts.enumModule.get(e.name);
        if (ref === undefined) continue;
        (enumsByModule.get(ref) ?? enumsByModule.set(ref, []).get(ref)!).push(e);
    }

    const refs = [...new Set([...classesByModule.keys(), ...enumsByModule.keys()])].sort();
    const lines = ["#pragma once"];
    for (const ref of refs) lines.push(`#include "${includePath(ref)}"`);
    if (opts.services.length > 0) lines.push(`#include "${includePath(SERVICES_REF)}"`);

    lines.push("", `namespace ${opts.nsRoot} {`);
    for (const ref of refs) {
        const ns = namespaceOf(ref, opts.nsRoot);
        const rel = ns.slice(opts.nsRoot.length + 2); // drop "<root>::" → "models::user"
        for (const e of enumsByModule.get(ref) ?? []) lines.push(`using ${rel}::${cppSanitizer(e.name)};`);
        for (const cls of classesByModule.get(ref) ?? []) {
            lines.push(`using ${rel}::${cls.sourceName};`);
        }
    }
    for (const svc of opts.services) lines.push(`using services::${svc.sourceName};`);
    lines.push(`}  // namespace ${opts.nsRoot}`, "");
    return lines.join("\n");
}
