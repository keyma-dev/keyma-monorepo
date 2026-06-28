import { path, reachableFunctions, collectFunctionRefs, inheritedFields } from "@keyma/core/util";
import type {
    KeymaIR, IRClassDeclaration, IREnumDeclaration, IRService, IRType,
    IRFunctionDeclaration, IRDiagnostic,
} from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../driver/index.js";
import { emitModuleCpp, type ModuleEmitDeps } from "./emit-module.js";
import { emitIndexCpp } from "./emit-index.js";
import { emitSupportHpp } from "./emit-support.js";
import { moduleRefOf, namespaceOf, cppSanitizer } from "./module-path.js";
import { resolveCppTarget, VENDOR_RUNTIME_HEADER, type CppTargetConfig } from "./types.js";
import { EmitterRegistry, SERVICES_REF, SERVICE_CLIENT_REF, type CppEmitterPack } from "./emitter-registry.js";
import { emitServicesCpp } from "./emit-service.js";
import { emitServiceClientCpp } from "./emit-service-client.js";

/**
 * Build a C++ backend from the given domain emitter packs. The generic bundle shell here is
 * domain-neutral; the class metadata + enums + services come from the registered pack (the
 * primary domain pack is registered by the CLI).
 */
export function createCppBackend(packs: Iterable<CppEmitterPack>): KeymaBackend {
    const registry = new EmitterRegistry();
    for (const pack of packs) registry.register(pack);
    return {
        name: "@keyma/compiler/backend-cpp",
        target: "cpp",
        emit: (ir, target, config) => emitCpp(ir, target, config, registry),
    };
}

type SharedDeps = Pick<
    ModuleEmitDeps,
    "nsRoot" | "classBySourceName" | "classModule" | "classNameByName" | "cppTypeByName" | "enumTypeByName" | "enumModuleByName"
    | "idFieldByName" | "functionDecls" | "functionNames" | "functionModule"
    | "runtimeInclude" | "referenceTargetNames" | "binary"
>;

type Decls = {
    functions: readonly IRFunctionDeclaration[];
    enums: readonly IREnumDeclaration[];
    services: readonly IRService[];
};

export async function emitCpp(
    ir: KeymaIR,
    target: KeymaTargetConfig,
    config: ResolvedConfig,
    registry: EmitterRegistry
): Promise<EmitResult> {
    const cppTarget = resolveCppTarget(target as CppTargetConfig);
    const nsRoot = cppTarget.namespaceRoot;
    const files: EmitFile[] = [];

    // The registered domain emit packs. The first (primary) supplies the per-class metadata,
    // enum, and service emitters; the bundle shell stays domain-agnostic. Empty for a core build.
    const packs = registry.list();

    const decls: Decls = {
        functions: ir.functionDeclarations ?? [],
        enums: ir.enums ?? [],
        services: ir.services ?? [],
    };

    // Every declaration emits into the module derived from its SOURCE file: project-local
    // declarations under `src/`, out-of-project (library) declarations into the shared `vendor`.
    const classModule = new Map<string, string>(
        ir.classes.map((s) => [s.sourceName, moduleRefOf(s.source.file, ir.sourceRoot)]),
    );
    const enumModuleByName = new Map<string, string>(
        decls.enums.map((e) => [e.name, moduleRefOf(e.source.file, ir.sourceRoot)]),
    );
    const functionModule = new Map<string, string>(
        decls.functions.map((d) => [d.name, moduleRefOf(d.source.file, ir.sourceRoot)]),
    );
    // Reference/embedded target `name` → fully-qualified emitted C++ struct type.
    const cppTypeByName = new Map<string, string>(
        ir.classes.map((s) => {
            const ref = classModule.get(s.sourceName)!;
            return [s.name, `${namespaceOf(ref, nsRoot)}::${s.sourceName}`];
        }),
    );
    // Named enum `name` → fully-qualified `enum class` type (in its module namespace).
    const enumTypeByName = new Map<string, string>(
        decls.enums.map((e) => [e.name, `${namespaceOf(enumModuleByName.get(e.name)!, nsRoot)}::${cppSanitizer(e.name)}`]),
    );
    // Resolve `extends` parents (keyed by sourceName) so trait emitters can walk the chain.
    const classBySourceName = new Map<string, IRClassDeclaration>(ir.classes.map((s) => [s.sourceName, s]));
    // Class `name` → its id field's name (for reference id-stubs). The id may be INHERITED, so
    // search the full chain. Defaults to "id".
    const idFieldByName = new Map<string, string>(
        ir.classes.map((s) => [s.name, inheritedFields(s, classBySourceName).find((f) => f.type.kind === "id")?.name ?? "id"]),
    );
    // Class `name`s that are the target of some reference field (recursing arrays). The
    // value_traits of these classes carry id-stub helpers (set_id / id_value).
    const referenceTargetNames = new Set<string>();
    const collectRefTargets = (t: IRType): void => {
        if (t.kind === "reference") referenceTargetNames.add(t.target);
        else if (t.kind === "array") collectRefTargets(t.of);
    };
    for (const s of ir.classes) for (const f of s.fields) collectRefTargets(f.type);

    const shared: SharedDeps = {
        nsRoot,
        classBySourceName,
        classModule,
        classNameByName: new Map(ir.classes.map((s) => [s.name, s.sourceName])),
        cppTypeByName,
        enumTypeByName,
        enumModuleByName,
        idFieldByName,
        functionDecls: new Map(decls.functions.map((d) => [d.name, d])),
        functionNames: new Set(decls.functions.map((d) => d.name)),
        functionModule,
        runtimeInclude: cppTarget.runtimeInclude,
        referenceTargetNames,
        // Typed binary codec emission is driven by the project-level `binary` config (the
        // same flag that turns on the frontend's tag assignment), shared across all bundles.
        binary: config.binary === true,
    };

    // Diagnostics raised during emission (e.g. issue 010's async-not-yet-C++-emittable). The same
    // async member is emitted into multiple bundles (client + server), so dedupe before returning.
    const diagnostics: IRDiagnostic[] = [];

    if (cppTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(cppTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeDefaults: false, bundle: "client",
        }, cppTarget.vendorRuntime, packs, diagnostics));
    }
    if (cppTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(cppTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeDefaults: true, bundle: "server",
        }, cppTarget.vendorRuntime, packs, diagnostics));
    }
    if (cppTarget.emitLibrary) {
        files.push(...emitBundle(ir, cppTarget.outDir, shared, decls, {
            includePrivate: true, includeDefaults: true, bundle: "library",
        }, cppTarget.vendorRuntime, packs, diagnostics));
    }

    return { files, diagnostics: dedupeDiagnostics(diagnostics) };
}

