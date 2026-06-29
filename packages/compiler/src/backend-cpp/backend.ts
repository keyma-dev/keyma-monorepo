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
import type { BuildClassData } from "../driver/index.js";
import { emitServicesCpp, SERVICES_REF } from "./emit-service.js";
import { emitServiceClientCpp, SERVICE_CLIENT_REF } from "./emit-service-client.js";

/**
 * The neutral hooks the C++ backend reads, supplied by the host (the CLI) from the loaded
 * domains. No per-language packs: the data-model domain provides ONE language-agnostic
 * `classMetadata` builder, which the compiler renders into each class's `metadata()` aggregate.
 */
export type CppBackendOptions = {
    /** Build the per-class metadata descriptor (the data-model domain). Absent ⇒ a core-only
     *  build, which produces no classes. */
    classMetadata?: BuildClassData | undefined;
};

/**
 * Build a C++ backend from the neutral domain hooks. The generic bundle shell here is
 * domain-neutral; the class metadata comes from `opts.classMetadata` (the data-model domain,
 * registered by the CLI); enums and services are compiler-owned.
 */
export function createCppBackend(opts: CppBackendOptions): KeymaBackend {
    return {
        name: "@keyma/compiler/backend-cpp",
        target: "cpp",
        emit: (ir, target, config) => emitCpp(ir, target, config, opts),
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
    opts: CppBackendOptions
): Promise<EmitResult> {
    const cppTarget = resolveCppTarget(target as CppTargetConfig);
    const nsRoot = cppTarget.namespaceRoot;
    const files: EmitFile[] = [];

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
        }, cppTarget.vendorRuntime, opts, diagnostics));
    }
    if (cppTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(cppTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeDefaults: true, bundle: "server",
        }, cppTarget.vendorRuntime, opts, diagnostics));
    }
    if (cppTarget.emitLibrary) {
        files.push(...emitBundle(ir, cppTarget.outDir, shared, decls, {
            includePrivate: true, includeDefaults: true, bundle: "library",
        }, cppTarget.vendorRuntime, opts, diagnostics));
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
    backend: CppBackendOptions,
    diagnostics: IRDiagnostic[],
): EmitFile[] {
    const files: EmitFile[] = [];

    // The neutral per-class metadata builder (the data-model domain). Undefined only in a
    // core-only build (no classes).
    const classMetadata = backend.classMetadata;

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
    if (classGroups.size > 0 && classMetadata === undefined) {
        // Classes need a domain's metadata builder (the data-model domain). It is absent only in a
        // core-only build, which produces no classes — so reaching here is a real error.
        throw new Error("no domain `classMetadata` builder provided, but the IR has classes to emit");
    }
    if (moduleRefs.size > 0) {
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            // Only invoked when classGroups is non-empty, which the guard above proves has a builder.
            buildClassData: classMetadata ?? (() => { throw new Error("classMetadata missing"); }),
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

    return files;
}
