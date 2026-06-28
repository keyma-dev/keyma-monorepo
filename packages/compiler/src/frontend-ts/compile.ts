import { path } from "@keyma/core/util";
import ts from "typescript";
import type {
    KeymaIR,
    IRDiagnostic,
    TagManifest,
    IRClassDeclaration,
    IRFunctionDeclaration,
} from "@keyma/core/ir";
import { createProgram, DEFAULT_COMPILER_OPTIONS } from "./program.js";
import {
    FrontendExtensionRegistry,
    type FrontendDomain,
    type DomainBaseContext,
    type DomainContext,
    type HandlerContext,
    type DomainDecorator,
} from "./extension-registry.js";
import { runServicePass, isServiceClass } from "./service-pass.js";
import { lowerClass, type LowerClassContext, type DecoratorRecognizer } from "./lower-class.js";
import { discoverEnums } from "./discover-enums.js";
import { createFunctionCollector } from "./lower-function.js";
import { checkInheritance } from "./check-inheritance.js";
import { checkDuplicateNames, checkVisibilityLeaks, checkPublicSurface } from "./base-checks.js";
import { normalizeClassNames } from "./normalize-names.js";
import { collectLocalAndUsedEnums } from "./collect-enums.js";
import { assignTags, stripTagHints } from "./assign-tags.js";
import { isFromModule, isResolvedCoreDsl } from "./util.js";

/** The canonical core DSL module — the driver resolves base field/method types and the function
 *  surface against it (core DSL types are recognized by their core identity through any umbrella,
 *  so this is byte-identical to resolving against a domain's re-export). */
const CORE_DSL_MODULE = "@keyma/core/dsl";

