import path from "node:path";
import type {
    KeymaIR, IRSchema, IREnumDeclaration, IRService, IRType,
    IRValidatorDeclaration, IRFormatterDeclaration, IRFunctionDeclaration,
} from "@keyma/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "@keyma/compiler";
import { emitModuleCpp, type ModuleEmitDeps } from "./emit-module.js";
import { emitIndexCpp } from "./emit-index.js";
import { emitValidatorsCpp, emitFormattersCpp, emitFunctionsCpp } from "./emit-validators.js";
import { emitServicesCpp, SERVICES_REF } from "./emit-service.js";
import { emitServiceClientCpp, SERVICE_CLIENT_REF } from "./emit-service-client.js";
import { emitSupportHpp } from "./emit-support.js";
import { moduleOf, namespaceOf, cppSanitizer } from "./module-path.js";
import { resolveCppTarget, VENDOR_RUNTIME_HEADER, type CppTargetConfig } from "./types.js";

const VALIDATORS_REF = "validators";
const FORMATTERS_REF = "formatters";
const FUNCTIONS_REF = "functions";

export const cppBackend: KeymaBackend = {
    name: "@keyma/compiler-backend-cpp",
    target: "cpp",
    emit: emitCpp,
};

type SharedDeps = Pick<
    ModuleEmitDeps,
    "nsRoot" | "schemaModule" | "classNameByName" | "cppTypeByName" | "enumTypeByName" | "enumModuleByName"
    | "idFieldByName" | "validatorDecls" | "formatterDecls" | "functionNames"
    | "validatorsModuleRef" | "formattersModuleRef" | "functionsModuleRef"
    | "runtimeInclude" | "referenceTargetNames"
>;

type Decls = {
    validators: readonly IRValidatorDeclaration[];
    formatters: readonly IRFormatterDeclaration[];
    functions: readonly IRFunctionDeclaration[];
    enums: readonly IREnumDeclaration[];
    services: readonly IRService[];
};

export async function emitCpp(ir: KeymaIR, target: KeymaTargetConfig, _config: ResolvedConfig): Promise<EmitResult> {
    const cppTarget = resolveCppTarget(target as CppTargetConfig);
    const nsRoot = cppTarget.namespaceRoot;
    const files: EmitFile[] = [];

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
    };

    if (cppTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(cppTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeIndexes: false, formPhasesOnly: true, includeDefaults: false,
        }, cppTarget.vendorRuntime));
    }
    if (cppTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(cppTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }, cppTarget.vendorRuntime));
    }
    if (cppTarget.emitLibrary) {
        files.push(...emitBundle(ir, cppTarget.outDir, shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }, cppTarget.vendorRuntime));
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
): EmitFile[] {
    const files: EmitFile[] = [];
    const deps: ModuleEmitDeps = { ...opts, ...shared };

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
    for (const ref of new Set([...schemaGroups.keys(), ...enumGroups.keys()])) {
        const content = emitModuleCpp(ref, schemaGroups.get(ref) ?? [], enumGroups.get(ref) ?? [], deps);
        files.push({ path: path.posix.join(bundleDir, `${ref}.hpp`), content });
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
    if (visibleServices.length > 0) {
        files.push({
            path: path.posix.join(bundleDir, `${SERVICES_REF}.hpp`),
            content: emitServicesCpp(decls.services, {
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
            content: emitServiceClientCpp(decls.services, {
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

    return files;
}
