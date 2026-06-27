import { path, moduleRefOf, reachableFunctions, collectFunctionRefs, filterVisibleFields } from "@keyma/core/util";
import type { KeymaIR, IRClassDeclaration, IRFunctionDeclaration } from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../driver/index.js";
import { emitModuleJs, emitModuleDts, type ModuleEmitDeps, type ModuleContent } from "./emit-module.js";
import { emitIndexJs, emitIndexDts } from "./emit-index.js";
import { emitTypesJs, emitTypesDts } from "./emit-types.js";
import { identitySanitizer } from "./module-path.js";
import { resolveJsTarget, type JsTargetConfig } from "./types.js";
import { EmitterRegistry, type JsEmitterPack, type ServiceEmitDeps } from "./emitter-registry.js";
import { emitServicesJs, emitServicesDts } from "./emit-service.js";

/**
 * Build a JS backend from the given domain emitter packs. The generic bundle shell here is
 * domain-neutral; the per-class metadata + services come from the registered pack(s) (the
 * data-model pack is registered by the CLI). The first pack owns the core `<Class>.metadata`.
 */
export function createJsBackend(packs: Iterable<JsEmitterPack>): KeymaBackend {
    const registry = new EmitterRegistry();
    for (const pack of packs) registry.register(pack);
    return {
        name: "@keyma/compiler/backend-js",
        target: "js",
        emit: (ir, target, config) => emitJs(ir, target, config, registry),
    };
}

type SharedDeps = Pick<
    ModuleEmitDeps,
    "classModule" | "functionModule" | "embeddedTypeNames" | "functionDecls" | "claimedFunctionNames"
>;

type Decls = {
    functions: readonly IRFunctionDeclaration[];
};

export async function emitJs(
    ir: KeymaIR,
    target: KeymaTargetConfig,
    _config: ResolvedConfig,
    registry: EmitterRegistry
): Promise<EmitResult> {
    const jsTarget = resolveJsTarget(target as JsTargetConfig);
    const files: EmitFile[] = [];

    // The registered domain emit packs. The first (primary) supplies the per-class metadata
    // builder + the per-member function hook + the `.d.ts` shaping; the bundle shell below stays
    // domain-agnostic. The full list is threaded through so every pack's `emitBundleFiles` can
    // contribute its own bundle files (e.g. a UI domain). Empty for a core-only build.
    const packs = registry.list();

    const decls: Decls = {
        functions: ir.functionDeclarations ?? [],
    };

    // Every declaration emits into the module derived from its SOURCE file: project-local
    // declarations under `src/` (classes authored in one file share a module), out-of-project
    // (library) declarations into the single shared `vendor` module.
    const classModule = new Map<string, string>(
        ir.classes.map((s) => [s.sourceName, moduleRefOf(s.source.file, ir.sourceRoot, identitySanitizer)])
    );
    const functionModule = new Map<string, string>(
        decls.functions.map((d) => [d.name, moduleRefOf(d.source.file, ir.sourceRoot, identitySanitizer)])
    );

    // Functions a domain renders itself (with its own wrapper) rather than as plain functions.
    const claimedFunctionNames = new Set<string>();
    for (const p of packs) {
        if (p.claimFunctions !== undefined) for (const n of p.claimFunctions(ir)) claimedFunctionNames.add(n);
    }

    const shared: SharedDeps = {
        classModule,
        functionModule,
        // A reference/embedded target is the target class's `name`; map it to the emitted
        // class symbol (`sourceName`) for `.d.ts` types and `refs` values.
        embeddedTypeNames: new Map(ir.classes.map((s) => [s.name, s.sourceName])),
        functionDecls: new Map(decls.functions.map((d) => [d.name, d])),
        claimedFunctionNames,
    };

    if (jsTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(jsTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeDefaults: false, bundle: "client",
        }, packs));
    }
    if (jsTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(jsTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeDefaults: true, bundle: "server",
        }, packs));
    }
    if (jsTarget.emitLibrary) {
        files.push(...emitBundle(ir, jsTarget.outDir, shared, decls, {
            includePrivate: true, includeDefaults: true, bundle: "library",
        }, packs));
    }

    return { files, diagnostics: [] };
}

type BundleOptions = Pick<
    ModuleEmitDeps,
    "includePrivate" | "includeDefaults" | "bundle"
>;

