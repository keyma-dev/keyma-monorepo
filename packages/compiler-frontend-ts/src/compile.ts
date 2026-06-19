import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { KeymaIR, IRDiagnostic, IRSchema } from "@keyma/ir";
import { collectFieldRefs } from "@keyma/ir";
import { createProgram, DEFAULT_COMPILER_OPTIONS, type VirtualFiles } from "./program.js";
import { discoverSchemas } from "./discover.js";
import { discoverEnums } from "./discover-enums.js";
import { discoverValidators, discoverFormatters } from "./discover-validators.js";
import { lowerValidatorDeclaration, lowerFormatterDeclaration, type LowerDeps } from "./lower-validator.js";
import { createFunctionCollector } from "./lower-function.js";
import { extractSchema } from "./extract-schema.js";
import { flattenAll } from "./flatten.js";
import {
    mkError,
    mkWarning,
    KEYMA001,
    KEYMA018,
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
    /** IR schema version string. Defaults to "2.0.0". */
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

    // Pass 1c: discover TS enum declarations referenced by schema fields
    const enums = discoverEnums(program);

    const schemaClassNames = new Set(discovered.map((d) => d.className));

    // Utility-function collector: resolves project-local functions referenced from
    // validator/formatter bodies AND method/setter behavior bodies, compiling them
    // (transitively) when drained. Created up front so method bodies (lowered during
    // extraction) and validator/formatter bodies (lowered later) share one queue.
    const functionCollector = createFunctionCollector({ checker, dslModuleName, schemaClassNames, diagnostics });

    const extractCtx = {
        checker,
        dslModuleName,
        schemaClassNames,
        enums,
        diagnostics,
        discoveredValidators,
        discoveredFormatters,
        classifyFunction: functionCollector.classify,
    };

    // Pass 2: extract fields and method/setter behaviors for each schema (own only)
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

    // Post-processing: populate computed-field dependencies and reject cycles.
    analyzeComputedFields(schemas, diagnostics);

    const lowerDeps: LowerDeps = {
        checker,
        dslModuleName,
        schemaClassNames,
        classifyFunction: functionCollector.classify,
    };

    // Pass 4: lower Validator() declarations to IR
    const validatorDeclarations = discoveredValidatorDecls.map((d) =>
        lowerValidatorDeclaration(d, diagnostics, lowerDeps)
    );

    // Pass 5: lower Formatter() declarations to IR
    const formatterDeclarations = discoveredFormatterDecls.map((d) =>
        lowerFormatterDeclaration(d, diagnostics, lowerDeps)
    );

    // Pass 6: lower the utility functions referenced (transitively) from the bodies above.
    const functionDeclarations = functionCollector.drain();

    const ir: KeymaIR = {
        irVersion: config.irVersion ?? "2.0.0",
        compilerVersion: config.compilerVersion ?? "0.1.0",
        ...(config.baseDir !== undefined ? { sourceRoot: config.baseDir } : {}),
        schemas,
        diagnostics,
    };

    // Collect named enums actually referenced by schema fields.
    const usedEnums = collectUsedEnums(schemas, enums);
    if (usedEnums.length > 0) ir.enums = usedEnums;

    if (validatorDeclarations.length > 0) ir.validatorDeclarations = validatorDeclarations;
    if (formatterDeclarations.length > 0) ir.formatterDeclarations = formatterDeclarations;
    if (functionDeclarations.length > 0) ir.functionDeclarations = functionDeclarations;

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
            const idField = target.fields.find((f) => f.type.kind === "id");
            if (idField === undefined) {
                diagnostics.push(
                    mkError(
                        KEYMA070,
                        `Field "${field.name}" on schema "${schema.sourceName}" is Reference<${inner.schema}>, but "${inner.schema}" has no field of type ID — Reference<T> requires T to declare an "id: ID" field`,
                        field.source,
                    ),
                );
            } else {
                // Record the resolved id type so backends can type the stored id.
                inner.idType = idField.type;
            }
        }
    }
}

function unwrap(type: import("@keyma/ir").IRType): import("@keyma/ir").IRType {
    if (type.kind === "array") return unwrap(type.of);
    return type;
}

/** Collect the IREnumDeclarations for every named enum referenced by a field type. */
function collectUsedEnums(
    schemas: IRSchema[],
    enums: ReadonlyMap<string, import("./discover-enums.js").EnumInfo>,
): import("@keyma/ir").IREnumDeclaration[] {
    const used = new Set<string>();
    const visit = (t: import("@keyma/ir").IRType): void => {
        if (t.kind === "array") visit(t.of);
        else if (t.kind === "enum" && t.name !== undefined) used.add(t.name);
    };
    for (const schema of schemas) {
        for (const field of schema.fields) visit(field.type);
    }
    const result: import("@keyma/ir").IREnumDeclaration[] = [];
    for (const name of used) {
        const info = enums.get(name);
        if (info?.members != null) result.push({ name: info.name, members: info.members, source: info.source });
    }
    return result;
}

/**
 * Populate each computed field's `dependsOn` (the in-schema fields it reads) and
 * reject computed→computed dependency cycles (KEYMA018, incl. self-reference).
 */
function analyzeComputedFields(schemas: IRSchema[], diagnostics: IRDiagnostic[]): void {
    for (const schema of schemas) {
        const fieldNames = new Set(schema.fields.map((f) => f.name));
        const computedNames = new Set(
            schema.fields.filter((f) => f.computed !== undefined).map((f) => f.name),
        );

        // dependsOn = in-schema fields referenced by the computed expression.
        for (const field of schema.fields) {
            if (field.computed === undefined) continue;
            const deps = collectFieldRefs(field.computed.expression).filter((n) => fieldNames.has(n));
            if (deps.length > 0) field.computed.dependsOn = deps;
        }

        detectComputedCycle(schema, computedNames, diagnostics);
    }
}

/**
 * Detect a cycle in the computed→computed dependency subgraph via a 3-colour DFS.
 * Emits a single KEYMA018 per schema naming a cycle path (self-reference included).
 */
function detectComputedCycle(
    schema: IRSchema,
    computedNames: ReadonlySet<string>,
    diagnostics: IRDiagnostic[],
): void {
    const depsOf = new Map<string, string[]>();
    for (const field of schema.fields) {
        if (field.computed === undefined) continue;
        const deps = (field.computed.dependsOn ?? []).filter((n) => computedNames.has(n));
        depsOf.set(field.name, deps);
    }

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];

    const visit = (name: string): string[] | null => {
        color.set(name, GRAY);
        stack.push(name);
        for (const dep of depsOf.get(name) ?? []) {
            const c = color.get(dep) ?? WHITE;
            if (c === GRAY) {
                // Back-edge → cycle. Slice the path from `dep` to the current node.
                const start = stack.indexOf(dep);
                return [...stack.slice(start), dep];
            }
            if (c === WHITE) {
                const cycle = visit(dep);
                if (cycle !== null) return cycle;
            }
        }
        stack.pop();
        color.set(name, BLACK);
        return null;
    };

    for (const name of depsOf.keys()) {
        if ((color.get(name) ?? WHITE) !== WHITE) continue;
        const cycle = visit(name);
        if (cycle !== null) {
            const path = cycle.join(" → ");
            diagnostics.push(
                mkError(
                    KEYMA018,
                    `Computed fields in "${schema.sourceName}" form a dependency cycle: ${path}`,
                    schema.source,
                ),
            );
            return; // one diagnostic per schema is enough
        }
    }
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
