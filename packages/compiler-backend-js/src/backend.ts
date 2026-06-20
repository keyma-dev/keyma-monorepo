import path from "node:path";
import type { KeymaIR, IRSchema, IRValidatorDeclaration, IRFormatterDeclaration, IRFunctionDeclaration } from "@keyma/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "@keyma/compiler";
import { emitModuleJs, emitModuleDts, type ModuleEmitDeps } from "./emit-module.js";
import { emitIndexJs, emitIndexDts } from "./emit-index.js";
import {
    emitValidatorsJs, emitValidatorsDts,
    emitFormattersJs, emitFormattersDts,
    emitFunctionFiles,
} from "./emit-validators.js";
import { emitServicesJs, emitServicesDts, type ServiceEmitDeps } from "./emit-service.js";
import { emitTypesJs, emitTypesDts } from "./emit-types.js";
import { moduleOf, identitySanitizer } from "./module-path.js";
import { resolveJsTarget, type JsTargetConfig } from "./types.js";

const VALIDATORS_REF = "validators";
const FORMATTERS_REF = "formatters";
const FUNCTIONS_REF = "functions";

export const jsBackend: KeymaBackend = {
    name: "@keyma/compiler-backend-js",
    target: "js",
    emit: emitJs,
};

type SharedDeps = Pick<
    ModuleEmitDeps,
    "schemaModule" | "embeddedTypeNames" | "validatorDecls" | "formatterDecls" | "functionNames"
    | "validatorsModuleRef" | "formattersModuleRef" | "functionsModuleRef"
> & {
    /** sourceName → schema runtime name (used by service metadata for validation/refs keys). */
    schemaName: ReadonlyMap<string, string>;
};

type Decls = {
    validators: readonly IRValidatorDeclaration[];
    formatters: readonly IRFormatterDeclaration[];
    functions: readonly IRFunctionDeclaration[];
};

export async function emitJs(
    ir: KeymaIR,
    target: KeymaTargetConfig,
    _config: ResolvedConfig
): Promise<EmitResult> {
    const jsTarget = resolveJsTarget(target as JsTargetConfig);
    const files: EmitFile[] = [];

    const decls: Decls = {
        validators: ir.validatorDeclarations ?? [],
        formatters: ir.formatterDeclarations ?? [],
        functions: ir.functionDeclarations ?? [],
    };

    // sourceName → bundle-relative module ref under models/ (e.g. "models/user/user"),
    // derived from the SOURCE file — schemas authored in one file share one module.
    const schemaModule = new Map<string, string>(
        ir.schemas.map((s) => [
            s.sourceName,
            path.posix.join("models", moduleOf(s.source.file, ir.sourceRoot, identitySanitizer)),
        ])
    );

    const shared: SharedDeps = {
        schemaModule,
        embeddedTypeNames: new Map(ir.schemas.map((s) => [s.sourceName, s.sourceName])),
        schemaName: new Map(ir.schemas.map((s) => [s.sourceName, s.name])),
        validatorDecls: new Map(decls.validators.map((d) => [d.name, d])),
        formatterDecls: new Map(decls.formatters.map((d) => [d.name, d])),
        functionNames: new Set(decls.functions.map((d) => d.name)),
        validatorsModuleRef: VALIDATORS_REF,
        formattersModuleRef: FORMATTERS_REF,
        functionsModuleRef: FUNCTIONS_REF,
    };

    if (jsTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(jsTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeIndexes: false, emitMaterializers: false, formPhasesOnly: true, includeDefaults: false,
        }));
    }
    if (jsTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(jsTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeIndexes: true, emitMaterializers: true, formPhasesOnly: false, includeDefaults: true,
        }));
    }
    if (jsTarget.emitLibrary) {
        files.push(...emitBundle(ir, jsTarget.outDir, shared, decls, {
            includePrivate: true, includeIndexes: true, emitMaterializers: true, formPhasesOnly: false, includeDefaults: true,
        }));
    }

    return { files, diagnostics: [] };
}

