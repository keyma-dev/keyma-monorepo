import type { IRSchema } from "@keyma/ir";

type IndexEmitOptions = {
    includePrivate: boolean;
    emitMaterializers: boolean;
    hasValidators: boolean;
    hasFormatters: boolean;
};

export function emitIndexPython(
    schemas: IRSchema[],
    schemaPaths: ReadonlyMap<string, string>,
    opts: IndexEmitOptions
): string {
    const visible = opts.includePrivate
        ? schemas
        : schemas.filter((s) => s.visibility === "public");

    const lines: string[] = [];

    for (const schema of visible) {
        const fullPath = schemaPaths.get(schema.sourceName);
        if (fullPath === undefined) continue;
        
        // Convert JS-style relative path to Python module path
        const modPath = fullPath.replace(/\//g, ".");
        
        const symbols: string[] = [schema.sourceName];
        if (opts.emitMaterializers && schema.fields.some((f) => f.computed !== undefined)) {
            symbols.push(`materialize${schema.sourceName}`);
        }
        lines.push(`from .models.${modPath} import ${symbols.join(", ")}`);
    }

    if (opts.hasValidators) {
        lines.push(`from .validators import *`);
        lines.push(`from .registry import *`);
    }
    if (opts.hasFormatters) {
        lines.push(`from .formatters import *`);
        lines.push(`from .formatter_registry import *`);
    }

    lines.push("");
    return lines.join("\n");
}
