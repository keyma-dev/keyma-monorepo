import { path } from "@keyma/core/util";
import type { KeymaIR, IRSchema, IRValidatorDeclaration, IRFormatterDeclaration, IRFunctionDeclaration } from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../driver/index.js";
import { emitModulePython, type ModuleEmitDeps } from "./emit-module.js";
import { emitIndexPython } from "./emit-index.js";
import { emitValidatorsPy, emitFormattersPy, emitFunctionsPy } from "./emit-validators.js";
import { moduleOf } from "./module-path.js";
import { resolvePythonTargetJSStyle as resolvePythonTarget, type PythonTargetConfig } from "./types.js";
import { EmitterRegistry, type PythonEmitterPack } from "./emitter-registry.js";

const VALIDATORS_REF = "validators";
const FORMATTERS_REF = "formatters";
const FUNCTIONS_REF = "functions";

/**
 * Build a Python backend from the given domain emitter packs. The generic bundle shell here
 * is domain-neutral; the schema metadata comes from the registered pack (the schema pack lives
 * in `@keyma/schema/backend-python`, registered by the CLI).
 */
export function createPythonBackend(packs: Iterable<PythonEmitterPack>): KeymaBackend {
    const registry = new EmitterRegistry();
    for (const pack of packs) registry.register(pack);
    return {
        name: "@keyma/compiler/backend-python",
        target: "python",
        emit: (ir, target, config) => emitPython(ir, target, config, registry),
    };
}

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
    _config: ResolvedConfig,
    registry: EmitterRegistry
): Promise<EmitResult> {
    const pyTarget = resolvePythonTarget(target as PythonTargetConfig);
    const files: EmitFile[] = [];

    // The registered domain emit packs. The first (primary) supplies the per-schema metadata
    // builder; the bundle shell stays domain-agnostic. The full list is threaded through so
    // every pack's `emitBundleFiles` can contribute its own bundle files. Empty for a
    // core-only build.
    const packs = registry.list();

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
        }, packs, "client"));
    }
    if (pyTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(pyTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }, packs, "server"));
    }
    if (pyTarget.emitLibrary) {
        files.push(...emitBundle(ir, pyTarget.outDir, shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }, packs, "library"));
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
    packs: readonly PythonEmitterPack[],
    bundle: "client" | "server" | "library",
): EmitFile[] {
    const files: EmitFile[] = [];

    // Primary pack — the per-schema metadata provider (the schema domain) — selected by
    // CAPABILITY, not registration order. Undefined only in a core-only build (no schemas).
    const pack = packs.find((p) => p.buildSchemaData !== undefined);

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
    if (groups.size > 0) {
        // Schemas need a domain's metadata builder (the schema domain, registered first).
        // It is absent only in a core-only build, which produces no schemas — so reaching
        // here without it is a real error.
        if (pack?.buildSchemaData === undefined) throw new Error("no Python emitter pack with a schema-metadata builder registered, but the IR has schemas to emit");
        const deps: ModuleEmitDeps = { ...opts, ...shared, buildSchemaData: pack.buildSchemaData };
        for (const [ref, schemas] of groups) {
            files.push({ path: path.posix.join(bundleDir, `${ref}.py`), content: emitModulePython(ref, schemas, deps) });
            addInitPys(files, bundleDir, path.posix.dirname(ref));
        }
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

    // Every registered pack may contribute its own bundle files from its IR slice (e.g. the
    // UI domain's view modules under `ui/`). Inert for packs without the hook (schema), so a
    // single-domain bundle is byte-identical.
    for (const p of packs) {
        if (p.emitBundleFiles !== undefined) {
            files.push(...p.emitBundleFiles(ir, { bundle, bundleDir, includePrivate: opts.includePrivate }));
        }
    }

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
