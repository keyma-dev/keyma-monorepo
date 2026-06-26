import type { IRSchema } from "@keyma/core/ir";

type IndexEmitOptions = {
    includePrivate: boolean;
};

/**
 * Emit the `index.js` / `index.d.ts` barrel: one re-export per model module, with
 * every schema class authored in that source file. Modules are referenced by their
 * bundle-relative path. No registry or defaults re-exports — validators/formatters/
 * defaults ride directly in the schema metadata now.
 */
export function emitIndexJs(
    schemas: readonly IRSchema[],
    schemaModule: ReadonlyMap<string, string>,
    opts: IndexEmitOptions,
    serviceNames: readonly string[] = [],
): string {
    const visible = opts.includePrivate ? schemas : schemas.filter((s) => s.visibility === "public");

    const byModule = new Map<string, string[]>();
    for (const schema of visible) {
        const ref = schemaModule.get(schema.sourceName);
        if (ref === undefined) continue;
        const exports = byModule.get(ref) ?? [];
        exports.push(schema.sourceName);
        byModule.set(ref, exports);
    }

    const lines = [...byModule.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ref, exports]) => `export { ${exports.join(", ")} } from "./${ref}.js";`);
    if (serviceNames.length > 0) {
        lines.push(`export { ${[...serviceNames].sort().join(", ")} } from "./services.js";`);
    }
    lines.push("");
    return lines.join("\n");
}

/** The `index.d.ts` content is identical to `index.js` — the same re-exports carry
 *  both the class values and their types. */
export function emitIndexDts(
    schemas: readonly IRSchema[],
    schemaModule: ReadonlyMap<string, string>,
    opts: IndexEmitOptions,
    serviceNames: readonly string[] = [],
): string {
    return emitIndexJs(schemas, schemaModule, opts, serviceNames);
}