export type FrontendConfig = {
    /** Absolute paths to user TypeScript source files. */
    files: readonly string[];
    /** Base directory for source files. Used to calculate relative paths in the IR. */
    baseDir?: string;
    /** TypeScript compiler options (defaults to strict + experimentalDecorators). */
    compilerOptions?: ts.CompilerOptions;
    /** Module specifier the authoring decorators are imported from. A frontend domain
     *  applies its own default (e.g. its DSL re-export) when this is absent; override
     *  only to point the discovery at a different DSL module. */
    dslModuleName?: string;
    /** Frontend domains to run. Each contributes its slice of the IR (classes, enums,
     *  services, …). The CLI registers the domain frontends it wants; when omitted, no
     *  domains run and the IR carries only the (empty) document envelope. */
    domains?: readonly FrontendDomain[];
    /** Compiler version string embedded in the IR document. */
    compilerVersion?: string;
    /** IR version string. Defaults to "7.0.0". */
    irVersion?: string;
    /** Prefix prepended to every class/service `name` (and reference targets that
     *  resolve to them). Lets the same class names coexist across libraries by
     *  namespacing the canonical identity. Defaults to "" (no prefix). */
    namePrefix?: string;
    /** A fully in-memory `ts.System` (e.g. from `@typescript/vfs createSystem`,
     *  pre-loaded with the TS lib files and `@keyma/core/dsl`/validator/formatter sources).
     *  When provided, compilation runs entirely in memory and touches NO real
     *  filesystem — this is the browser-capable path. The `files` must already exist
     *  in the system's map (use {@link compileVirtual} to inject them automatically). */
    system?: ts.System;
    /** Enable binary serialization: run the `assignTags` pass (stable wire identity via
     *  the committed manifest) and emit `IRMember.tag`. When false/omitted, tags are
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
 * The compiler-owned frontend driver. It owns DSL discovery, the base-IR build for every data
 * class, decorator dispatch to the registered domains, base validation, name normalization,
 * binary tags, the function surface, enum collection, and the `@Service` base pass — then folds
 * everything into the document envelope. A registered {@link FrontendDomain} contributes only its
 * decorators + per-class/program hooks; this function references no domain by name.
 */
function compileProgram(program: ts.Program, config: FrontendConfig): CompileResult {
    const checker = program.getTypeChecker();
    const diagnostics: IRDiagnostic[] = [];
    const namePrefix = config.namePrefix ?? "";
    const binaryTags = config.binaryTags === true;

    const registry = new FrontendExtensionRegistry();
    for (const domain of config.domains ?? []) registry.register(domain);
    const domains = registry.domains();

    // Enums discovered once — shared by base field lowering, the function collector, and services.
    const enums = discoverEnums(program);

    const baseCtx: DomainBaseContext = {
        checker,
        diagnostics,
        namePrefix,
        binaryTags,
        ...(config.dslModuleName !== undefined ? { dslModuleName: config.dslModuleName } : {}),
        ...(config.tagManifest !== undefined ? { tagManifest: config.tagManifest } : {}),
        acceptTags: config.acceptTags ?? false,
    };

    // ── DSL discovery (point 1+2): collect every non-declaration class. A `@Service` class is a
    // contract handled by the base service pass — NOT a data class — so it is excluded from base
    // lowering. The full set of data-class names is needed BEFORE lowering any (so Reference<T>/
    // Embedded<T>/bare-class field types resolve), so collect names in a first pass.
    const classNodes: Array<{ node: ts.ClassDeclaration; sourceFile: ts.SourceFile }> = [];
    const classNames = new Set<string>();
    // Classes bearing a registered domain class-decorator — the data-model set used to flag a
    // `@Service` that is also a data model (KEYMA095). Includes `@Service`+`@Schema` classes
    // (excluded from data lowering but still data-model-decorated).
    const dataModelDecoratedNames = new Set<string>();
    const classDecorators = domains.flatMap((d) => d.decorators.filter((dec) => dec.target === "class"));
    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        ts.forEachChild(sourceFile, (node) => {
            if (!ts.isClassDeclaration(node) || node.name === undefined) return;
            if (matchDecorator(node, classDecorators, checker) !== undefined) {
                dataModelDecoratedNames.add(node.name.text);
            }
            if (isServiceClass(node, checker)) return; // a @Service contract — not a data class
            classNodes.push({ node, sourceFile });
            classNames.add(node.name.text);
        });
    }

    // ── Shared (compiler-owned) function collector. `classify` is threaded into base lowering,
    // the decorator handlers, and the domain check pass, so all enqueue into one queue.
    const functionCollector = createFunctionCollector({
        checker,
        dslModuleName: config.dslModuleName ?? CORE_DSL_MODULE,
        classNames,
        diagnostics,
    });

    // Recognizer for the base getter field-only-decorator deferral (KEYMA098).
    const allDecorators = domains.flatMap((d) => d.decorators);
    const recognize: DecoratorRecognizer = (deco) => recognizeDecorator(deco, allDecorators, checker);

    // ── BASE LOWER every data class (point 3).
    const lowered: Array<{ result: NonNullable<ReturnType<typeof lowerClass>>; sourceFile: ts.SourceFile }> = [];
    for (const { node, sourceFile } of classNodes) {
        const lowerCtx: LowerClassContext = {
            checker,
            diagnostics,
            sourceFile,
            dslModuleName: config.dslModuleName ?? CORE_DSL_MODULE,
            classNames,
            enums,
            classify: functionCollector.classify,
            recognize,
        };
        const result = lowerClass(node, lowerCtx);
        if (result !== null) lowered.push({ result, sourceFile });
    }
    const classes: IRClassDeclaration[] = lowered.map((l) => l.result.ir);

    // Per-compile domain state (e.g. a validator/formatter collector), threaded into every hook.
    const domainState = new Map<FrontendDomain, unknown>();
    for (const domain of domains) domainState.set(domain, domain.init?.(baseCtx));

    const handlerCtxFor = (domain: FrontendDomain, cls: IRClassDeclaration, sourceFile: ts.SourceFile): HandlerContext => ({
        checker,
        diagnostics,
        sourceFile,
        dslModuleName: config.dslModuleName ?? domain.dslModule,
        classNames,
        enums,
        classify: functionCollector.classify,
        class: cls,
        state: domainState.get(domain),
    });

    const domainCtxFor = (domain: FrontendDomain): DomainContext => ({
        ...baseCtx,
        classNames,
        enums,
        classify: functionCollector.classify,
        state: domainState.get(domain),
    });

    // ── DISPATCH class + member decorators to the owning domain's handlers (point 3+4).
    for (const { result, sourceFile } of lowered) {
        for (const deco of ts.getDecorators(result.classNode) ?? []) {
            for (const domain of domains) {
                const d = matchDecorator(result.classNode, domain.decorators.filter((x) => x.target === "class"), checker, deco);
                if (d !== undefined) d.handle(deco, result.ir, handlerCtxFor(domain, result.ir, sourceFile));
            }
        }
        for (const { member, node } of result.fieldNodes) {
            for (const deco of ts.getDecorators(node) ?? []) {
                for (const domain of domains) {
                    const d = matchDecorator(node, domain.decorators.filter((x) => x.target === "member"), checker, deco);
                    if (d !== undefined) d.handle(deco, member, handlerCtxFor(domain, result.ir, sourceFile));
                }
            }
        }
    }

    // ── finalizeClass per domain (point 5): composite-index hoisting, edge derivation, …
    for (const domain of domains) {
        if (domain.finalizeClass === undefined) continue;
        const ctx = domainCtxFor(domain);
        for (const cls of classes) domain.finalizeClass(cls, ctx);
    }

    // ── BASE VALIDATION (point 6): inheritance, duplicate name, visibility leak, public surface.
    const bySourceName = new Map(classes.map((s) => [s.sourceName, s]));
    checkInheritance(classes, { classes: bySourceName, diagnostics });
    checkDuplicateNames(classes, diagnostics);
    checkVisibilityLeaks(classes, diagnostics);
    checkPublicSurface(classes, diagnostics);

    // ── DOMAIN CHECK pass (point 7): extra checks (by sourceName) + lower domain factory fns.
    const domainFunctionDeclarations: IRFunctionDeclaration[] = [];
    for (const domain of domains) {
        if (domain.check === undefined) continue;
        const out = domain.check(classes, domainCtxFor(domain));
        if (out.functionDeclarations !== undefined) domainFunctionDeclarations.push(...out.functionDeclarations);
    }

    // ── NORMALIZE names (point 8): prefix class names + rewrite reference/embedded targets, then
    // let each domain rewrite its own extension cross-refs against the same name map.
    const nameMap = normalizeClassNames(classes, namePrefix);
    for (const domain of domains) {
        domain.afterNormalize?.(classes, nameMap, domainCtxFor(domain));
    }

    // ── BINARY TAGS (point 9): assign stable wire tags, or strip the transient hints.
    let tagManifest: TagManifest | undefined;
    if (binaryTags) {
        const result = assignTags(config.tagManifest, classes, { acceptTags: config.acceptTags ?? false });
        diagnostics.push(...result.diagnostics);
        tagManifest = result.manifest;
    } else {
        stripTagHints(classes);
    }

    // ── FUNCTION SURFACE (point 10): the complete local utility-function surface (referenced or
    // not), excluding each domain's factory functions (lowered above, only where referenced).
    functionCollector.enqueueLocalSurface(program, (returnType) =>
        domains.some((d) => d.excludeFromFunctionSurface?.(returnType, domainCtxFor(d)) ?? false),
    );
    const functionDeclarations = [...domainFunctionDeclarations, ...functionCollector.drain()];

    // ── ENUMS (point 11): complete local + referenced enum surface.
    const localEnums = collectLocalAndUsedEnums(classes, enums);

    // ── SERVICE pass (point 12 — compiler base pass, runs after the class surface is final).
    const services = runServicePass(program, baseCtx, classes, dataModelDecoratedNames);

    // ── Document-level domain extensions (e.g. the UI view catalog), keyed by domain name.
    const extensions: Record<string, unknown> = {};
    for (const domain of domains) {
        const slice = domain.documentExtension?.(program, domainCtxFor(domain));
        if (slice !== undefined) extensions[domain.name] = slice;
    }

    const ir: KeymaIR = {
        irVersion: config.irVersion ?? (binaryTags ? "12.1.0" : "12.0.0"),
        compilerVersion: config.compilerVersion ?? "0.1.0",
        ...(config.baseDir !== undefined ? { sourceRoot: config.baseDir } : {}),
        classes,
        diagnostics,
    };

    if (localEnums.length > 0) ir.enums = localEnums;
    if (functionDeclarations.length > 0) ir.functionDeclarations = functionDeclarations;
    if (services.length > 0) ir.services = services;
    if (Object.keys(extensions).length > 0) ir.extensions = extensions;

    return { ir, diagnostics, ...(tagManifest !== undefined ? { tagManifest } : {}) };
}

