import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { KeymaIR, IRDiagnostic } from "@keyma/ir";
import { createProgram, DEFAULT_COMPILER_OPTIONS, type VirtualFiles } from "./program.js";
import { discoverSchemas } from "./discover.js";
import { discoverValidators, discoverFormatters } from "./discover-validators.js";
import { lowerValidatorDeclaration, lowerFormatterDeclaration } from "./lower-validator.js";
import { extractSchema } from "./extract-schema.js";
import { flattenAll } from "./flatten.js";
import {
    mkError,
    mkWarning,
    KEYMA001,
    KEYMA031,
    KEYMA035,
    KEYMA036,
    KEYMA060,
    KEYMA064,
    KEYMA070,
} from "./diagnostics.js";

export type FrontendConfig = {
    /** Absolute paths to user schema TypeScript source files. */
    files: readonly string[];
    /** Base directory for source files. Used to calculate relative paths in the IR. */
    baseDir?: string;
    /** TypeScript compiler options (defaults to strict + experimentalDecorators). */
    compilerOptions?: ts.CompilerOptions;
    /** Module name of the Keyma DSL. Defaults to "@keyma/dsl". */
    dslModuleName?: string;
    /** Compiler version string embedded in the IR document. */
    compilerVersion?: string;
    /** IR schema version string. Defaults to "1.0.0". */
    irVersion?: string;
};

export type CompileResult = {
    ir: KeymaIR;
    diagnostics: IRDiagnostic[];
};

/** Compile TypeScript source files to Keyma IR. */
export function compile(config: FrontendConfig): CompileResult {
    const options = { ...DEFAULT_COMPILER_OPTIONS, ...(config.compilerOptions ?? {}) };
    const program = createProgram(config.files, options);

    const baseDir = config.baseDir ?? findCommonBase(config.files);

    return compileProgram(program, {
        ...config,
        ...(baseDir !== undefined ? { baseDir } : {}),
    });
}

/**
 * Compile virtual in-memory TypeScript sources to Keyma IR.
 * Virtual files are served from memory; module resolution (e.g. @keyma/dsl)
 * uses the real file system starting from `baseDir`.
 */
export function compileVirtual(
    virtualSources: Record<string, string>,
    config: Omit<FrontendConfig, "files"> & { baseDir?: string }
): CompileResult {
    const baseDir = config.baseDir ?? defaultBaseDir();
    const virtualFiles = new Map<string, string>();
    const rootFileNames: string[] = [];

    for (const [relativeName, content] of Object.entries(virtualSources)) {
        const absPath = path.resolve(baseDir, relativeName);
        virtualFiles.set(absPath, content);
        rootFileNames.push(absPath);
    }

    const options = { ...DEFAULT_COMPILER_OPTIONS, ...(config.compilerOptions ?? {}) };
    const program = createProgram(rootFileNames, options, virtualFiles as VirtualFiles);
    return compileProgram(program, {
        ...config,
        ...(baseDir !== undefined ? { baseDir } : {}),
        files: rootFileNames,
    });
}