/** Collapse identical diagnostics (same code/message/source) raised once per bundle into one. */
function dedupeDiagnostics(diagnostics: readonly IRDiagnostic[]): IRDiagnostic[] {
    const seen = new Map<string, IRDiagnostic>();
    for (const d of diagnostics) {
        const s = d.source;
        const key = `${d.code}|${d.severity}|${d.message}|${s?.file ?? ""}:${s?.line ?? ""}:${s?.column ?? ""}`;
        if (!seen.has(key)) seen.set(key, d);
    }
    return [...seen.values()];
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
    vendorRuntime: boolean,
    packs: readonly CppEmitterPack[],
    diagnostics: IRDiagnostic[],
): EmitFile[] {
    const files: EmitFile[] = [];

    // Primary pack — the per-class metadata provider (the primary domain) — selected by
    // CAPABILITY, not registration order. Undefined only in a core-only build (no classes).
    const pack = packs.find((p) => p.buildClassData !== undefined);

    // Vendor the runtime header into the bundle only when opted in; by default generated
    // headers depend on @keyma/runtime-cpp via `#include <keyma/runtime.hpp>`.
    if (vendorRuntime) {
        files.push({ path: path.posix.join(bundleDir, VENDOR_RUNTIME_HEADER), content: emitSupportHpp() });
    }

    const visibleClasses: IRClassDeclaration[] = opts.includePrivate
        ? ir.classes
        : ir.classes.filter((s) => s.visibility === "public");

    // Per-bundle tree-shaking: keep only the functions reachable from this bundle's visible
    // roots (class behaviors + defaults, including the synthesized validate/format* method bodies
    // that name the factory functions they call). Reachability is the client/server gate.
    const functionsByName = new Map(decls.functions.map((d) => [d.name, d]));
    const seeds = collectFunctionRefs(visibleClasses, {
        includePrivate: opts.includePrivate,
        includeDefaults: opts.includeDefaults,
        functionNames: new Set(functionsByName.keys()),
    });
    const reachable = reachableFunctions(seeds, functionsByName);
    const reachableFns = decls.functions.filter((d) => reachable.has(d.name));

    // Group classes, enums, AND functions by module (a file may declare any combination).
    const classGroups = new Map<string, IRClassDeclaration[]>();
    for (const s of visibleClasses) {
        const ref = shared.classModule.get(s.sourceName)!;
        (classGroups.get(ref) ?? classGroups.set(ref, []).get(ref)!).push(s);
    }
    const enumGroups = new Map<string, IREnumDeclaration[]>();
    for (const e of decls.enums) {
        const ref = shared.enumModuleByName.get(e.name)!;
        (enumGroups.get(ref) ?? enumGroups.set(ref, []).get(ref)!).push(e);
    }
    const fnGroups = new Map<string, IRFunctionDeclaration[]>();
    for (const d of reachableFns) {
        const ref = shared.functionModule.get(d.name)!;
        (fnGroups.get(ref) ?? fnGroups.set(ref, []).get(ref)!).push(d);
    }
    const moduleRefs = new Set([...classGroups.keys(), ...enumGroups.keys(), ...fnGroups.keys()]);
    if (classGroups.size > 0 && pack?.buildClassData === undefined) {
        // Classes need a domain's metadata builder (the primary domain). It is absent only in a
        // core-only build, which produces no classes — so reaching here is a real error.
        throw new Error("no C++ emitter pack with a class metadata builder registered, but the IR has classes to emit");
    }
    if (moduleRefs.size > 0) {
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            // Only invoked when classGroups is non-empty, which the guard above proves has a pack.
            buildClassData: pack?.buildClassData ?? (() => { throw new Error("buildClassData missing"); }),
        };
        for (const ref of moduleRefs) {
            const content = emitModuleCpp(ref, classGroups.get(ref) ?? [], enumGroups.get(ref) ?? [], fnGroups.get(ref) ?? [], deps, diagnostics);
            files.push({ path: path.posix.join(bundleDir, `${ref}.hpp`), content });
        }
    }

    // Remotely-callable services (gated by visibility like classes). `@Service` is a
    // base-language concern the compiler owns end-to-end, so the bundle shell emits the
    // service + service-client headers directly from `ir.services` — no domain pack participates.
    const visibleServices = opts.includePrivate
        ? decls.services
        : decls.services.filter((s) => s.visibility === "public");
    if (visibleServices.length > 0) {
        files.push({
            path: path.posix.join(bundleDir, `${SERVICES_REF}.hpp`),
            content: emitServicesCpp(decls.services, {
                includePrivate: opts.includePrivate,
                nsRoot: shared.nsRoot,
                runtimeInclude: shared.runtimeInclude,
                binary: shared.binary,
                classModule: shared.classModule,
                classNameByName: shared.classNameByName,
                cppTypeByName: shared.cppTypeByName,
                enumTypeByName: shared.enumTypeByName,
                enumModuleByName: shared.enumModuleByName,
            }),
        });
        // Per-service typed client (<nsRoot>::client::<Service>) bound to a keyma::transport,
        // returning keyma::task<keyma::result<T, error>>. Opt-in (not pulled in by index.hpp)
        // since calling a service inherently needs the runtime transport.
        files.push({
            path: path.posix.join(bundleDir, `${SERVICE_CLIENT_REF}.hpp`),
            content: emitServiceClientCpp(decls.services, {
                includePrivate: opts.includePrivate,
                nsRoot: shared.nsRoot,
                runtimeInclude: shared.runtimeInclude,
                binary: shared.binary,
                classModule: shared.classModule,
                classNameByName: shared.classNameByName,
                cppTypeByName: shared.cppTypeByName,
                enumTypeByName: shared.enumTypeByName,
                enumModuleByName: shared.enumModuleByName,
            }),
        });
    }

    files.push({
        path: path.posix.join(bundleDir, "index.hpp"),
        content: emitIndexCpp(visibleClasses, shared.classModule, {
            includePrivate: opts.includePrivate,
            nsRoot: shared.nsRoot,
            enums: decls.enums,
            enumModule: shared.enumModuleByName,
            services: visibleServices,
        }),
    });

    // Every registered pack may contribute its own bundle files from its IR slice (e.g. the
    // UI domain's view headers under `ui/`). Inert for packs without the hook.
    for (const p of packs) {
        if (p.emitBundleFiles !== undefined) {
            files.push(...p.emitBundleFiles(ir, {
                bundle: opts.bundle, bundleDir, includePrivate: opts.includePrivate,
                nsRoot: shared.nsRoot, runtimeInclude: shared.runtimeInclude,
            }));
        }
    }

    return files;
}
