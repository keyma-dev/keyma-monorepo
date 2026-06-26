import { path } from "@keyma/core/util";
import type {
    KeymaIR, IRSchema, IREnumDeclaration, IRService, IRType,
    IRValidatorDeclaration, IRFormatterDeclaration, IRFunctionDeclaration,
} from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../driver/index.js";
import { emitModuleCpp, type ModuleEmitDeps } from "./emit-module.js";
import { emitIndexCpp } from "./emit-index.js";
import { emitValidatorsCpp, emitFormattersCpp, emitFunctionsCpp } from "./emit-validators.js";
import { emitSupportHpp } from "./emit-support.js";
import { moduleOf, namespaceOf, cppSanitizer } from "./module-path.js";
import { resolveCppTarget, VENDOR_RUNTIME_HEADER, type CppTargetConfig } from "./types.js";
import { EmitterRegistry, SERVICES_REF, SERVICE_CLIENT_REF, type CppEmitterPack } from "./emitter-registry.js";

const VALIDATORS_REF = "validators";
const FORMATTERS_REF = "formatters";
const FUNCTIONS_REF = "functions";

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
    | "idFieldByName" | "validatorDecls" | "formatterDecls" | "functionNames"
    | "validatorsModuleRef" | "formattersModuleRef" | "functionsModuleRef"
    | "runtimeInclude" | "referenceTargetNames" | "binary"
>;

type Decls = {
    validators: readonly IRValidatorDeclaration[];
    formatters: readonly IRFormatterDeclaration[];
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
    // enum, and service emitters; the bundle shell stays domain-agnostic. The full list is
    // threaded through so every pack's `emitBundleFiles` can contribute its own bundle files.
    // Empty for a core-only build.
    const packs = registry.list();

    const decls: Decls = {
        validators: ir.validatorDeclarations ?? [],
        formatters: ir.formatterDeclarations ?? [],
        functions: ir.functionDeclarations ?? [],
        enums: ir.enums ?? [],
        services: ir.services ?? [],
    };

    // sourceName → bundle-relative module ref under models/, from the SOURCE file.
    const schemaModule = new Map<string, string>(
        ir.schemas.map((s) => [s.sourceName, path.posix.join("models", moduleOf(s.source.file, ir.sourceRoot))]),
    );
    // Named enum `name` → its declaring file's module ref (enums follow source-file layout).
    const enumModuleByName = new Map<string, string>(
        decls.enums.map((e) => [e.name, path.posix.join("models", moduleOf(e.source.file, ir.sourceRoot))]),
    );
    // Reference/embedded/edge target `name` → fully-qualified emitted C++ struct type.
    const cppTypeByName = new Map<string, string>(
        ir.schemas.map((s) => {
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
        ir.schemas.map((s) => [s.name, s.fields.find((f) => f.type.kind === "id")?.name ?? "id"]),
    );
    // Schema `name`s that are the target of some reference field (recursing arrays). The
    // value_traits of these schemas carry id-stub helpers (set_id / id_value).
    const referenceTargetNames = new Set<string>();
    const collectRefTargets = (t: IRType): void => {
        if (t.kind === "reference") referenceTargetNames.add(t.schema);
        else if (t.kind === "array") collectRefTargets(t.of);
    };
    for (const s of ir.schemas) for (const f of s.fields) collectRefTargets(f.type);

    const shared: SharedDeps = {
        nsRoot,
        schemaModule,
        classNameByName: new Map(ir.schemas.map((s) => [s.name, s.sourceName])),
        cppTypeByName,
        enumTypeByName,
        enumModuleByName,
        idFieldByName,
        validatorDecls: new Map(decls.validators.map((d) => [d.name, d])),
        formatterDecls: new Map(decls.formatters.map((d) => [d.name, d])),
        functionNames: new Set(decls.functions.map((d) => d.name)),
        validatorsModuleRef: VALIDATORS_REF,
        formattersModuleRef: FORMATTERS_REF,
        functionsModuleRef: FUNCTIONS_REF,
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

    const visibleSchemas: IRSchema[] = opts.includePrivate
        ? ir.schemas
        : ir.schemas.filter((s) => s.visibility === "public");

    // Group schemas AND enums by module (a file may declare either or both).
    const schemaGroups = new Map<string, IRSchema[]>();
    for (const s of visibleSchemas) {
        const ref = shared.schemaModule.get(s.sourceName)!;
        (schemaGroups.get(ref) ?? schemaGroups.set(ref, []).get(ref)!).push(s);
    }
    const enumGroups = new Map<string, IREnumDeclaration[]>();
    for (const e of decls.enums) {
        const ref = shared.enumModuleByName.get(e.name)!;
        (enumGroups.get(ref) ?? enumGroups.set(ref, []).get(ref)!).push(e);
    }
    const moduleRefs = new Set([...schemaGroups.keys(), ...enumGroups.keys()]);
    if (moduleRefs.size > 0) {
        // Schemas/enums need a domain's metadata + enum emitters (the schema domain, registered
        // first). They are absent only in a core-only build, which produces neither — so
        // reaching here without them is a real error.
        if (pack?.buildSchemaMeta === undefined || pack.emitEnumClass === undefined || pack.emitEnumConversions === undefined) {
            throw new Error("no C++ emitter pack with schema/enum emitters registered, but the IR has schemas/enums to emit");
        }
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            buildSchemaMeta: pack.buildSchemaMeta,
            emitEnumClass: pack.emitEnumClass,
            emitEnumConversions: pack.emitEnumConversions,
        };
        for (const ref of moduleRefs) {
            const content = emitModuleCpp(ref, schemaGroups.get(ref) ?? [], enumGroups.get(ref) ?? [], deps);
            files.push({ path: path.posix.join(bundleDir, `${ref}.hpp`), content });
        }
    }

    const hasFunctions = decls.functions.length > 0;
    if (hasFunctions) {
        files.push({ path: path.posix.join(bundleDir, `${FUNCTIONS_REF}.hpp`), content: emitFunctionsCpp(decls.functions, shared.nsRoot, shared.runtimeInclude) });
    }
    if (decls.validators.length > 0) {
        files.push({ path: path.posix.join(bundleDir, `${VALIDATORS_REF}.hpp`), content: emitValidatorsCpp(decls.validators, hasFunctions, shared.nsRoot, shared.runtimeInclude) });
    }
    if (decls.formatters.length > 0) {
        files.push({ path: path.posix.join(bundleDir, `${FORMATTERS_REF}.hpp`), content: emitFormattersCpp(decls.formatters, hasFunctions, shared.nsRoot, shared.runtimeInclude) });
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
    // UI domain's view headers under `ui/`). Inert for packs without the hook (schema), so a
    // single-domain bundle is byte-identical.
    for (const p of packs) {
        if (p.emitBundleFiles !== undefined) {
            files.push(...p.emitBundleFiles(ir, { bundle, bundleDir, includePrivate: opts.includePrivate }));
        }
    }

    return files;
}
