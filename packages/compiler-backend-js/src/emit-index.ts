import type { IRSchema } from "@keyma/ir";

type IndexEmitOptions = {
    includePrivate: boolean;
    emitMaterializers: boolean;
};

/**
 * Emit the `index.js` barrel file that re-exports every model class (and, for
 * server bundles, the per-schema materializer functions) from their model file.
 */
export function emitIndexJs(
    schemas: IRSchema[],
    schemaFileNames: ReadonlyMap<string, string>,
    opts: IndexEmitOptions
): string {
    const visible = opts.includePrivate
        ? schemas
        : schemas.filter((s) => s.visibility === "public");

    const lines: string[] = [];

    for (const schema of visible) {
        const fileName = schemaFileNames.get(schema.sourceName);
        if (fileName === undefined) continue;
        const exports: string[] = [schema.sourceName];
        if (opts.emitMaterializers && schema.fields.some((f) => f.computed !== undefined)) {
            exports.push(`materialize${schema.sourceName}`);
        }
        lines.push(`export { ${exports.join(", ")} } from "./models/${fileName}.js";`);
    }

    lines.push("");
    return lines.join("\n");
}

/**
 * Emit the `index.d.ts` barrel declaration file.
 */
export function emitIndexDts(
    schemas: IRSchema[],
    schemaFileNames: ReadonlyMap<string, string>,
    opts: IndexEmitOptions
): string {
    const visible = opts.includePrivate
        ? schemas
        : schemas.filter((s) => s.visibility === "public");

    const lines: string[] = [];

    for (const schema of visible) {
        const fileName = schemaFileNames.get(schema.sourceName);
        if (fileName === undefined) continue;
        lines.push(`export type { ${schema.sourceName} } from "./models/${fileName}.js";`);
        if (opts.emitMaterializers && schema.fields.some((f) => f.computed !== undefined)) {
            lines.push(`export { materialize${schema.sourceName} } from "./models/${fileName}.js";`);
        }
    }

    lines.push("");
    return lines.join("\n");
}
