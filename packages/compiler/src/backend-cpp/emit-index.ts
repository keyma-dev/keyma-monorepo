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
 * hoist each visible schema, named enum, and service from its nested namespace into
 * the bundle's root namespace via `using` aliases. No registry —
 * validators/formatters/defaults ride directly in the schema metadata.
 */
export function emitIndexCpp(
    schemas: readonly IRClassDeclaration[],
    schemaModule: ReadonlyMap<string, string>,
    opts: IndexEmitOptions,
): string {
    const visible = opts.includePrivate ? schemas : schemas.filter((s) => s.visibility === "public");

    const schemasByModule = new Map<string, IRClassDeclaration[]>();
    for (const schema of visible) {
        const ref = schemaModule.get(schema.sourceName);
        if (ref === undefined) continue;
        (schemasByModule.get(ref) ?? schemasByModule.set(ref, []).get(ref)!).push(schema);
    }
    const enumsByModule = new Map<string, IREnumDeclaration[]>();
    for (const e of opts.enums) {
        const ref = opts.enumModule.get(e.name);
        if (ref === undefined) continue;
        (enumsByModule.get(ref) ?? enumsByModule.set(ref, []).get(ref)!).push(e);
    }

    const refs = [...new Set([...schemasByModule.keys(), ...enumsByModule.keys()])].sort();
    const lines = ["#pragma once"];
    for (const ref of refs) lines.push(`#include "${includePath(ref)}"`);
    if (opts.services.length > 0) lines.push(`#include "${includePath(SERVICES_REF)}"`);

    lines.push("", `namespace ${opts.nsRoot} {`);
    for (const ref of refs) {
        const ns = namespaceOf(ref, opts.nsRoot);
        const rel = ns.slice(opts.nsRoot.length + 2); // drop "<root>::" → "models::user"
        for (const e of enumsByModule.get(ref) ?? []) lines.push(`using ${rel}::${cppSanitizer(e.name)};`);
        for (const schema of schemasByModule.get(ref) ?? []) {
            lines.push(`using ${rel}::${schema.sourceName};`);
        }
    }
    for (const svc of opts.services) lines.push(`using services::${svc.sourceName};`);
    lines.push(`}  // namespace ${opts.nsRoot}`, "");
    return lines.join("\n");
}
