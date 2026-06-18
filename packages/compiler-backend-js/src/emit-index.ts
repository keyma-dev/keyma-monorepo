import type { IRSchema } from "@keyma/ir";

type IndexEmitOptions = {
    includePrivate: boolean;
    emitMaterializers: boolean;
    hasValidators: boolean;
    hasFormatters: boolean;
};

/**
 * Emit the `index.js` barrel file that re-exports every model class (and, for
 * server bundles, the per-schema materializer functions) from their model file.
 */
export function emitIndexJs(
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
        const exports: string[] = [schema.sourceName];
        if (opts.emitMaterializers && schema.fields.some((f) => f.computed !== undefined)) {
            exports.push(`materialize${schema.sourceName}`);
        }
        lines.push(`export { ${exports.join(", ")} } from "./models/${fullPath}.js";`);
    }

    if (opts.hasValidators) {
        lines.push(`export * from "./validators.js";`);
        lines.push(`export * from "./registry.js";`);
    }
    if (opts.hasFormatters) {
        lines.push(`export * from "./formatters.js";`);
        lines.push(`export * from "./formatter-registry.js";`);
    }

    lines.push("");
    return lines.join("\n");
}

/**
 * Emit the `index.d.ts` barrel declaration file.
 */
export function emitIndexDts(
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
        lines.push(`export type { ${schema.sourceName} } from "./models/${fullPath}.js";`);
        if (opts.emitMaterializers && schema.fields.some((f) => f.computed !== undefined)) {
            lines.push(`export { materialize${schema.sourceName} } from "./models/${fullPath}.js";`);
        }
    }

    if (opts.hasValidators) {
        lines.push(`export * from "./validators.js";`);
        lines.push(`export * from "./registry.js";`);
    }
    if (opts.hasFormatters) {
        lines.push(`export * from "./formatters.js";`);
        lines.push(`export * from "./formatter-registry.js";`);
    }

    lines.push("");
    return lines.join("\n");
}