function emitBundle(
    ir: KeymaIR,
    bundleDir: string,
    shared: SharedDeps,
    decls: Decls,
    opts: BundleOptions,
    packs: readonly JsEmitterPack[],
): EmitFile[] {
    const files: EmitFile[] = [];
    const bundle = opts.bundle;

    // The primary pack — the one that builds per-class metadata (the data-model domain) —
    // selected by CAPABILITY, not registration order. Undefined only when no registered pack
    // builds class metadata (a core-only build, which produces no classes).
    const pack = packs.find((p) => p.buildClassData !== undefined);

    // Inlined, dependency-free type surface — every generated `.d.ts` imports its runtime types
    // from here. The compiler base blob carries the service/request types; each domain pack
    // appends its own metadata declarations (e.g. `ClassMetadata`).
    const extraTypeDecls = packs
        .map((p) => p.runtimeTypeDecls?.())
        .filter((d): d is string => d !== undefined && d.length > 0);
    files.push({ path: path.posix.join(bundleDir, "types.js"), content: emitTypesJs() });
    files.push({ path: path.posix.join(bundleDir, "types.d.ts"), content: emitTypesDts(extraTypeDecls) });

    const visibleClasses: IRClassDeclaration[] = opts.includePrivate
        ? ir.classes
        : ir.classes.filter((s) => s.visibility === "public");

    // Per-bundle tree-shaking: keep only the functions reachable from this bundle's visible
    // roots (public/private class behaviors + defaults + the per-member functions a domain
    // attaches to visible members). Reachability is the client/server security gate — a helper
    // reachable only from a private class's server method never lands in the client bundle.
    const functionsByName = new Map(decls.functions.map((d) => [d.name, d]));
    const allVisibleFields = visibleClasses.flatMap((s) => filterVisibleFields(s, opts.includePrivate));
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

    // Group declarations by their source module: classes by their module ref, functions by
    // theirs (the two coincide for a class + helper authored in one file).
    const moduleContent = new Map<string, { classes: IRClassDeclaration[]; functions: IRFunctionDeclaration[] }>();
    const slot = (ref: string) => {
        let c = moduleContent.get(ref);
        if (c === undefined) { c = { classes: [], functions: [] }; moduleContent.set(ref, c); }
        return c;
    };
    for (const s of visibleClasses) slot(shared.classModule.get(s.sourceName)!).classes.push(s);
    for (const d of reachableFns) slot(shared.functionModule.get(d.name)!).functions.push(d);

    if (visibleClasses.length > 0 && pack?.buildClassData === undefined) {
        // Classes need a domain's metadata builder. Absent only in a core-only build, which
        // produces no classes — so reaching here is a real error.
        throw new Error("no JS emitter pack with a class-metadata builder registered, but the IR has classes to emit");
    }
    if (moduleContent.size > 0) {
        const renderClaimedFunctions = pack?.renderClaimedFunctions !== undefined
            ? (dcls: readonly IRFunctionDeclaration[]) => pack.renderClaimedFunctions!(dcls, ir)
            : undefined;
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            buildClassData: pack?.buildClassData ?? (() => ({})),
            ...(pack?.shapeClassDts !== undefined ? { shapeClassDts: pack.shapeClassDts } : {}),
            ...(pack?.referencedFunctionNames !== undefined ? { referencedFunctionNames: pack.referencedFunctionNames } : {}),
            ...(renderClaimedFunctions !== undefined ? { renderClaimedFunctions } : {}),
        };
        for (const [ref, content] of moduleContent) {
            const c: ModuleContent = content;
            files.push({ path: path.posix.join(bundleDir, `${ref}.js`), content: emitModuleJs(ref, c, deps) });
            files.push({ path: path.posix.join(bundleDir, `${ref}.d.ts`), content: emitModuleDts(ref, c, deps) });
        }
    }

    // Remotely-callable services (gated by visibility like classes). `@Service` is a
    // base-language concern the compiler owns end-to-end, so the bundle shell emits services
    // directly from `ir.services` — no domain pack participates.
    const services = ir.services ?? [];
    const visibleServices = opts.includePrivate ? services : services.filter((s) => s.visibility === "public");
    if (visibleServices.length > 0) {
        const serviceDeps: ServiceEmitDeps = {
            includePrivate: opts.includePrivate,
            classModule: shared.classModule,
            embeddedTypeNames: shared.embeddedTypeNames,
        };
        files.push({ path: path.posix.join(bundleDir, "services.js"), content: emitServicesJs(services, serviceDeps) });
        files.push({ path: path.posix.join(bundleDir, "services.d.ts"), content: emitServicesDts(services, serviceDeps) });
    }

    const serviceNames = visibleServices.map((s) => s.sourceName);
    const indexOpts = { includePrivate: opts.includePrivate };
    files.push({ path: path.posix.join(bundleDir, "index.js"), content: emitIndexJs(visibleClasses, shared.classModule, indexOpts, serviceNames) });
    files.push({ path: path.posix.join(bundleDir, "index.d.ts"), content: emitIndexDts(visibleClasses, shared.classModule, indexOpts, serviceNames) });

    // Every registered pack may contribute its own bundle files from its IR slice (e.g. the
    // UI domain's view modules under `ui/`). Runs for all packs, not just the primary, so a
    // second domain emits alongside the data model. Inert for packs without the hook.
    for (const p of packs) {
        if (p.emitBundleFiles !== undefined) {
            files.push(...p.emitBundleFiles(ir, { bundle, bundleDir, includePrivate: opts.includePrivate }));
        }
    }

    return files;
}
