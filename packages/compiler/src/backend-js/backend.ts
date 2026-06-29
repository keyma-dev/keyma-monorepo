import { path, moduleRefOf, reachableFunctions, collectFunctionRefs } from "@keyma/core/util";
import type { KeymaIR, IRClassDeclaration, IRFunctionDeclaration } from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../driver/index.js";
import { emitModuleJs, emitModuleDts, type ModuleEmitDeps, type ModuleContent } from "./emit-module.js";
import { emitIndexJs, emitIndexDts } from "./emit-index.js";
import { emitTypesJs, emitTypesDts } from "./emit-types.js";
import { identitySanitizer } from "./module-path.js";
import { resolveJsTarget, type JsTargetConfig } from "./types.js";
import type { BuildClassData } from "../driver/index.js";
import { emitServicesJs, emitServicesDts, type ServiceEmitDeps } from "./emit-service.js";
import { EMITTED_RUNTIME_MODULES } from "./emitted-runtime-modules.js";

/**
 * The neutral hooks the JS backend reads, supplied by the host (the CLI) from the loaded domains.
 * No per-language packs: the data-model domain provides ONE language-agnostic `classMetadata`
 * builder (the compiler renders it into `<Class>.metadata`), plus any `.d.ts` type-surface blocks.
 */
export type JsBackendOptions = {
    /** Build the per-class metadata descriptor (the data-model domain). Absent ⇒ a core-only
     *  build, which produces no classes. */
    classMetadata?: BuildClassData | undefined;
    /** Domain runtime type-declaration blocks, appended to every bundle's `types.d.ts` after the
     *  compiler-owned service/request surface. Empty for a core-only build. */
    runtimeTypeDecls?: readonly (() => string)[] | undefined;
};

/**
 * Build a JS backend from the neutral domain hooks. The generic bundle shell here is
 * domain-neutral; the per-class metadata comes from `opts.classMetadata` (the data-model
 * domain, registered by the CLI) and the appended type surface from `opts.runtimeTypeDecls`.
 */
export function createJsBackend(opts: JsBackendOptions): KeymaBackend {
    return {
        name: "@keyma/compiler/backend-js",
        target: "js",
        emit: (ir, target, config) => emitJs(ir, target, config, opts),
    };
}

type SharedDeps = Pick<
    ModuleEmitDeps,
    "classModule" | "functionModule" | "embeddedTypeNames" | "functionDecls"
>;

type Decls = {
    functions: readonly IRFunctionDeclaration[];
};

export async function emitJs(
    ir: KeymaIR,
    target: KeymaTargetConfig,
    _config: ResolvedConfig,
    opts: JsBackendOptions
): Promise<EmitResult> {
    const jsTarget = resolveJsTarget(target as JsTargetConfig);
    const files: EmitFile[] = [];

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

    const shared: SharedDeps = {
        classModule,
        functionModule,
        // A reference/embedded target is the target class's `name`; map it to the emitted
        // class symbol (`sourceName`) for `.d.ts` types and `refs` values.
        embeddedTypeNames: new Map(ir.classes.map((s) => [s.name, s.sourceName])),
        functionDecls: new Map(decls.functions.map((d) => [d.name, d])),
    };

    if (jsTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(jsTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeDefaults: false, bundle: "client",
        }, opts));
    }
    if (jsTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(jsTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeDefaults: true, bundle: "server",
        }, opts));
    }
    if (jsTarget.emitLibrary) {
        files.push(...emitBundle(ir, jsTarget.outDir, shared, decls, {
            includePrivate: true, includeDefaults: true, bundle: "library",
        }, opts));
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
    backend: JsBackendOptions,
): EmitFile[] {
    const files: EmitFile[] = [];

    // The neutral per-class metadata builder (the data-model domain). Undefined only in a
    // core-only build, which produces no classes.
    const classMetadata = backend.classMetadata;

    // Inlined, dependency-free type surface — every generated `.d.ts` imports its runtime types
    // from here. The compiler base blob carries the service/request types; each domain appends
    // its own metadata declarations (e.g. `ClassMetadata`) via `runtimeTypeDecls`.
    const extraTypeDecls = (backend.runtimeTypeDecls ?? [])
        .map((fn) => fn())
        .filter((d) => d.length > 0);
    files.push({ path: path.posix.join(bundleDir, "types.js"), content: emitTypesJs() });
    files.push({ path: path.posix.join(bundleDir, "types.d.ts"), content: emitTypesDts(extraTypeDecls) });

    // Bundle-local runtime BEHAVIOR — the model codec + the @Service RPC stack (host / client /
    // transport / errors), baked verbatim from `@keyma/runtime`. Emitted as siblings to
    // `types.js` so the generated class/service code imports the codec + RPC from here and
    // depends on NO `@keyma/runtime` package (the self-containment guarantee).
    for (const [name, mod] of Object.entries(EMITTED_RUNTIME_MODULES)) {
        files.push({ path: path.posix.join(bundleDir, `${name}.js`), content: mod.js });
        files.push({ path: path.posix.join(bundleDir, `${name}.d.ts`), content: mod.dts });
    }

    const visibleClasses: IRClassDeclaration[] = opts.includePrivate
        ? ir.classes
        : ir.classes.filter((s) => s.visibility === "public");

    // Per-bundle tree-shaking: keep only the functions reachable from this bundle's visible
    // roots (public/private class behaviors + defaults, including the synthesized
    // validate/format* method bodies that name the factory functions they call). Reachability is
    // the client/server security gate — a helper reachable only from a private class's server
    // method never lands in the client bundle.
    const functionsByName = new Map(decls.functions.map((d) => [d.name, d]));
    const seeds = collectFunctionRefs(visibleClasses, {
        includePrivate: opts.includePrivate,
        includeDefaults: opts.includeDefaults,
        functionNames: new Set(functionsByName.keys()),
    });
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

    if (visibleClasses.length > 0 && classMetadata === undefined) {
        // Classes need a domain's metadata builder. Absent only in a core-only build, which
        // produces no classes — so reaching here is a real error.
        throw new Error("no domain `classMetadata` builder provided, but the IR has classes to emit");
    }
    if (moduleContent.size > 0) {
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            buildClassData: classMetadata ?? (() => ({ name: "", sourceName: "", fields: [] })),
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

    return files;
}