type BundleOptions = Pick<
    ModuleEmitDeps,
    "includePrivate" | "includeIndexes" | "emitMaterializers" | "formPhasesOnly" | "includeDefaults"
>;

function emitBundle(
    ir: KeymaIR,
    bundleDir: string,
    shared: SharedDeps,
    decls: Decls,
    opts: BundleOptions,
): EmitFile[] {
    const files: EmitFile[] = [];
    const deps: ModuleEmitDeps = { ...opts, ...shared };

    // Inlined, dependency-free type surface — every generated `.d.ts` imports its
    // runtime types from here instead of `@keyma/runtime-js`.
    files.push({ path: path.posix.join(bundleDir, "types.js"), content: emitTypesJs() });
    files.push({ path: path.posix.join(bundleDir, "types.d.ts"), content: emitTypesDts() });

    const visibleSchemas: IRSchema[] = opts.includePrivate
        ? ir.schemas
        : ir.schemas.filter((s) => s.visibility === "public");

    // One model file per source module (multiple schemas grouped together).
    const groups = new Map<string, IRSchema[]>();
    for (const s of visibleSchemas) {
        const ref = shared.schemaModule.get(s.sourceName)!;
        const list = groups.get(ref) ?? [];
        list.push(s);
        groups.set(ref, list);
    }
    for (const [ref, schemas] of groups) {
        files.push({ path: path.posix.join(bundleDir, `${ref}.js`), content: emitModuleJs(ref, schemas, deps) });
        files.push({ path: path.posix.join(bundleDir, `${ref}.d.ts`), content: emitModuleDts(ref, schemas, deps) });
    }

    // Shared direct-ref factory modules at the bundle root.
    const functionNames = decls.functions.map((d) => d.name);
    if (decls.functions.length > 0) {
        const fn = emitFunctionFiles(decls.functions, shared.embeddedTypeNames);
        files.push({ path: path.posix.join(bundleDir, "functions.js"), content: fn.functionsJs });
        files.push({ path: path.posix.join(bundleDir, "functions.d.ts"), content: fn.functionsDts });
    }
    if (decls.validators.length > 0) {
        files.push({ path: path.posix.join(bundleDir, "validators.js"), content: emitValidatorsJs(decls.validators, functionNames) });
        files.push({ path: path.posix.join(bundleDir, "validators.d.ts"), content: emitValidatorsDts(decls.validators) });
    }
    if (decls.formatters.length > 0) {
        files.push({ path: path.posix.join(bundleDir, "formatters.js"), content: emitFormattersJs(decls.formatters, functionNames) });
        files.push({ path: path.posix.join(bundleDir, "formatters.d.ts"), content: emitFormattersDts(decls.formatters) });
    }

    // Remotely-callable services (gated by visibility like schemas).
    const services = ir.services ?? [];
    const visibleServices = opts.includePrivate ? services : services.filter((s) => s.visibility === "public");
    if (visibleServices.length > 0) {
        const serviceDeps: ServiceEmitDeps = {
            includePrivate: opts.includePrivate,
            schemaModule: shared.schemaModule,
            embeddedTypeNames: shared.embeddedTypeNames,
            schemaName: shared.schemaName,
        };
        files.push({ path: path.posix.join(bundleDir, "services.js"), content: emitServicesJs(services, serviceDeps) });
        files.push({ path: path.posix.join(bundleDir, "services.d.ts"), content: emitServicesDts(services, serviceDeps) });
    }

    const serviceNames = visibleServices.map((s) => s.sourceName);
    const indexOpts = { includePrivate: opts.includePrivate, emitMaterializers: opts.emitMaterializers };
    files.push({ path: path.posix.join(bundleDir, "index.js"), content: emitIndexJs(visibleSchemas, shared.schemaModule, indexOpts, serviceNames) });
    files.push({ path: path.posix.join(bundleDir, "index.d.ts"), content: emitIndexDts(visibleSchemas, shared.schemaModule, indexOpts, serviceNames) });

    return files;
}
