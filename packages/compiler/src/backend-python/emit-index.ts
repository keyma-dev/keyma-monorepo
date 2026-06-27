import type { IRClassDeclaration } from "@keyma/core/ir";
import { pythonRelImport } from "./module-path.js";

type IndexEmitOptions = {
    includePrivate: boolean;
};

/**
 * Emit `index.py` / `__init__.py`: one relative import per model module re-exporting
 * every class authored in that source file, plus the generated service classes from
 * `services.py`. No registry imports — a domain's per-member helpers and defaults ride
 * directly in the class metadata.
 */
export function emitIndexPython(
    classes: readonly IRClassDeclaration[],
    classModule: ReadonlyMap<string, string>,
    opts: IndexEmitOptions,
    serviceNames: readonly string[] = [],
): string {
    const visible = opts.includePrivate ? classes : classes.filter((s) => s.visibility === "public");

    const byModule = new Map<string, string[]>();
    for (const cls of visible) {
        const ref = classModule.get(cls.sourceName);
        if (ref === undefined) continue;
        const exports = byModule.get(ref) ?? [];
        exports.push(cls.sourceName);
        byModule.set(ref, exports);
    }

    const lines = [...byModule.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ref, exports]) => {
            const { prefix, module } = pythonRelImport("", ref);
            return `from ${prefix}${module} import ${exports.join(", ")}`;
        });
    if (serviceNames.length > 0) lines.push(`from .services import ${[...serviceNames].sort().join(", ")}`);
    lines.push("");
    return lines.join("\n");
}