/**
 * Find the registered domain decorator (within `decorators`) that a decorator node matches —
 * by identifier name AND resolution module (`isFromModule`). When `only` is given, only that
 * decorator node is considered; otherwise the class/member's decorators are scanned.
 */
function matchDecorator(
    node: ts.HasDecorators,
    decorators: readonly DomainDecorator[],
    checker: ts.TypeChecker,
    only?: ts.Decorator,
): DomainDecorator | undefined {
    if (decorators.length === 0) return undefined;
    const candidates = only !== undefined ? [only] : (ts.getDecorators(node) ?? []);
    for (const deco of candidates) {
        const ident = decoratorIdentifier(deco);
        if (ident === undefined) continue;
        const symbol = checker.getSymbolAtLocation(ident);
        if (symbol === undefined) continue;
        for (const d of decorators) {
            if (d.name === ident.text && isFromModule(symbol, checker, d.module)) return d;
        }
    }
    return undefined;
}

/** Recognize a decorator as a registered domain decorator OR a core DSL decorator → its name. */
function recognizeDecorator(
    deco: ts.Decorator,
    decorators: readonly DomainDecorator[],
    checker: ts.TypeChecker,
): string | undefined {
    const ident = decoratorIdentifier(deco);
    if (ident === undefined) return undefined;
    const symbol = checker.getSymbolAtLocation(ident);
    if (symbol === undefined) return undefined;
    for (const d of decorators) {
        if (d.name === ident.text && isFromModule(symbol, checker, d.module)) return ident.text;
    }
    if (isResolvedCoreDsl(symbol, checker)) return ident.text;
    return undefined;
}

/** The identifier being applied as a decorator (`@Name` or `@Name(...)`). */
function decoratorIdentifier(deco: ts.Decorator): ts.Identifier | undefined {
    const expr = deco.expression;
    const ident = ts.isCallExpression(expr) ? expr.expression : expr;
    return ts.isIdentifier(ident) ? ident : undefined;
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
