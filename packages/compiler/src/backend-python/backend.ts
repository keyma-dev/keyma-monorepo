import { path, reachableFunctions, collectFunctionRefs, filterVisibleFields } from "@keyma/core/util";
import type { KeymaIR, IRClassDeclaration, IRFunctionDeclaration } from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../driver/index.js";
import { emitModulePython, collectFactoryNames, type ModuleEmitDeps, type ModuleContent } from "./emit-module.js";
import { emitIndexPython } from "./emit-index.js";
import { moduleRefOf } from "./module-path.js";
import { resolvePythonTargetJSStyle as resolvePythonTarget, type PythonTargetConfig } from "./types.js";
import { EmitterRegistry, type PythonEmitterPack } from "./emitter-registry.js";

/**
 * Build a Python backend from the given domain emitter packs. The generic bundle shell here is
 * domain-neutral; the schema metadata comes from the registered pack (the schema pack lives in
 * `@keyma/schema/backend-python`, registered by the CLI).
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
    "schemaModule" | "functionModule" | "classNameByName" | "functionDecls" | "claimedFunctionNames"
>;

type Decls = {
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
    // builder + the validator/formatter render hook; the bundle shell stays domain-agnostic. The
    // full list is threaded through so every pack's `emitBundleFiles` can contribute its own
    // bundle files. Empty for a core-only build.
    const packs = registry.list();

    const decls: Decls = {
        functions: ir.functionDeclarations ?? [],
    };

    // Every declaration emits into the module derived from its SOURCE file: project-local
    // declarations under `src/` (classes authored in one file share a module), out-of-project
    // (library) declarations into the single shared `vendor` module.
    const schemaModule = new Map<string, string>(
        ir.classes.map((s) => [s.sourceName, moduleRefOf(s.source.file, ir.sourceRoot)])
    );
    const functionModule = new Map<string, string>(
        decls.functions.map((d) => [d.name, moduleRefOf(d.source.file, ir.sourceRoot)])
    );

    // Functions a domain renders itself (with its own wrapper) rather than as plain functions.
    const claimedFunctionNames = new Set<string>();
    for (const p of packs) {
        if (p.claimFunctions !== undefined) for (const n of p.claimFunctions(ir)) claimedFunctionNames.add(n);
    }

    const shared: SharedDeps = {
        schemaModule,
        functionModule,
        // Reference/embedded/edge target `name` → emitted Python class (`sourceName`).
        classNameByName: new Map(ir.classes.map((s) => [s.name, s.sourceName])),
        functionDecls: new Map(decls.functions.map((d) => [d.name, d])),
        claimedFunctionNames,
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

    const visibleSchemas: IRClassDeclaration[] = opts.includePrivate
        ? ir.classes
        : ir.classes.filter((s) => s.visibility === "public");

    // Per-bundle tree-shaking: keep only the functions reachable from this bundle's visible roots
    // (class behaviors + defaults + the validator/formatter factories on visible fields,
    // formatters gated to form phases for the client). Reachability is the client/server gate —
    // a helper reachable only from a private class's server method never lands in the client bundle.
    const functionsByName = new Map(decls.functions.map((d) => [d.name, d]));
    const allVisibleFields = visibleSchemas.flatMap((s) => filterVisibleFields(s, opts.includePrivate));
    const seeds = collectFunctionRefs(visibleSchemas, {
        includePrivate: opts.includePrivate,
        includeDefaults: opts.includeDefaults,
        functionNames: new Set(functionsByName.keys()),
    });
    for (const n of collectFactoryNames(allVisibleFields, "validators", opts.formPhasesOnly)) seeds.add(n);
    for (const n of collectFactoryNames(allVisibleFields, "formatters", opts.formPhasesOnly)) seeds.add(n);
    const reachable = reachableFunctions(seeds, functionsByName);
    const reachableFns = decls.functions.filter((d) => reachable.has(d.name));

    // Group declarations by their source module: classes by their module ref, functions by theirs
    // (the two coincide for a class + helper authored in one file).
    const moduleContent = new Map<string, { classes: IRClassDeclaration[]; functions: IRFunctionDeclaration[] }>();
    const slot = (ref: string) => {
        let c = moduleContent.get(ref);
        if (c === undefined) { c = { classes: [], functions: [] }; moduleContent.set(ref, c); }
        return c;
    };
    for (const s of visibleSchemas) slot(shared.schemaModule.get(s.sourceName)!).classes.push(s);
    for (const d of reachableFns) slot(shared.functionModule.get(d.name)!).functions.push(d);

    if (visibleSchemas.length > 0 && pack?.buildSchemaData === undefined) {
        // Schemas need a domain's metadata builder (the schema domain). Absent only in a
        // core-only build, which produces no schemas — so reaching here is a real error.
        throw new Error("no Python emitter pack with a schema-metadata builder registered, but the IR has schemas to emit");
    }
    if (moduleContent.size > 0) {
        const renderClaimedFunctions = pack?.renderClaimedFunctions !== undefined
            ? (dcls: readonly IRFunctionDeclaration[]) => pack.renderClaimedFunctions!(dcls, ir)
            : undefined;
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            buildSchemaData: pack?.buildSchemaData ?? (() => ({})),
            ...(renderClaimedFunctions !== undefined ? { renderClaimedFunctions } : {}),
        };
        for (const [ref, content] of moduleContent) {
            const c: ModuleContent = content;
            files.push({ path: path.posix.join(bundleDir, `${ref}.py`), content: emitModulePython(ref, c, deps) });
            addInitPys(files, bundleDir, path.posix.dirname(ref));
        }
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
