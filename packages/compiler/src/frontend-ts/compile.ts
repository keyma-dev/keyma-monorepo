import { path } from "@keyma/core/util";
import ts from "typescript";
import type { KeymaIR, IRDiagnostic, TagManifest } from "@keyma/core/ir";
import { createProgram, DEFAULT_COMPILER_OPTIONS } from "./program.js";
import { FrontendExtensionRegistry, type FrontendDomain, type FrontendDomainContext } from "./extension-registry.js";

export type FrontendConfig = {
    /** Absolute paths to user schema TypeScript source files. */
    files: readonly string[];
    /** Base directory for source files. Used to calculate relative paths in the IR. */
    baseDir?: string;
    /** TypeScript compiler options (defaults to strict + experimentalDecorators). */
    compilerOptions?: ts.CompilerOptions;
    /** Module specifier the schema-authoring decorators are imported from. The schema
     *  frontend domain defaults this to "@keyma/schema/dsl"; override only to point the
     *  discovery at a different DSL module. */
    dslModuleName?: string;
    /** Frontend domains to run. Each contributes its slice of the IR (schemas, enums,
     *  services, …). The CLI registers the schema domain from `@keyma/schema/frontend-ts`;
     *  when omitted, no domains run and the IR carries only the (empty) document envelope. */
    domains?: readonly FrontendDomain[];
    /** Compiler version string embedded in the IR document. */
    compilerVersion?: string;
    /** IR schema version string. Defaults to "7.0.0". */
    irVersion?: string;
    /** Prefix prepended to every schema/service `name` (and reference targets that
     *  resolve to them). Lets the same class names coexist across libraries by
     *  namespacing the canonical identity. Defaults to "" (no prefix). */
    schemaPrefix?: string;
    /** A fully in-memory `ts.System` (e.g. from `@typescript/vfs createSystem`,
     *  pre-loaded with the TS lib files and `@keyma/core/dsl`/validator/formatter sources).
     *  When provided, compilation runs entirely in memory and touches NO real
     *  filesystem — this is the browser-capable path. The `files` must already exist
     *  in the system's map (use {@link compileVirtual} to inject them automatically). */
    system?: ts.System;
    /** Enable binary serialization: run the `assignTags` pass (stable wire identity via
     *  the committed manifest) and emit `IRField.tag`. When false/omitted, tags are
     *  stripped and JSON-only IR is unaffected (no `irVersion` bump, no manifest). */
    binaryTags?: boolean;
    /** The previously-committed tag manifest (`keyma.tags.json`), read by the CLI. Seeds
     *  the `assignTags` pass; absent ⇒ bootstrap a fresh manifest. Used only when
     *  `binaryTags` is true. The compiler reads it as data and never touches the filesystem. */
    tagManifest?: TagManifest;
    /** Accept tag drift (the analogue of `UPDATE_SNAPSHOTS`): suppresses the KEYMA100
     *  un-hinted-rename hard error so the manifest is rewritten. Used only with `binaryTags`. */
    acceptTags?: boolean;
};

export type CompileResult = {
    ir: KeymaIR;
    diagnostics: IRDiagnostic[];
    /** The updated tag manifest, present only when `binaryTags` is enabled. The CLI writes
     *  it back to `keyma.tags.json` after a clean build. */
    tagManifest?: TagManifest;
};

/** Compile TypeScript source files to Keyma IR. */
export function compile(config: FrontendConfig): CompileResult {
    const options = { ...DEFAULT_COMPILER_OPTIONS, ...(config.compilerOptions ?? {}) };
    const program = createProgram(
        config.files,
        options,
        config.system !== undefined ? { system: config.system } : {}
    );

    const baseDir = config.baseDir ?? findCommonBase(config.files);

    return compileProgram(program, {
        ...config,
        ...(baseDir !== undefined ? { baseDir } : {}),
    });
}

/**
 * Compile virtual in-memory TypeScript sources to Keyma IR.
 *
 * Two modes:
 *  - With `config.system` (browser-capable): the sources are written into the system's
 *    in-memory map and compiled through a virtual host — NO real filesystem is touched.
 *    The caller's system must already contain the TS lib files and the
 *    `@keyma/core/dsl`/validator/formatter sources for module resolution to succeed.
 *  - Without `config.system` (Node): the sources are served from an in-memory overlay,
 *    while module resolution (e.g. `@keyma/core/dsl`) uses the real filesystem from `baseDir`.
 */
