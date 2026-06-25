import { path } from "@keyma/compiler-util";
import ts from "typescript";
import type { KeymaIR, IRDiagnostic, IRSchema } from "@keyma/ir";
import { createProgram, DEFAULT_COMPILER_OPTIONS } from "./program.js";
import { discoverSchemas } from "./discover.js";
import { discoverEnums } from "./discover-enums.js";
import { createValidatorFormatterCollector } from "./discover-validators.js";
import { lowerValidatorDeclaration, lowerFormatterDeclaration, type LowerDeps } from "./lower-validator.js";
import { createFunctionCollector } from "./lower-function.js";
import { extractSchema } from "./extract-schema.js";
import { discoverServices } from "./discover-services.js";
import { extractService } from "./extract-service.js";
import { flattenAll } from "./flatten.js";
import type { IRService, IRType } from "@keyma/ir";
import {
    mkError,
    mkWarning,
    KEYMA001,
    KEYMA031,
    KEYMA035,
    KEYMA036,
    KEYMA037,
    KEYMA060,
    KEYMA064,
    KEYMA070,
    KEYMA072,
    KEYMA096,
    KEYMA097,
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
    /** IR schema version string. Defaults to "4.0.0". */
    irVersion?: string;
    /** Prefix prepended to every schema/service `name` (and reference targets that
     *  resolve to them). Lets the same class names coexist across libraries by
     *  namespacing the canonical identity. Defaults to "" (no prefix). */
    schemaPrefix?: string;
    /** A fully in-memory `ts.System` (e.g. from `@typescript/vfs createSystem`,
     *  pre-loaded with the TS lib files and `@keyma/dsl`/validator/formatter sources).
     *  When provided, compilation runs entirely in memory and touches NO real
     *  filesystem — this is the browser-capable path. The `files` must already exist
     *  in the system's map (use {@link compileVirtual} to inject them automatically). */
    system?: ts.System;
};

