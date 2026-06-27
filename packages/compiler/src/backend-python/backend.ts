import { path, reachableFunctions, collectFunctionRefs, filterVisibleFields } from "@keyma/core/util";
import type { KeymaIR, IRClassDeclaration, IRFunctionDeclaration, IRMember } from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../driver/index.js";
import { emitModulePython, type ModuleEmitDeps, type ModuleContent } from "./emit-module.js";
import { emitIndexPython } from "./emit-index.js";
import { moduleRefOf } from "./module-path.js";
import { resolvePythonTargetJSStyle as resolvePythonTarget, type PythonTargetConfig } from "./types.js";
import { EmitterRegistry, type PythonEmitterPack } from "./emitter-registry.js";

/**
 * Build a Python backend from the given domain emitter packs. The generic bundle shell here is
 * domain-neutral; the per-class metadata comes from the registered pack (the data-model domain's
 * pack is registered by the CLI).
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
    "classModule" | "functionModule" | "classNameByName" | "functionDecls" | "claimedFunctionNames"
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

    // The registered domain emit packs. The first (primary) supplies the per-class metadata
    // builder + the claimed-function render hook; the bundle shell stays domain-agnostic. The
    // full list is threaded through so every pack's `emitBundleFiles` can contribute its own
    // bundle files. Empty for a core-only build.
    const packs = registry.list();

    const decls: Decls = {
        functions: ir.functionDeclarations ?? [],
    };

    // Every declaration emits into the module derived from its SOURCE file: project-local
    // declarations under `src/` (classes authored in one file share a module), out-of-project
    // (library) declarations into the single shared `vendor` module.
    const classModule = new Map<string, string>(
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
        classModule,
        functionModule,
        // Reference/embedded target `name` → emitted Python class (`sourceName`).
        classNameByName: new Map(ir.classes.map((s) => [s.name, s.sourceName])),
        functionDecls: new Map(decls.functions.map((d) => [d.name, d])),
        claimedFunctionNames,
    };

    if (pyTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(pyTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeDefaults: false,
        }, packs, "client"));
    }
    if (pyTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(pyTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeDefaults: true,
        }, packs, "server"));
    }
    if (pyTarget.emitLibrary) {
        files.push(...emitBundle(ir, pyTarget.outDir, shared, decls, {
            includePrivate: true, includeDefaults: true,
        }, packs, "library"));
    }

    return { files, diagnostics: [] };
}

type BundleOptions = Pick<
    ModuleEmitDeps,
    "includePrivate" | "includeDefaults"
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

    // Primary pack — the per-class metadata provider (the data-model domain) — selected by
    // CAPABILITY, not registration order. Undefined only in a core-only build (no classes).
    const pack = packs.find((p) => p.buildClassData !== undefined);

    const visibleClasses: IRClassDeclaration[] = opts.includePrivate
        ? ir.classes
        : ir.classes.filter((s) => s.visibility === "public");

    // Per-bundle tree-shaking: keep only the functions reachable from this bundle's visible roots
    // (class behaviors + defaults + the functions a domain's visible members reference, the latter
    // gated per bundle by the domain). Reachability is the client/server gate — a helper reachable
    // only from a private class's server method never lands in the client bundle.
    const functionsByName = new Map(decls.functions.map((d) => [d.name, d]));
    const allVisibleFields: IRMember[] = visibleClasses.flatMap((s) => filterVisibleFields(s, opts.includePrivate));
    const seeds = collectFunctionRefs(visibleClasses, {
        includePrivate: opts.includePrivate,
        includeDefaults: opts.includeDefaults,
        functionNames: new Set(functionsByName.keys()),
    });
    if (pack?.referencedFunctionNames !== undefined) {
        for (const n of pack.referencedFunctionNames(allVisibleFields, { bundle })) seeds.add(n);
    }
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
    for (const s of visibleClasses) slot(shared.classModule.get(s.sourceName)!).classes.push(s);
    for (const d of reachableFns) slot(shared.functionModule.get(d.name)!).functions.push(d);

    if (visibleClasses.length > 0 && pack?.buildClassData === undefined) {
        // Classes need a domain's metadata builder (the data-model domain). Absent only in a
        // core-only build, which produces no classes — so reaching here is a real error.
        throw new Error("no Python emitter pack with a class-metadata builder registered, but the IR has classes to emit");
    }
    if (moduleContent.size > 0) {
        const renderClaimedFunctions = pack?.renderClaimedFunctions !== undefined
            ? (dcls: readonly IRFunctionDeclaration[]) => pack.renderClaimedFunctions!(dcls, ir)
            : undefined;
        const referencedFunctionNames = pack?.referencedFunctionNames !== undefined
            ? (members: readonly IRMember[], ctx: { bundle: "client" | "server" | "library" }) =>
                  pack.referencedFunctionNames!(members, ctx)
            : undefined;
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            bundle,
            buildClassData: pack?.buildClassData ?? (() => ({})),
            ...(referencedFunctionNames !== undefined ? { referencedFunctionNames } : {}),
            ...(renderClaimedFunctions !== undefined ? { renderClaimedFunctions } : {}),
        };
        for (const [ref, content] of moduleContent) {
            const c: ModuleContent = content;
            files.push({ path: path.posix.join(bundleDir, `${ref}.py`), content: emitModulePython(ref, c, deps) });
            addInitPys(files, bundleDir, path.posix.dirname(ref));
        }
    }

    const indexContent = emitIndexPython(visibleClasses, shared.classModule, {
        includePrivate: opts.includePrivate,
    });
    files.push({ path: path.posix.join(bundleDir, "index.py"), content: indexContent });
    files.push({ path: path.posix.join(bundleDir, "__init__.py"), content: indexContent });

    // Every registered pack may contribute its own bundle files from its IR slice (e.g. the
    // UI domain's view modules under `ui/`). Inert for packs without the hook (the data-model
    // pack), so a single-domain bundle is byte-identical.
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