export function compileVirtual(
    virtualSources: Record<string, string>,
    config: Omit<FrontendConfig, "files"> & { baseDir?: string }
): CompileResult {
    const options = { ...DEFAULT_COMPILER_OPTIONS, ...(config.compilerOptions ?? {}) };
    const rootFileNames: string[] = [];

    if (config.system !== undefined) {
        // Browser path: write the user sources into the (mutable) vfs map and compile
        // fully in memory. The host reads the map lazily, so writing after createSystem
        // but before createProgram is safe.
        const baseDir = config.baseDir ?? config.system.getCurrentDirectory();
        for (const [relativeName, content] of Object.entries(virtualSources)) {
            const absPath = path.resolve(baseDir, relativeName);
            config.system.writeFile(absPath, content);
            rootFileNames.push(absPath);
        }
        const program = createProgram(rootFileNames, options, { system: config.system });
        return compileProgram(program, { ...config, baseDir, files: rootFileNames });
    }

    // Node path: in-memory overlay on top of the real filesystem.
    const baseDir = config.baseDir ?? defaultBaseDir();
    const virtualFiles = new Map<string, string>();
    for (const [relativeName, content] of Object.entries(virtualSources)) {
        const absPath = path.resolve(baseDir, relativeName);
        virtualFiles.set(absPath, content);
        rootFileNames.push(absPath);
    }
    const program = createProgram(rootFileNames, options, { virtualFiles });
    return compileProgram(program, {
        ...config,
        ...(baseDir !== undefined ? { baseDir } : {}),
        files: rootFileNames,
    });
}

/**
 * The generic frontend orchestrator. It owns only the program-neutral skeleton: build the
 * domain context, run every registered {@link FrontendDomain}, concatenate their IR
 * contributions, and fold them into the document envelope (each section is emitted only when
 * non-empty, preserving the historical IR shape). All schema-specific lowering lives in the
 * registered domains — this function references none of it by name.
 */
function compileProgram(program: ts.Program, config: FrontendConfig): CompileResult {
    const checker = program.getTypeChecker();
    const diagnostics: IRDiagnostic[] = [];

    // The DSL module specifier is a domain concern (the schema domain defaults it to
    // "@keyma/schema/dsl"); the generic orchestrator only forwards an explicit override.
    const ctx: FrontendDomainContext = {
        checker,
        diagnostics,
        schemaPrefix: config.schemaPrefix ?? "",
        binaryTags: config.binaryTags === true,
        ...(config.dslModuleName !== undefined ? { dslModuleName: config.dslModuleName } : {}),
        ...(config.tagManifest !== undefined ? { tagManifest: config.tagManifest } : {}),
        acceptTags: config.acceptTags ?? false,
    };

    // The CLI (and SSR/test callers) register the domains; with none registered the IR
    // carries only the document envelope. `@keyma/compiler` references no domain by name.
    const registry = new FrontendExtensionRegistry();
    for (const domain of config.domains ?? []) registry.register(domain);

    const contributions = registry.domains().map((d) => d.produce(program, ctx));

    const schemas = contributions.flatMap((c) => c.schemas);
    const enums = contributions.flatMap((c) => c.enums);
    const functionDeclarations = contributions.flatMap((c) => c.functionDeclarations);
    const services = contributions.flatMap((c) => c.services);
    const tagManifest: TagManifest | undefined = contributions.find((c) => c.tagManifest !== undefined)?.tagManifest;

    // Shallow-merge each domain's document-level extension slice (every domain writes under
    // its own id, e.g. `{ ui: … }`). Stays empty for a schema-only build, so `ir.extensions`
    // is then omitted and the envelope is byte-identical to before this seam existed.
    const extensions: Record<string, unknown> = {};
    for (const c of contributions) {
        if (c.extensions !== undefined) Object.assign(extensions, c.extensions);
    }

    const ir: KeymaIR = {
        irVersion: config.irVersion ?? (config.binaryTags === true ? "9.1.0" : "9.0.0"),
        compilerVersion: config.compilerVersion ?? "0.1.0",
        ...(config.baseDir !== undefined ? { sourceRoot: config.baseDir } : {}),
        classes: schemas,
        diagnostics,
    };

    if (enums.length > 0) ir.enums = enums;
    if (functionDeclarations.length > 0) ir.functionDeclarations = functionDeclarations;
    if (services.length > 0) ir.services = services;
    if (Object.keys(extensions).length > 0) ir.extensions = extensions;

    return { ir, diagnostics, ...(tagManifest !== undefined ? { tagManifest } : {}) };
}

/**
 * Default base directory for virtual files when none is given and no `system` is used.
 * Uses the Node cwd (so NodeNext module resolution can find `@keyma/core/dsl` in node_modules)
 * without a static `node:*` import; falls back to a virtual root with no process (browser),
 * where callers should pass an explicit `system` instead.
 */
function defaultBaseDir(): string {
    return globalThis.process?.cwd?.() ?? "/";
}

function findCommonBase(files: readonly string[]): string | undefined {
    if (files.length === 0) return undefined;
    const first = files[0];
    if (first === undefined) return undefined;
    if (files.length === 1) return path.dirname(first);

    const dirs = files.map((f) => path.dirname(path.resolve(f)).split(path.sep));
    let common: string[] = dirs[0]!;

    for (let i = 1; i < dirs.length; i++) {
        let j = 0;
        const dir = dirs[i]!;
        while (j < common.length && j < dir.length && common[j] === dir[j]) {
            j++;
        }
        common = common.slice(0, j);
        if (common.length === 0) break;
    }

    if (common.length === 0) {
        return path.isAbsolute(first) ? path.sep : ".";
    }

    return common.join(path.sep);
}