export type CompileResult = {
    ir: KeymaIR;
    diagnostics: IRDiagnostic[];
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
 *    `@keyma/dsl`/validator/formatter sources for module resolution to succeed.
 *  - Without `config.system` (Node): the sources are served from an in-memory overlay,
 *    while module resolution (e.g. `@keyma/dsl`) uses the real filesystem from `baseDir`.
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

function compileProgram(program: ts.Program, config: FrontendConfig): CompileResult {
    const checker = program.getTypeChecker();
    const dslModuleName = config.dslModuleName ?? "@keyma/dsl";
    const diagnostics: IRDiagnostic[] = [];

    const discoverCtx = { checker, dslModuleName, diagnostics };

    // Pass 1: discover all @Schema classes
    const discovered = discoverSchemas(program, discoverCtx);

    // Pass 1b: discover TS enum declarations referenced by schema fields
    const enums = discoverEnums(program);

    // Pass 1c: discover @Service classes (remote-call contracts)
    const discoveredServices = discoverServices(program, discoverCtx);

    const schemaClassNames = new Set(discovered.map((d) => d.className));

    // Validator/formatter collector: resolves each `@Validate`/`@Format` factory at
    // its use site (across imports — including pure-TS library packages), enqueues
    // its declaration, and yields only the set actually referenced when drained.
    const vfCollector = createValidatorFormatterCollector({ checker, dslModuleName });

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
        resolveValidator: vfCollector.resolveValidator,
        resolveFormatter: vfCollector.resolveFormatter,
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

    // Post-processing: a public schema must expose at least one public field.
    checkPublicSchemaSurface(schemas, diagnostics);

    // Post-processing: persisted schemas must not reference ephemeral schemas;
    // indexes on ephemeral schemas have no effect.
    checkEphemeralUsage(schemas, diagnostics);

    // Post-processing: edge schema structural checks (from/to fields/indexes/refs)
    checkEdgeSchemas(schemas, diagnostics);

    // Post-processing: every Reference<T> target schema must declare an ID field
    checkReferenceTargetsHaveId(schemas, diagnostics);

    // Post-processing: reject cycles in the Embedded<T> graph (infinite inline data).
    analyzeEmbeddedCycles(schemas, diagnostics);

    const lowerDeps: LowerDeps = {
        checker,
        dslModuleName,
        schemaClassNames,
        classifyFunction: functionCollector.classify,
    };

    // Pass 4: lower the validator factories referenced by @Validate (tree-shaken).
    const validatorDeclarations = vfCollector.drainValidators().map((c) =>
        lowerValidatorDeclaration(c, diagnostics, lowerDeps)
    );

    // Pass 5: lower the formatter factories referenced by @Format (tree-shaken).
    const formatterDeclarations = vfCollector.drainFormatters().map((c) =>
        lowerFormatterDeclaration(c, diagnostics, lowerDeps)
    );

    // Pass 6: lower the utility functions referenced (transitively) from the bodies above.
    const functionDeclarations = functionCollector.drain();

    // Pass 7: extract @Service contracts (signatures only — no bodies). Runs after
    // schemas so param/return types can resolve schema class names.
    const services = discoveredServices.map((d) =>
        extractService(d, {
            checker,
            dslModuleName,
            schemaClassNames,
            ...(enums !== undefined && { enums }),
            diagnostics,
        }),
    );
    checkServiceVisibilityLeaks(schemas, services, diagnostics);
    checkServiceNameCollisions(schemas, services, diagnostics);

    // Final pass: apply the configured prefix to every schema/service `name` and
    // rewrite all cross-references (reference/embedded/edge targets, service
    // param/return schemas) from the authored class name (`sourceName`) to the
    // target's final `name`. After this, `name` is the single identity used by
    // every backend, the runtime, and DB adapters. Runs last so the post-checks
    // above (which resolve by `sourceName`) see the un-rewritten IR.
    normalizeSchemaNames(schemas, services, config.schemaPrefix ?? "");

    const ir: KeymaIR = {
        irVersion: config.irVersion ?? "5.0.0",
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
    if (services.length > 0) ir.services = services;

    return { ir, diagnostics };
}

/**
 * Apply the schema-name prefix and normalize every cross-reference to the target
 * schema's final `name`. In-place mutation of the (already flattened, validated)
 * IR arrays. Reference/embedded/edge targets are authored as class names
 * (`sourceName`); here they become the prefixed `name` so the IR — and everything
 * downstream — addresses schemas by a single canonical identity.
 */
function normalizeSchemaNames(
    schemas: IRSchema[],
    services: IRService[],
    prefix: string,
): void {
    // Authored class name (sourceName) -> final identity (prefixed name).
    const finalName = new Map<string, string>();
    for (const s of schemas) finalName.set(s.sourceName, prefix + s.name);

    const rewrite = (type: IRType): void => {
        if (type.kind === "array") {
            rewrite(type.of);
        } else if (type.kind === "reference" || type.kind === "embedded") {
            type.schema = finalName.get(type.schema) ?? type.schema;
        }
    };

    for (const s of schemas) {
        for (const f of s.fields) rewrite(f.type);
        if (s.edge !== undefined) {
            s.edge.from = finalName.get(s.edge.from) ?? s.edge.from;
            s.edge.to = finalName.get(s.edge.to) ?? s.edge.to;
        }
        s.name = prefix + s.name;
        s.id = `schema:${s.name}`;
        // The traversal label is this edge schema's own (now prefixed) name.
        if (s.edge !== undefined) s.edge.label = s.name;
    }

    for (const svc of services) {
        for (const m of svc.methods) {
            for (const p of m.params) rewrite(p.type);
            if (m.returnType !== undefined) rewrite(m.returnType);
        }
        svc.name = prefix + svc.name;
        svc.id = `service:${svc.name}`;
    }
}

/** A public service method must not expose a private schema via a param/return type. */
function checkServiceVisibilityLeaks(
    schemas: IRSchema[],
    services: IRService[],
    diagnostics: IRDiagnostic[],
): void {
    const privateSchemas = new Set(
        schemas.filter((s) => s.visibility === "private").map((s) => s.sourceName),
    );
    const leakedSchema = (t: IRType): string | undefined => {
        const inner = t.kind === "array" ? t.of : t;
        if ((inner.kind === "reference" || inner.kind === "embedded") && privateSchemas.has(inner.schema)) {
            return inner.schema;
        }
        return undefined;
    };

    for (const service of services) {
        if (service.visibility !== "public") continue;
        for (const method of service.methods) {
            if (method.visibility !== "public") continue;
            const types: IRType[] = [...method.params.map((p) => p.type)];
            if (method.returnType !== undefined) types.push(method.returnType);
            for (const t of types) {
                const leaked = leakedSchema(t);
                if (leaked !== undefined) {
                    diagnostics.push(
                        mkError(
                            KEYMA096,
                            `Public service "${service.sourceName}" method "${method.name}" exposes private schema "${leaked}"`,
                            method.source,
                        ),
                    );
                }
            }
        }
    }
}

/** Service names must be unique and must not collide with a schema name. */
function checkServiceNameCollisions(
    schemas: IRSchema[],
    services: IRService[],
    diagnostics: IRDiagnostic[],
): void {
    const schemaNames = new Set(schemas.map((s) => s.name));
    const seen = new Set<string>();
    for (const service of services) {
        if (schemaNames.has(service.name)) {
            diagnostics.push(
                mkError(
                    KEYMA097,
                    `Service name "${service.name}" collides with a schema of the same name`,
                    service.source,
                ),
            );
        }
        if (seen.has(service.name)) {
            diagnostics.push(
                mkError(
                    KEYMA097,
                    `Duplicate service name "${service.name}"`,
                    service.source,
                ),
            );
        } else {
            seen.add(service.name);
        }
    }
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

// KEYMA037: a public schema whose fields are *all* private has no public surface.
// It would emit into the client bundle with nothing readable, while on the server
// its default (unprojected) read produces an empty projection — which adapters
// treat as "return the whole record", leaking the private data the author meant
// to hide. The fix is mechanical: mark the schema private (so only the system
// identity can reach it) or make at least one field public. A field counts as
// public surface whatever its kind — stored, reference, or embedded. Getters are
// behaviors (re-emitted accessors), not stored/projected data, so they do not
// count. Fieldless schemas are exempt (nothing to leak and nothing to expose).
function checkPublicSchemaSurface(schemas: import("@keyma/ir").IRSchema[], diagnostics: IRDiagnostic[]): void {
    for (const schema of schemas) {
        if (schema.visibility !== "public") continue;
        if (schema.fields.length === 0) continue;
        if (schema.fields.some((f) => f.visibility === "public")) continue;
        diagnostics.push(
            mkError(
                KEYMA037,
                `Public schema "${schema.sourceName}" has only private fields — a public schema must expose at least one public field. Mark it @Schema({ private: true }), or make a field public.`,
                schema.source,
            ),
        );
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
 * Reject cycles in the Embedded<T> graph (KEYMA072, incl. a self-embed). `Embedded<T>`
 * is an inline copy, so a cycle of embeds describes infinitely-nested data and can
 * never be materialized. Only embedded edges are followed — `Reference<T>` stores
 * just an id, so reference cycles are legal (a foreign-key loop). Runs pre-normalization,
 * so embedded targets are still authored `sourceName`s. Uses a 3-colour DFS across
 * schemas.
 */
function analyzeEmbeddedCycles(schemas: IRSchema[], diagnostics: IRDiagnostic[]): void {
    const known = new Set(schemas.map((s) => s.sourceName));
    const sourceOf = new Map(schemas.map((s) => [s.sourceName, s.source]));

    // schema sourceName → the schemas it inlines via Embedded<T> (incl. Embedded<T>[]).
    const embedsOf = new Map<string, string[]>();
    for (const schema of schemas) {
        const targets: string[] = [];
        for (const field of schema.fields) {
            const inner = unwrap(field.type);
            if (inner.kind === "embedded" && known.has(inner.schema)) targets.push(inner.schema);
        }
        embedsOf.set(schema.sourceName, targets);
    }

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];

    const visit = (name: string): string[] | null => {
        color.set(name, GRAY);
        stack.push(name);
        for (const dep of embedsOf.get(name) ?? []) {
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

    for (const schema of schemas) {
        if ((color.get(schema.sourceName) ?? WHITE) !== WHITE) continue;
        const cycle = visit(schema.sourceName);
        if (cycle !== null) {
            const path = cycle.join(" → ");
            const at = sourceOf.get(cycle[0]!) ?? schema.source;
            diagnostics.push(
                mkError(
                    KEYMA072,
                    `Embedded<T> types form a cycle: ${path} — embedded data is inlined, so a cycle would be infinitely nested. Use Reference<T> to store a foreign key instead.`,
                    at,
                ),
            );
            return; // one diagnostic is enough; the build halts and the user fixes the cycle
        }
    }
}

/**
 * Default base directory for virtual files when none is given and no `system` is used.
 * Uses the Node cwd (so NodeNext module resolution can find `@keyma/dsl` in node_modules)
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
