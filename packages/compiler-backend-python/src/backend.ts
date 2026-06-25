import { path } from "@keyma/compiler-util";
import type { KeymaIR, IRSchema, IRValidatorDeclaration, IRFormatterDeclaration, IRFunctionDeclaration } from "@keyma/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "@keyma/compiler";
import { emitModulePython, type ModuleEmitDeps } from "./emit-module.js";
import { emitIndexPython } from "./emit-index.js";
import { emitValidatorsPy, emitFormattersPy, emitFunctionsPy } from "./emit-validators.js";
import { moduleOf } from "./module-path.js";
import { resolvePythonTargetJSStyle as resolvePythonTarget, type PythonTargetConfig } from "./types.js";

const VALIDATORS_REF = "validators";
const FORMATTERS_REF = "formatters";
const FUNCTIONS_REF = "functions";

export const pythonBackend: KeymaBackend = {
    name: "@keyma/compiler-backend-python",
    target: "python",
    emit: emitPython,
};

type SharedDeps = Pick<
    ModuleEmitDeps,
    "schemaModule" | "classNameByName" | "validatorDecls" | "formatterDecls" | "functionNames"
    | "validatorsModuleRef" | "formattersModuleRef" | "functionsModuleRef"
>;

type Decls = {
    validators: readonly IRValidatorDeclaration[];
    formatters: readonly IRFormatterDeclaration[];
    functions: readonly IRFunctionDeclaration[];
};

export async function emitPython(
    ir: KeymaIR,
    target: KeymaTargetConfig,
    _config: ResolvedConfig
): Promise<EmitResult> {
    const pyTarget = resolvePythonTarget(target as PythonTargetConfig);
    const files: EmitFile[] = [];

    const decls: Decls = {
        validators: ir.validatorDeclarations ?? [],
        formatters: ir.formatterDeclarations ?? [],
        functions: ir.functionDeclarations ?? [],
    };

    // sourceName → bundle-relative module ref under models/, from the SOURCE file
    // (Python-sanitized: `user-credentials.ts` → models/user_credentials).
    const schemaModule = new Map<string, string>(
        ir.schemas.map((s) => [s.sourceName, path.posix.join("models", moduleOf(s.source.file, ir.sourceRoot))])
    );

    const shared: SharedDeps = {
        schemaModule,
        // Reference/embedded/edge target `name` → emitted Python class (`sourceName`).
        classNameByName: new Map(ir.schemas.map((s) => [s.name, s.sourceName])),
        validatorDecls: new Map(decls.validators.map((d) => [d.name, d])),
        formatterDecls: new Map(decls.formatters.map((d) => [d.name, d])),
        functionNames: new Set(decls.functions.map((d) => d.name)),
        validatorsModuleRef: VALIDATORS_REF,
        formattersModuleRef: FORMATTERS_REF,
        functionsModuleRef: FUNCTIONS_REF,
    };

    if (pyTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(pyTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeIndexes: false, formPhasesOnly: true, includeDefaults: false,
        }));
    }
    if (pyTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(pyTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }));
    }
    if (pyTarget.emitLibrary) {
        files.push(...emitBundle(ir, pyTarget.outDir, shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }));
    }

    return { files, diagnostics: [] };
}

type BundleOptions = Pick<
    ModuleEmitDeps,
    "includePrivate" | "includeIndexes" | "formPhasesOnly" | "includeDefaults"
>;

function emitBundle(
    ir: KeymaIR,
    bundleDir: string,
    shared: SharedDeps,
    decls: Decls,
    opts: BundleOptions,
): EmitFile[] {
    const files: EmitFile[] = [];
    const deps: ModuleEmitDeps = { ...opts, ...shared };

    const visibleSchemas: IRSchema[] = opts.includePrivate
        ? ir.schemas
        : ir.schemas.filter((s) => s.visibility === "public");

    const groups = new Map<string, IRSchema[]>();
    for (const s of visibleSchemas) {
        const ref = shared.schemaModule.get(s.sourceName)!;
        const list = groups.get(ref) ?? [];
        list.push(s);
        groups.set(ref, list);
    }
    for (const [ref, schemas] of groups) {
        files.push({ path: path.posix.join(bundleDir, `${ref}.py`), content: emitModulePython(ref, schemas, deps) });
        addInitPys(files, bundleDir, path.posix.dirname(ref));
    }

    const hasFunctions = decls.functions.length > 0;
    if (hasFunctions) {
        files.push({ path: path.posix.join(bundleDir, "functions.py"), content: emitFunctionsPy(decls.functions) });
    }
    if (decls.validators.length > 0) {
        files.push({ path: path.posix.join(bundleDir, "validators.py"), content: emitValidatorsPy(decls.validators, hasFunctions) });
    }
    if (decls.formatters.length > 0) {
        files.push({ path: path.posix.join(bundleDir, "formatters.py"), content: emitFormattersPy(decls.formatters, hasFunctions) });
    }

    const indexContent = emitIndexPython(visibleSchemas, shared.schemaModule, {
        includePrivate: opts.includePrivate,
    });
    files.push({ path: path.posix.join(bundleDir, "index.py"), content: indexContent });
    files.push({ path: path.posix.join(bundleDir, "__init__.py"), content: indexContent });

    return files;
}

/** Ensure an empty `__init__.py` exists for every package directory in `relDir`. */
function addInitPys(files: EmitFile[], bundleDir: string, relDir: string): void {
    if (relDir === "." || relDir === "") return;
    const parts = relDir.split("/");
    let current = "";
    for (const part of parts) {
        current = current ? path.posix.join(current, part) : part;
        const initPath = path.posix.join(bundleDir, current, "__init__.py");
        if (!files.some((f) => f.path === initPath)) files.push({ path: initPath, content: "" });
    }
}