function compileProgram(program: ts.Program, config: FrontendConfig): CompileResult {
    const checker = program.getTypeChecker();
    const dslModuleName = config.dslModuleName ?? "@keyma/dsl";
    const diagnostics: IRDiagnostic[] = [];

    const discoverCtx = { checker, dslModuleName, diagnostics };

    // Pass 1: discover all @Schema classes
    const discovered = discoverSchemas(program, discoverCtx);

    // Pass 1b: discover Validator(name, fn) / Formatter(name, fn) factory declarations
    const discoveredValidatorDecls = discoverValidators(program, discoverCtx);
    const discoveredFormatterDecls = discoverFormatters(program, discoverCtx);

    // Build lookup maps: function name → validator/formatter name
    const discoveredValidators = new Map(
        discoveredValidatorDecls.map((d) => [d.funcName, d.validatorName])
    );
    const discoveredFormatters = new Map(
        discoveredFormatterDecls.map((d) => [d.funcName, d.formatterName])
    );

    const schemaClassNames = new Set(discovered.map((d) => d.className));
    const extractCtx = {
        checker,
        dslModuleName,
        schemaClassNames,
        diagnostics,
        discoveredValidators,
        discoveredFormatters,
    };

    // Pass 2: extract fields for each schema (own fields only)
    const rawSchemas = discovered.map((d) => extractSchema(d, extractCtx));

    const schemasBySourceName = new Map(rawSchemas.map((s) => [s.sourceName, s]));

    // Pass 3: flatten inheritance
    const flattenCtx = { schemas: schemasBySourceName, diagnostics };
    const schemas = flattenAll(rawSchemas, flattenCtx);

    // Post-processing: duplicate name check
    checkDuplicateNames(schemas, diagnostics);

    // Post-processing: public schema leaks private schema
    checkVisibilityLeaks(schemas, diagnostics);

    // Post-processing: persisted schemas must not reference ephemeral schemas;
    // indexes on ephemeral schemas have no effect.
    checkEphemeralUsage(schemas, diagnostics);

    // Post-processing: edge schema structural checks (from/to fields/indexes/refs)
    checkEdgeSchemas(schemas, diagnostics);

    // Post-processing: every Reference<T> target schema must declare an ID field
    checkReferenceTargetsHaveId(schemas, diagnostics);

    // Pass 4: lower Validator() declarations to IR
    const validatorDeclarations = discoveredValidatorDecls.map((d) =>
        lowerValidatorDeclaration(d, diagnostics)
    );

    // Pass 5: lower Formatter() declarations to IR
    const formatterDeclarations = discoveredFormatterDecls.map((d) =>
        lowerFormatterDeclaration(d, diagnostics)
    );

    const ir: KeymaIR = {
        irVersion: config.irVersion ?? "1.0.0",
        compilerVersion: config.compilerVersion ?? "0.1.0",
        ...(config.baseDir !== undefined ? { sourceRoot: config.baseDir } : {}),
        schemas,
        diagnostics,
    };

    if (validatorDeclarations.length > 0) ir.validatorDeclarations = validatorDeclarations;
    if (formatterDeclarations.length > 0) ir.formatterDeclarations = formatterDeclarations;

    return { ir, diagnostics };
}

function checkDuplicateNames(schemas: import("@keyma/ir").IRSchema[], diagnostics: IRDiagnostic[]): void {
    const seen = new Map<string, string>(); // name → sourceName
    for (const schema of schemas) {
        const existing = seen.get(schema.name);
        if (existing !== undefined) {
            diagnostics.push(
                mkError(KEYMA001, `Duplicate schema name "${schema.name}" (used by both "${existing}" and "${schema.sourceName}")`, schema.source)
            );
        } else {
            seen.set(schema.name, schema.sourceName);
        }
    }
}

function checkVisibilityLeaks(schemas: import("@keyma/ir").IRSchema[], diagnostics: IRDiagnostic[]): void {
    const privateSchemas = new Set(schemas.filter((s) => s.visibility === "private").map((s) => s.sourceName));

    for (const schema of schemas) {
        if (schema.visibility !== "public") continue;
        for (const field of schema.fields) {
            if (field.visibility === "private") continue;
            const t = field.type;
            if ((t.kind === "reference" || t.kind === "embedded") && privateSchemas.has(t.schema)) {
                diagnostics.push(
                    mkError(
                        KEYMA031,
                        `Public schema "${schema.sourceName}" exposes private schema "${t.schema}" via field "${field.name}"`,
                        field.source
                    )
                );
            }
        }
    }
}

