import { path, reachableFunctions, collectFunctionRefs } from "@keyma/core/util";
import type { KeymaIR, IRClassDeclaration, IRFunctionDeclaration } from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../driver/index.js";
import { emitModulePython, type ModuleEmitDeps, type ModuleContent } from "./emit-module.js";
import { emitIndexPython } from "./emit-index.js";
import { emitServicesPython, SERVICES_REF, type ServiceEmitDeps } from "./emit-service.js";
import { EMITTED_PY_RUNTIME, EMITTED_PY_RUNTIME_MODULE } from "./emitted-runtime.js";
import { moduleRefOf } from "./module-path.js";
import { resolvePythonTargetJSStyle as resolvePythonTarget, type PythonTargetConfig } from "./types.js";
import type { BuildClassData } from "../driver/index.js";

/**
 * The neutral hooks the Python backend reads, supplied by the host (the CLI) from the loaded
 * domains. No per-language packs: the data-model domain provides ONE language-agnostic
 * `classMetadata` builder, which the compiler renders into each class's `metadata` dict.
 */
export type PythonBackendOptions = {
    /** Build the per-class metadata descriptor (the data-model domain). Absent ⇒ a core-only
     *  build, which produces no classes. */
    classMetadata?: BuildClassData | undefined;
};

/**
 * Build a Python backend from the neutral domain hooks. The generic bundle shell here is
 * domain-neutral; the per-class metadata comes from `opts.classMetadata` (the data-model
 * domain, registered by the CLI).
 */
export function createPythonBackend(opts: PythonBackendOptions): KeymaBackend {
    return {
        name: "@keyma/compiler/backend-python",
        target: "python",
        emit: (ir, target, config) => emitPython(ir, target, config, opts),
    };
}

type SharedDeps = Pick<
    ModuleEmitDeps,
    "classModule" | "functionModule" | "classNameByName" | "functionDecls"
>;

type Decls = {
    functions: readonly IRFunctionDeclaration[];
};

export async function emitPython(
    ir: KeymaIR,
    target: KeymaTargetConfig,
    _config: ResolvedConfig,
    opts: PythonBackendOptions
): Promise<EmitResult> {
    const pyTarget = resolvePythonTarget(target as PythonTargetConfig);
    const files: EmitFile[] = [];

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

    const shared: SharedDeps = {
        classModule,
        functionModule,
        // Reference/embedded target `name` → emitted Python class (`sourceName`).
        classNameByName: new Map(ir.classes.map((s) => [s.name, s.sourceName])),
        functionDecls: new Map(decls.functions.map((d) => [d.name, d])),
    };

    if (pyTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(pyTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeDefaults: false,
        }, opts, "client"));
    }
    if (pyTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(pyTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeDefaults: true,
        }, opts, "server"));
    }
    if (pyTarget.emitLibrary) {
        files.push(...emitBundle(ir, pyTarget.outDir, shared, decls, {
            includePrivate: true, includeDefaults: true,
        }, opts, "library"));
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
    backend: PythonBackendOptions,
    bundle: "client" | "server" | "library",
): EmitFile[] {
    const files: EmitFile[] = [];

    // The neutral per-class metadata builder (the data-model domain). Undefined only in a
    // core-only build (no classes).
    const classMetadata = backend.classMetadata;

    const visibleClasses: IRClassDeclaration[] = opts.includePrivate
        ? ir.classes
        : ir.classes.filter((s) => s.visibility === "public");

    // Per-bundle tree-shaking: keep only the functions reachable from this bundle's visible roots
    // (class behaviors + defaults, including the synthesized validate/format* method bodies that
    // name the factory functions they call). Reachability is the client/server gate — a helper
    // reachable only from a private class's server method never lands in the client bundle.
    const functionsByName = new Map(decls.functions.map((d) => [d.name, d]));
    const seeds = collectFunctionRefs(visibleClasses, {
        includePrivate: opts.includePrivate,
        includeDefaults: opts.includeDefaults,
        functionNames: new Set(functionsByName.keys()),
    });
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

    if (visibleClasses.length > 0 && classMetadata === undefined) {
        // Classes need a domain's metadata builder (the data-model domain). Absent only in a
        // core-only build, which produces no classes — so reaching here is a real error.
        throw new Error("no domain `classMetadata` builder provided, but the IR has classes to emit");
    }
    if (moduleContent.size > 0) {
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            bundle,
            buildClassData: classMetadata ?? (() => ({ name: "", sourceName: "", fields: [] })),
        };
        for (const [ref, content] of moduleContent) {
            const c: ModuleContent = content;
            files.push({ path: path.posix.join(bundleDir, `${ref}.py`), content: emitModulePython(ref, c, deps) });
            addInitPys(files, bundleDir, path.posix.dirname(ref));
        }
    }

    // The self-contained baked runtime module (codec + RPC stack + intrinsics) every bundle carries
    // so generated code imports no `keyma-runtime` package. Sits at the bundle root; generated
    // modules / services import from it via relative path.
    files.push({ path: path.posix.join(bundleDir, `${EMITTED_PY_RUNTIME_MODULE}.py`), content: EMITTED_PY_RUNTIME });

    // Remotely-callable services (gated by visibility like classes). `@Service` is a base-language
    // concern the compiler owns end-to-end, so the bundle shell emits services directly from
    // `ir.services` — no domain pack participates. Server/library bundles emit the abstract base +
    // generated `dispatch`; the client bundle emits the transport-bound client class.
    const services = ir.services ?? [];
    const visibleServices = opts.includePrivate ? services : services.filter((s) => s.visibility === "public");
    if (visibleServices.length > 0) {
        const serviceDeps: ServiceEmitDeps = {
            includePrivate: opts.includePrivate,
            classModule: shared.classModule,
            classNameByName: shared.classNameByName,
        };
        const servicesPy = emitServicesPython(services, serviceDeps);
        if (servicesPy.length > 0) {
            files.push({ path: path.posix.join(bundleDir, `${SERVICES_REF}.py`), content: servicesPy });
        }
    }

    const indexContent = emitIndexPython(visibleClasses, shared.classModule, {
        includePrivate: opts.includePrivate,
    }, visibleServices.map((s) => s.sourceName));
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
