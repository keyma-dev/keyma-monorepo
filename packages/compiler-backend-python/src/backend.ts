import path from "node:path";
import type { KeymaIR, IRSchema } from "@keyma/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "@keyma/compiler";
import { emitModelPython } from "./emit-model.js";
import { emitIndexPython } from "./emit-index.js";
import { emitValidatorFiles, emitFormatterFiles } from "./emit-validators.js";
import { resolvePythonTargetJSStyle as resolvePythonTarget, type PythonTargetConfig } from "./types.js";

export const pythonBackend: KeymaBackend = {
    name: "@keyma/compiler-backend-python",
    target: "python",
    emit: emitPython,
};

export async function emitPython(
    ir: KeymaIR,
    target: KeymaTargetConfig,
    _config: ResolvedConfig
): Promise<EmitResult> {
    const pyTarget = resolvePythonTarget(target as PythonTargetConfig);
    const files: EmitFile[] = [];

    // sourceName → file path relative to models dir, e.g. "User" → "auth/user"
    const schemaPaths = new Map<string, string>(
        ir.schemas.map((s) => [
            s.sourceName,
            path.posix.join(getRelativeModelDir(s.source.file, ir.sourceRoot), s.name),
        ])
    );

    if (pyTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(pyTarget.outDir, "client"), schemaPaths, {
            includePrivate: false,
            includeIndexes: false,
            emitMaterializers: false,
            formPhasesOnly: true,
        }));
    }

    if (pyTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(pyTarget.outDir, "server"), schemaPaths, {
            includePrivate: true,
            includeIndexes: true,
            emitMaterializers: true,
            formPhasesOnly: false,
        }));
    }

    if (pyTarget.emitLibrary) {
        files.push(...emitBundle(ir, pyTarget.outDir, schemaPaths, {
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
    bundleDir: string,
    schemaPaths: ReadonlyMap<string, string>,
    opts: BundleOptions
): EmitFile[] {
    const files: EmitFile[] = [];

    const visibleSchemas: IRSchema[] = opts.includePrivate
        ? ir.schemas
        : ir.schemas.filter((s) => s.visibility === "public");

    const modelOpts = {
        includePrivate: opts.includePrivate,
        includeIndexes: opts.includeIndexes,
        emitMaterializers: opts.emitMaterializers,
        formPhasesOnly: opts.formPhasesOnly,
        schemaPaths,
    };

    // One model file per schema
    for (const schema of visibleSchemas) {
        const relPath = schemaPaths.get(schema.sourceName)!;
        files.push({
            path: path.posix.join(bundleDir, "models", `${relPath}.py`),
            content: emitModelPython(schema, modelOpts),
        });
        
        // Ensure __init__.py exists in models directory and subdirectories
        const dir = path.posix.join(bundleDir, "models", path.posix.dirname(relPath));
        addInitPys(files, bundleDir, path.posix.join("models", path.posix.dirname(relPath)));
    }

    const indexOpts = {
        includePrivate: opts.includePrivate,
        emitMaterializers: opts.emitMaterializers,
        hasValidators: (ir.validatorDeclarations ?? []).length > 0,
        hasFormatters: (ir.formatterDeclarations ?? []).length > 0,
    };

    // index.py (barrel)
    files.push({
        path: path.posix.join(bundleDir, "index.py"),
        content: emitIndexPython(ir.schemas, schemaPaths, indexOpts),
    });
    
    // Also create __init__.py at bundle root if not library? 
    // Usually index.py is used as entry point in these generated bundles.
    // But for Python packages, __init__.py is better.
    files.push({
        path: path.posix.join(bundleDir, "__init__.py"),
        content: emitIndexPython(ir.schemas, schemaPaths, indexOpts),
    });

    const validatorDecls = ir.validatorDeclarations ?? [];
    const formatterDecls = ir.formatterDeclarations ?? [];

    if (validatorDecls.length > 0) {
        const vf = emitValidatorFiles(validatorDecls);
        files.push({ path: path.posix.join(bundleDir, "validators.py"), content: vf.factoriesPy });
        files.push({ path: path.posix.join(bundleDir, "registry.py"), content: vf.registryPy });
    }

    if (formatterDecls.length > 0) {
        const ff = emitFormatterFiles(formatterDecls);
        files.push({ path: path.posix.join(bundleDir, "formatters.py"), content: ff.factoriesPy });
        files.push({ path: path.posix.join(bundleDir, "formatter_registry.py"), content: ff.registryPy });
    }

    return files;
}

function addInitPys(files: EmitFile[], bundleDir: string, relDir: string) {
    const parts = relDir.split("/");
    let current = "";
    for (const part of parts) {
        current = current ? path.posix.join(current, part) : part;
        const initPath = path.posix.join(bundleDir, current, "__init__.py");
        if (!files.some(f => f.path === initPath)) {
            files.push({ path: initPath, content: "" });
        }
    }
}

function getRelativeModelDir(sourceFile: string, sourceRoot?: string): string {
    if (!sourceRoot) return "";
    const rel = path.relative(sourceRoot, sourceFile);
    const dirname = path.dirname(rel);
    if (dirname === ".") return "";
    return dirname.split(path.sep).join(path.posix.sep);
}
