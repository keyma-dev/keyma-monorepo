import { path } from "@keyma/core/util";
import type { KeymaIR, IRSchema, IRValidatorDeclaration, IRFormatterDeclaration, IRFunctionDeclaration } from "@keyma/core/ir";
import type { KeymaBackend, KeymaTargetConfig, ResolvedConfig, EmitFile, EmitResult } from "../../driver/src/index.js";
import { emitModuleJs, emitModuleDts, type ModuleEmitDeps } from "./emit-module.js";
import { emitIndexJs, emitIndexDts } from "./emit-index.js";
import {
    emitValidatorsJs, emitValidatorsDts,
    emitFormattersJs, emitFormattersDts,
    emitFunctionFiles,
} from "./emit-validators.js";
import { emitTypesJs, emitTypesDts } from "./emit-types.js";
import { moduleOf, identitySanitizer } from "./module-path.js";
import { resolveJsTarget, type JsTargetConfig } from "./types.js";
import { EmitterRegistry, type JsEmitterPack, type ServiceEmitDeps } from "./emitter-registry.js";

const VALIDATORS_REF = "validators";
const FORMATTERS_REF = "formatters";
const FUNCTIONS_REF = "functions";

/**
 * Build a JS backend from the given domain emitter packs. The generic bundle shell here is
 * domain-neutral; the schema metadata + services come from the registered pack(s) (the schema
 * pack lives in `@keyma/schema/backend-js`, registered by the CLI). The first pack owns the
 * core `<Class>.schema` metadata.
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
    "schemaModule" | "embeddedTypeNames" | "validatorDecls" | "formatterDecls" | "functionNames"
    | "validatorsModuleRef" | "formattersModuleRef" | "functionsModuleRef"
>;

type Decls = {
    validators: readonly IRValidatorDeclaration[];
    formatters: readonly IRFormatterDeclaration[];
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

    // The registered domain emit packs. The first (primary) supplies the per-schema metadata
    // builder + services emitter; the bundle shell below stays domain-agnostic. The full list
    // is threaded through so every pack's `emitBundleFiles` can contribute its own bundle files
    // (e.g. a UI domain alongside schema). Empty for a core-only build.
    const packs = registry.list();

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
        // A reference/embedded/edge target is the schema's `name`; map it to the
        // emitted class symbol (`sourceName`) for `.d.ts` types and `refs` values.
        embeddedTypeNames: new Map(ir.schemas.map((s) => [s.name, s.sourceName])),
        validatorDecls: new Map(decls.validators.map((d) => [d.name, d])),
        formatterDecls: new Map(decls.formatters.map((d) => [d.name, d])),
        functionNames: new Set(decls.functions.map((d) => d.name)),
        validatorsModuleRef: VALIDATORS_REF,
        formattersModuleRef: FORMATTERS_REF,
        functionsModuleRef: FUNCTIONS_REF,
    };

    if (jsTarget.emitClient) {
        files.push(...emitBundle(ir, path.posix.join(jsTarget.outDir, "client"), shared, decls, {
            includePrivate: false, includeIndexes: false, formPhasesOnly: true, includeDefaults: false,
        }, packs, "client"));
    }
    if (jsTarget.emitServer) {
        files.push(...emitBundle(ir, path.posix.join(jsTarget.outDir, "server"), shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }, packs, "server"));
    }
    if (jsTarget.emitLibrary) {
        files.push(...emitBundle(ir, jsTarget.outDir, shared, decls, {
            includePrivate: true, includeIndexes: true, formPhasesOnly: false, includeDefaults: true,
        }, packs, "library"));
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
    packs: readonly JsEmitterPack[],
    bundle: "client" | "server" | "library",
): EmitFile[] {
    const files: EmitFile[] = [];

    // The primary pack — the one that builds per-schema metadata + services (the schema
    // domain) — selected by CAPABILITY, not registration order, so a domain list in any order
    // resolves the same primary. Undefined only when no registered pack provides schema
    // metadata (a core-only build, which produces no schemas — the guards below never fire).
    const pack = packs.find((p) => p.buildSchemaData !== undefined);

    // Inlined, dependency-free type surface — every generated `.d.ts` imports its
    // runtime types from here instead of `@keyma/runtime/schema`.
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
    if (groups.size > 0) {
        // Schemas need a domain's metadata builder (the schema domain, registered first).
        // It is absent only in a core-only build, which produces no schemas — so reaching
        // here without it is a real error.
        if (pack?.buildSchemaData === undefined) throw new Error("no JS emitter pack with a schema-metadata builder registered, but the IR has schemas to emit");
        const deps: ModuleEmitDeps = {
            ...opts, ...shared,
            buildSchemaData: pack.buildSchemaData,
            ...(pack.shapeSchemaDts !== undefined ? { shapeSchemaDts: pack.shapeSchemaDts } : {}),
        };
        for (const [ref, schemas] of groups) {
            files.push({ path: path.posix.join(bundleDir, `${ref}.js`), content: emitModuleJs(ref, schemas, deps) });
            files.push({ path: path.posix.join(bundleDir, `${ref}.d.ts`), content: emitModuleDts(ref, schemas, deps) });
        }
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
    if (visibleServices.length > 0 && pack?.emitServices !== undefined) {
        const serviceDeps: ServiceEmitDeps = {
            includePrivate: opts.includePrivate,
            schemaModule: shared.schemaModule,
            embeddedTypeNames: shared.embeddedTypeNames,
        };
        const svc = pack.emitServices(services, serviceDeps);
        files.push({ path: path.posix.join(bundleDir, "services.js"), content: svc.js });
        files.push({ path: path.posix.join(bundleDir, "services.d.ts"), content: svc.dts });
    }

    const serviceNames = visibleServices.map((s) => s.sourceName);
    const indexOpts = { includePrivate: opts.includePrivate };
    files.push({ path: path.posix.join(bundleDir, "index.js"), content: emitIndexJs(visibleSchemas, shared.schemaModule, indexOpts, serviceNames) });
    files.push({ path: path.posix.join(bundleDir, "index.d.ts"), content: emitIndexDts(visibleSchemas, shared.schemaModule, indexOpts, serviceNames) });

    // Every registered pack may contribute its own bundle files from its IR slice (e.g. the
    // UI domain's view modules under `ui/`). Runs for all packs, not just the primary, so a
    // second domain emits alongside schema. Inert for packs without the hook (schema), so a
    // single-domain bundle is byte-identical.
    for (const p of packs) {
        if (p.emitBundleFiles !== undefined) {
            files.push(...p.emitBundleFiles(ir, { bundle, bundleDir, includePrivate: opts.includePrivate }));
        }
    }

    return files;
}
