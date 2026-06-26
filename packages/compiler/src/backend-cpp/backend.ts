import { path, reachableFunctions, collectFunctionRefs, filterVisibleFields } from "@keyma/core/util";
import type {
    KeymaIR, IRClassDeclaration, IREnumDeclaration, IRService, IRType,
    IRFunctionDeclaration,
} from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../driver/index.js";
import { emitModuleCpp, collectFactoryNames, type ModuleEmitDeps } from "./emit-module.js";
import { emitIndexCpp } from "./emit-index.js";
import { emitSupportHpp } from "./emit-support.js";
import { moduleRefOf, namespaceOf, cppSanitizer } from "./module-path.js";
import { resolveCppTarget, VENDOR_RUNTIME_HEADER, type CppTargetConfig } from "./types.js";
import { EmitterRegistry, SERVICES_REF, SERVICE_CLIENT_REF, type CppEmitterPack } from "./emitter-registry.js";

/**
 * Build a C++ backend from the given domain emitter packs. The generic bundle shell here is
 * domain-neutral; the schema metadata + enums + services come from the registered pack (the
 * schema pack lives in `@keyma/schema/backend-cpp`, registered by the CLI).
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
    "nsRoot" | "schemaModule" | "classNameByName" | "cppTypeByName" | "enumTypeByName" | "enumModuleByName"
    | "idFieldByName" | "functionDecls" | "functionNames" | "functionModule" | "claimedFunctionNames"
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

    // The registered domain emit packs. The first (primary) supplies the per-schema metadata,
    // enum, and service emitters; the bundle shell stays domain-agnostic. Empty for a core build.
    const packs = registry.list();

    const decls: Decls = {
        functions: ir.functionDeclarations ?? [],
        enums: ir.enums ?? [],
        services: ir.services ?? [],
    };

    // Every declaration emits into the module derived from its SOURCE file: project-local
    // declarations under `src/`, out-of-project (library) declarations into the shared `vendor`.
    const schemaModule = new Map<string, string>(
        ir.classes.map((s) => [s.sourceName, moduleRefOf(s.source.file, ir.sourceRoot)]),
    );
    const enumModuleByName = new Map<string, string>(
        decls.enums.map((e) => [e.name, moduleRefOf(e.source.file, ir.sourceRoot)]),
    );
    const functionModule = new Map<string, string>(
        decls.functions.map((d) => [d.name, moduleRefOf(d.source.file, ir.sourceRoot)]),
    );
    // Reference/embedded/edge target `name` → fully-qualified emitted C++ struct type.
    const cppTypeByName = new Map<string, string>(
        ir.classes.map((s) => {
            const ref = schemaModule.get(s.sourceName)!;
            return [s.name, `${namespaceOf(ref, nsRoot)}::${s.sourceName}`];
        }),
    );
    // Named enum `name` → fully-qualified `enum class` type (in its module namespace).
    const enumTypeByName = new Map<string, string>(
        decls.enums.map((e) => [e.name, `${namespaceOf(enumModuleByName.get(e.name)!, nsRoot)}::${cppSanitizer(e.name)}`]),
    );
    // Schema `name` → its id field's name (for reference id-stubs). Defaults to "id".
    const idFieldByName = new Map<string, string>(
        ir.classes.map((s) => [s.name, s.fields.find((f) => f.type.kind === "id")?.name ?? "id"]),
    );
    // Schema `name`s that are the target of some reference field (recursing arrays). The
    // value_traits of these schemas carry id-stub helpers (set_id / id_value).
    const referenceTargetNames = new Set<string>();
    const collectRefTargets = (t: IRType): void => {
        if (t.kind === "reference") referenceTargetNames.add(t.schema);
        else if (t.kind === "array") collectRefTargets(t.of);
    };
    for (const s of ir.classes) for (const f of s.fields) collectRefTargets(f.type);

    // Functions a domain renders itself (with its own wrapper) rather than as plain functions.
    const claimedFunctionNames = new Set<string>();
    for (const p of packs) {
        if (p.claimFunctions !== undefined) for (const n of p.claimFunctions(ir)) claimedFunctionNames.add(n);
    }

    const shared: SharedDeps = {
        nsRoot,
        schemaModule,
        classNameByName: new Map(ir.classes.map((s) => [s.name, s.sourceName])),
        cppTypeByName,
        enumTypeByName,
        enumModuleByName,
        idFieldByName,
        functionDecls: new Map(decls.functions.map((d) => [d.name, d])),
        functionNames: new Set(decls.functions.map((d) => d.name)),
        functionModule,
        claimedFunctionNames,
        runtimeInclude: cppTarget.runtimeInclude,
        referenceTargetNames,
        // Typed binary codec emission is driven by the project-level `binary` config (the
        // same flag that turns on the frontend's tag assignment), shared across all bundles.
        binary: config.binary === true,
    };

    if (cppTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(cppTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeIndexes: false, formPhasesOnly: true, includeDefaults: false,
        }, cppTarget.vendorRuntime, packs, "client"));
    }
    if (cppTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(cppTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }, cppTarget.vendorRuntime, packs, "server"));
    }
    if (cppTarget.emitLibrary) {
        files.push(...emitBundle(ir, cppTarget.outDir, shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }, cppTarget.vendorRuntime, packs, "library"));
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
    vendorRuntime: boolean,
    packs: readonly CppEmitterPack[],
    bundle: "client" | "server" | "library",
): EmitFile[] {
    const files: EmitFile[] = [];

    // Primary pack — the per-schema metadata + enum provider (the schema domain) — selected by
    // CAPABILITY, not registration order. Undefined only in a core-only build (no schemas/enums).
    const pack = packs.find((p) => p.buildSchemaMeta !== undefined);

    // Vendor the runtime header into the bundle only when opted in; by default generated
    // headers depend on @keyma/runtime-cpp via `#include <keyma/runtime.hpp>`.
    if (vendorRuntime) {
        files.push({ path: path.posix.join(bundleDir, VENDOR_RUNTIME_HEADER), content: emitSupportHpp() });
    }

    const visibleSchemas: IRClassDeclaration[] = opts.includePrivate
        ? ir.classes
        : ir.classes.filter((s) => s.visibility === "public");

    // Per-bundle tree-shaking: keep only the functions reachable from this bundle's visible
    // roots (class behaviors + defaults + the validator/formatter factories on visible fields,
    // formatters gated to form phases for the client). Reachability is the client/server gate.
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

    // Group schemas, enums, AND functions by module (a file may declare any combination).
    const schemaGroups = new Map<string, IRClassDeclaration[]>();
    for (const s of visibleSchemas) {
        const ref = shared.schemaModule.get(s.sourceName)!;
        (schemaGroups.get(ref) ?? schemaGroups.set(ref, []).get(ref)!).push(s);
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
    const moduleRefs = new Set([...schemaGroups.keys(), ...enumGroups.keys(), ...fnGroups.keys()]);
    if (schemaGroups.size > 0 && (pack?.buildSchemaMeta === undefined || pack.emitEnumClass === undefined || pack.emitEnumConversions === undefined)) {
        // Schemas need a domain's metadata + enum emitters (the schema domain). They are absent
        // only in a core-only build, which produces no schemas — so reaching here is a real error.
        throw new Error("no C++ emitter pack with schema/enum emitters registered, but the IR has schemas to emit");
    }
    if (moduleRefs.size > 0) {
        const renderClaimedFunctions = pack?.renderClaimedFunctions !== undefined
            ? (dcls: readonly IRFunctionDeclaration[]) => pack.renderClaimedFunctions!(dcls, ir)
            : undefined;
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            buildSchemaMeta: pack?.buildSchemaMeta ?? (() => ""),
            emitEnumClass: pack?.emitEnumClass ?? (() => ""),
            emitEnumConversions: pack?.emitEnumConversions ?? (() => ""),
            ...(renderClaimedFunctions !== undefined ? { renderClaimedFunctions } : {}),
        };
        for (const ref of moduleRefs) {
            const content = emitModuleCpp(ref, schemaGroups.get(ref) ?? [], enumGroups.get(ref) ?? [], fnGroups.get(ref) ?? [], deps);
            files.push({ path: path.posix.join(bundleDir, `${ref}.hpp`), content });
        }
    }

    const visibleServices = opts.includePrivate
        ? decls.services
        : decls.services.filter((s) => s.visibility === "public");
    if (visibleServices.length > 0 && pack?.emitServices !== undefined && pack?.emitServiceClient !== undefined) {
        files.push({
            path: path.posix.join(bundleDir, `${SERVICES_REF}.hpp`),
            content: pack.emitServices(decls.services, {
                includePrivate: opts.includePrivate,
                nsRoot: shared.nsRoot,
                runtimeInclude: shared.runtimeInclude,
                schemaModule: shared.schemaModule,
                classNameByName: shared.classNameByName,
                cppTypeByName: shared.cppTypeByName,
                enumTypeByName: shared.enumTypeByName,
                enumModuleByName: shared.enumModuleByName,
            }),
        });
        // Typed call stubs (<nsRoot>::client::<Service>::<method> → keyma::CallLeaf<Ret>).
        // Opt-in (not pulled in by index.hpp) since it depends on <keyma/client.hpp>.
        files.push({
            path: path.posix.join(bundleDir, `${SERVICE_CLIENT_REF}.hpp`),
            content: pack.emitServiceClient(decls.services, {
                includePrivate: opts.includePrivate,
                nsRoot: shared.nsRoot,
                schemaModule: shared.schemaModule,
                classNameByName: shared.classNameByName,
                cppTypeByName: shared.cppTypeByName,
                enumTypeByName: shared.enumTypeByName,
                enumModuleByName: shared.enumModuleByName,
            }),
        });
    }

    files.push({
        path: path.posix.join(bundleDir, "index.hpp"),
        content: emitIndexCpp(visibleSchemas, shared.schemaModule, {
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
                bundle, bundleDir, includePrivate: opts.includePrivate,
                nsRoot: shared.nsRoot, runtimeInclude: shared.runtimeInclude,
            }));
        }
    }

    return files;
}