function checkEphemeralUsage(schemas: import("@keyma/ir").IRSchema[], diagnostics: IRDiagnostic[]): void {
    const ephemeralSchemas = new Set(schemas.filter((s) => s.ephemeral === true).map((s) => s.sourceName));

    for (const schema of schemas) {
        // KEYMA035: a persisted (non-ephemeral) schema cannot hold a Reference<T>
        // to an ephemeral schema — a foreign key to data that is never stored.
        // Embedded<T> of an ephemeral schema is fine (the data is inlined).
        if (schema.ephemeral !== true) {
            for (const field of schema.fields) {
                const inner = unwrap(field.type);
                if (inner.kind === "reference" && ephemeralSchemas.has(inner.schema)) {
                    diagnostics.push(
                        mkError(
                            KEYMA035,
                            `Persisted schema "${schema.sourceName}" references ephemeral schema "${inner.schema}" via field "${field.name}" — ephemeral schemas are never stored and cannot be a reference target`,
                            field.source,
                        ),
                    );
                }
            }
            continue;
        }

        // KEYMA036: indexes on an ephemeral schema have no effect (nothing is persisted).
        const hasFieldIndex = schema.fields.some((f) => f.indexes.length > 0);
        if (schema.indexes.length > 0 || hasFieldIndex) {
            diagnostics.push(
                mkWarning(
                    KEYMA036,
                    `Ephemeral schema "${schema.sourceName}" declares indexes, which have no effect — ephemeral schemas are never persisted`,
                    schema.source,
                ),
            );
        }
    }
}

function checkEdgeSchemas(schemas: import("@keyma/ir").IRSchema[], diagnostics: IRDiagnostic[]): void {
    const bySourceName = new Map(schemas.map((s) => [s.sourceName, s]));
    const edgeSourceNames = new Set(schemas.filter((s) => s.edge !== undefined).map((s) => s.sourceName));

    // Edge schemas must not be used as referenced node types by other schemas.
    for (const schema of schemas) {
        if (schema.edge !== undefined) continue;  // checked separately below
        for (const field of schema.fields) {
            const inner = unwrap(field.type);
            if ((inner.kind === "reference" || inner.kind === "embedded") && edgeSourceNames.has(inner.schema)) {
                diagnostics.push(
                    mkError(
                        KEYMA064,
                        `Schema "${schema.sourceName}" references edge schema "${inner.schema}" via field "${field.name}" — edges are not addressable as nodes`,
                        field.source,
                    ),
                );
            }
        }
    }

    // Per-edge structural checks. The endpoint fields, their names, and target
    // schemas are derived from @From()/@To() in extract-schema (which also emits
    // KEYMA061/065/066). Here we only verify the targets are node schemas — not
    // edges — since that needs the full schema set.
    for (const schema of schemas) {
        const edge = schema.edge;
        if (edge === undefined) continue;

        for (const [role, target] of [["from", edge.from], ["to", edge.to]] as const) {
            const resolved = bySourceName.get(target);
            if (resolved !== undefined && resolved.edge !== undefined) {
                diagnostics.push(
                    mkError(
                        KEYMA060,
                        `@Edge "${role}" on "${schema.sourceName}" points at edge schema "${target}" — must be a node schema`,
                        schema.source,
                    ),
                );
            }
        }
    }
}

function checkReferenceTargetsHaveId(schemas: import("@keyma/ir").IRSchema[], diagnostics: IRDiagnostic[]): void {
    const bySourceName = new Map(schemas.map((s) => [s.sourceName, s]));

    for (const schema of schemas) {
        for (const field of schema.fields) {
            const inner = unwrap(field.type);
            if (inner.kind !== "reference") continue;
            const target = bySourceName.get(inner.schema);
            if (target === undefined) continue;
            const hasId = target.fields.some((f) => f.type.kind === "id");
            if (!hasId) {
                diagnostics.push(
                    mkError(
                        KEYMA070,
                        `Field "${field.name}" on schema "${schema.sourceName}" is Reference<${inner.schema}>, but "${inner.schema}" has no field of type ID — Reference<T> requires T to declare an "id: ID" field`,
                        field.source,
                    ),
                );
            }
        }
    }
}

function unwrap(type: import("@keyma/ir").IRType): import("@keyma/ir").IRType {
    if (type.kind === "nullable" || type.kind === "array") return unwrap(type.of);
    return type;
}

/** Get a stable base directory for virtual files (within the compiler-frontend-ts package src). */
function defaultBaseDir(): string {
    const thisFile = fileURLToPath(import.meta.url);
    return path.dirname(thisFile);
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
