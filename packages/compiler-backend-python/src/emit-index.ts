import type { IRSchema } from "@keyma/ir";
import { pythonRelImport } from "./module-path.js";

type IndexEmitOptions = {
    includePrivate: boolean;
};

/**
 * Emit `index.py` / `__init__.py`: one relative import per model module re-exporting
 * every schema class authored in that source file. No registry imports —
 * validators/formatters/defaults ride directly in the schema metadata.
 */
export function emitIndexPython(
    schemas: readonly IRSchema[],
    schemaModule: ReadonlyMap<string, string>,
    opts: IndexEmitOptions,
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
        .map(([ref, exports]) => {
            const { prefix, module } = pythonRelImport("", ref);
            return `from ${prefix}${module} import ${exports.join(", ")}`;
        });
    lines.push("");
    return lines.join("\n");
}
