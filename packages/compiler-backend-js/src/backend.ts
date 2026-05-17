import path from "node:path";
import type { KeymaIR, IRSchema } from "@keyma/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "@keyma/compiler";
import { emitModelJs, emitModelDts } from "./emit-model.js";
import { emitIndexJs, emitIndexDts } from "./emit-index.js";
import { resolveJsTarget, type JsTargetConfig } from "./types.js";

export const jsBackend: KeymaBackend = {
    name: "@keyma/compiler-backend-js",
    target: "js",
    emit: emitJs,
};

export async function emitJs(
    ir: KeymaIR,
    target: KeymaTargetConfig,
    _config: ResolvedConfig
): Promise<EmitResult> {
    const jsTarget = resolveJsTarget(target as JsTargetConfig);
    const files: EmitFile[] = [];

    // sourceName → file name (schema.name), e.g. "User" → "user"
    const schemaFileNames = new Map<string, string>(
        ir.schemas.map((s) => [s.sourceName, s.name])
    );

    // sourceName → TypeScript class name (for embedded type references in .d.ts)
    const embeddedTypeNames = new Map<string, string>(
        ir.schemas.map((s) => [s.sourceName, s.sourceName])
    );

    if (jsTarget.emitClient) {
        files.push(...emitBundle(ir, "client", jsTarget.outDir, schemaFileNames, embeddedTypeNames, {
            includePrivate: false,
            includeIndexes: false,
            emitMaterializers: false,
            formPhasesOnly: true,
        }));
    }

    if (jsTarget.emitServer) {
        files.push(...emitBundle(ir, "server", jsTarget.outDir, schemaFileNames, embeddedTypeNames, {
            includePrivate: true,
            includeIndexes: true,
            emitMaterializers: true,
            formPhasesOnly: false,
        }));
    }

    return { files, diagnostics: [] };
}

type BundleOptions = {
    includePrivate: boolean;
    includeIndexes: boolean;
    emitMaterializers: boolean;
    formPhasesOnly: boolean;
};

function emitBundle(
    ir: KeymaIR,
    bundle: "client" | "server",
    outDir: string,
    schemaFileNames: ReadonlyMap<string, string>,
    embeddedTypeNames: ReadonlyMap<string, string>,
    opts: BundleOptions
): EmitFile[] {
    const files: EmitFile[] = [];
    const bundleDir = path.posix.join(outDir, bundle);

    const visibleSchemas: IRSchema[] = opts.includePrivate
        ? ir.schemas
        : ir.schemas.filter((s) => s.visibility === "public");

    const modelOpts = {
        includePrivate: opts.includePrivate,
        includeIndexes: opts.includeIndexes,
        emitMaterializers: opts.emitMaterializers,
        formPhasesOnly: opts.formPhasesOnly,
        schemaFileNames,
        embeddedTypeNames,
    };

    // One model file per schema — each file owns its class, schema metadata, and materializer.
    for (const schema of visibleSchemas) {
        files.push({
            path: path.posix.join(bundleDir, "models", `${schema.name}.js`),
            content: emitModelJs(schema, modelOpts),
        });
        files.push({
            path: path.posix.join(bundleDir, "models", `${schema.name}.d.ts`),
            content: emitModelDts(schema, modelOpts),
        });
    }

    const indexOpts = {
        includePrivate: opts.includePrivate,
        emitMaterializers: opts.emitMaterializers,
    };

    // index.js + index.d.ts
    files.push({
        path: path.posix.join(bundleDir, "index.js"),
        content: emitIndexJs(ir.schemas, schemaFileNames, indexOpts),
    });
    files.push({
        path: path.posix.join(bundleDir, "index.d.ts"),
        content: emitIndexDts(ir.schemas, schemaFileNames, indexOpts),
    });

    return files;
}
