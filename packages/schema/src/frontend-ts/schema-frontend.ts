import ts from "typescript";
import { unwrapArray, inheritedFields } from "@keyma/core/util";
import type { IRClassDeclaration, IRType, IRDiagnostic, IREnumDeclaration } from "@keyma/core/ir";
import { schemaEdge, schemaEphemeral, schemaIndexes, fieldIndexes } from "../ir/extensions.js";
import { assignTags, stripTagHints } from "./assign-tags.js";
import { discoverSchemas } from "./discover.js";
import { discoverEnums, type EnumInfo } from "@keyma/compiler/frontend-ts";
import { createFunctionCollector } from "@keyma/compiler/frontend-ts";
import { createValidatorFormatterCollector, isFactoryReturnType } from "./discover-validators.js";
import { lowerValidatorFactory, lowerFormatterFactory, type LowerDeps } from "./lower-validator.js";
import { extractSchema } from "./extract-schema.js";
import { checkInheritance } from "./check-inheritance.js";
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
} from "./diagnostics.js";
import type { FrontendDomain, FrontendDomainContext, FrontendContribution } from "@keyma/compiler/frontend-ts";

/** DSL marker type names that identify a validator/formatter factory (the schema domain owns these). */
const SCHEMA_MARKERS = { validator: "ValidatorFn", formatter: "FormatterFn" };

/**
 * The **schema** frontend domain: the full @Schema/@Edge authoring pipeline
 * — discover → extract own members → validate inheritance → post-checks → lower
 * validators/formatters/functions → normalize names → assign binary tags.
 * This is the entire schema-domain frontend; the generic orchestrator (`compileProgram` in
 * `@keyma/compiler/frontend-ts`) just runs `produce` and folds the contribution into the IR
 * envelope. (`@Service` is no longer a schema concern — the compiler discovers and extracts
 * services in a built-in base pass after every domain finalizes its classes.) The CLI registers
 * this domain (via `config.domains`); the compiler references no schema symbol, and a UI domain
 * plugs in alongside it additively.
 */
export const schemaFrontendDomain: FrontendDomain = {
    name: "schema",
    produce(program: ts.Program, ctx: FrontendDomainContext): FrontendContribution {
        const { checker, diagnostics } = ctx;
        // The schema-authoring decorators ship in `@keyma/schema/dsl`; that is the module
        // discovery resolves against by default (overridable via config for tests/embedding).
        const dslModuleName = ctx.dslModuleName ?? "@keyma/schema/dsl";

        const discoverCtx = { checker, dslModuleName, diagnostics };

        // Pass 1: discover all @Schema classes
        const discovered = discoverSchemas(program, discoverCtx);

        // Pass 1b: discover TS enum declarations referenced by schema fields
        const enums = discoverEnums(program);

        const schemaClassNames = new Set(discovered.map((d) => d.className));

        // Validator/formatter collector: resolves each `@Validate`/`@Format` factory at
        // its use site (across imports — including pure-TS library packages), enqueues
        // its declaration, and yields only the set actually referenced when drained.
        const vfCollector = createValidatorFormatterCollector({ checker, dslModuleName, markerNames: SCHEMA_MARKERS });

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

        // Pass 3: validate inheritance (no flattening — inheritance is real in the output).
        const inheritanceCtx = { schemas: schemasBySourceName, diagnostics };
        const schemas = checkInheritance(rawSchemas, inheritanceCtx);

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

        // Pass 4: lower the validator factories referenced by @Validate (tree-shaken). Each
        // collapses to an ordinary IRFunctionDeclaration (its body returns a typed arrow).
        const validatorFns = vfCollector.drainValidators().map((c) =>
            lowerValidatorFactory(c, diagnostics, lowerDeps)
        );

        // Pass 5: lower the formatter factories referenced by @Format (tree-shaken).
        const formatterFns = vfCollector.drainFormatters().map((c) =>
            lowerFormatterFactory(c, diagnostics, lowerDeps)
        );

        // Pass 6: enqueue the COMPLETE local utility-function surface — every project-local
        // top-level function, referenced or not — so the IR is a complete import surface and
        // tree-shaking is a backend (per-bundle) concern. Validator/formatter factories are
        // excluded here (identified by their `ValidatorFn`/`FormatterFn` return type); they are
        // lowered above, only where referenced, by the use-driven collector. Vendor functions stay
        // reference-driven (only those reached transitively from the bodies above are kept). The
        // drain then lowers every queued function (which may reference further functions) until the
        // worklist is empty.
        functionCollector.enqueueLocalSurface(program, (returnType) =>
            isFactoryReturnType(returnType, { checker, dslModuleName, markerNames: SCHEMA_MARKERS }),
        );
        const functionDeclarations = [...validatorFns, ...formatterFns, ...functionCollector.drain()];

        // Final pass: apply the configured prefix to every schema `name` and rewrite all
        // cross-references (reference/embedded/edge targets) from the authored class name
        // (`sourceName`) to the target's final `name`. After this, `name` is the single
        // identity used by every backend, the runtime, and DB adapters. Runs last so the
        // post-checks above (which resolve by `sourceName`) see the un-rewritten IR.
        // (Services are normalized separately by the compiler's base service pass, which
        // resolves against these now-finalized schema names.)
        normalizeSchemaNames(schemas, ctx.schemaPrefix);

        // Binary tag assignment — runs after flatten + normalize so it sees each schema's
        // final, prefixed, self-contained field list. Gated behind binary being enabled so
        // JSON-only users incur no manifest, no tags, and no `irVersion` bump.
        let tagManifest;
        if (ctx.binaryTags) {
            const result = assignTags(ctx.tagManifest, schemas, { acceptTags: ctx.acceptTags });
            diagnostics.push(...result.diagnostics);
            tagManifest = result.manifest;
        } else {
            stripTagHints(schemas);
        }

        // Collect the complete local enum surface (plus any referenced vendor enum).
        const localEnums = collectLocalAndUsedEnums(schemas, enums);

        return {
            schemas,
            enums: localEnums,
            functionDeclarations,
            ...(tagManifest !== undefined ? { tagManifest } : {}),
        };
    },
};

/**
 * Apply the schema-name prefix and normalize every cross-reference to the target
 * schema's final `name`. In-place mutation of the (already flattened, validated)
 * IR arrays. Reference/embedded/edge targets are authored as class names
 * (`sourceName`); here they become the prefixed `name` so the IR — and everything
 * downstream — addresses schemas by a single canonical identity.
 */
function normalizeSchemaNames(
    schemas: IRClassDeclaration[],
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
        const edge = schemaEdge(s);
        if (edge !== undefined) {
            edge.from = finalName.get(edge.from) ?? edge.from;
            edge.to = finalName.get(edge.to) ?? edge.to;
        }
        s.name = prefix + s.name;
        // The traversal label is this edge schema's own (now prefixed) name.
        if (edge !== undefined) edge.label = s.name;
    }
}

function checkDuplicateNames(schemas: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
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

function checkVisibilityLeaks(schemas: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
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
function checkPublicSchemaSurface(schemas: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const bySourceName = new Map(schemas.map((s) => [s.sourceName, s]));
    for (const schema of schemas) {
        if (schema.visibility !== "public") continue;
        // Inheritance is real: an instance's public surface includes inherited fields, so a
        // child with only own-private fields still passes if it inherits a public one.
        const all = inheritedFields(schema, bySourceName);
        if (all.length === 0) continue;
        if (all.some((f) => f.visibility === "public")) continue;
        diagnostics.push(
            mkError(
                KEYMA037,
                `Public schema "${schema.sourceName}" has only private fields — a public schema must expose at least one public field. Mark it @Schema({ private: true }), or make a field public.`,
                schema.source,
            ),
        );
    }
}

function checkEphemeralUsage(schemas: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const ephemeralSchemas = new Set(schemas.filter((s) => schemaEphemeral(s)).map((s) => s.sourceName));

    for (const schema of schemas) {
        // KEYMA035: a persisted (non-ephemeral) schema cannot hold a Reference<T>
        // to an ephemeral schema — a foreign key to data that is never stored.
        // Embedded<T> of an ephemeral schema is fine (the data is inlined).
        if (!schemaEphemeral(schema)) {
            for (const field of schema.fields) {
                const inner = unwrapArray(field.type);
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
        const hasFieldIndex = schema.fields.some((f) => fieldIndexes(f).length > 0);
        if (schemaIndexes(schema).length > 0 || hasFieldIndex) {
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

function checkEdgeSchemas(schemas: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const bySourceName = new Map(schemas.map((s) => [s.sourceName, s]));
    const edgeSourceNames = new Set(schemas.filter((s) => schemaEdge(s) !== undefined).map((s) => s.sourceName));

    // Edge schemas must not be used as referenced node types by other schemas.
    for (const schema of schemas) {
        if (schemaEdge(schema) !== undefined) continue;  // checked separately below
        for (const field of schema.fields) {
            const inner = unwrapArray(field.type);
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
        const edge = schemaEdge(schema);
        if (edge === undefined) continue;

        for (const [role, target] of [["from", edge.from], ["to", edge.to]] as const) {
            const resolved = bySourceName.get(target);
            if (resolved !== undefined && schemaEdge(resolved) !== undefined) {
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

function checkReferenceTargetsHaveId(schemas: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const bySourceName = new Map(schemas.map((s) => [s.sourceName, s]));

    for (const schema of schemas) {
        for (const field of schema.fields) {
            const inner = unwrapArray(field.type);
            if (inner.kind !== "reference") continue;
            const target = bySourceName.get(inner.schema);
            if (target === undefined) continue;
            // The id field may be inherited (the target extends a base that declares it).
            const idField = inheritedFields(target, bySourceName).find((f) => f.type.kind === "id");
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

/**
 * The complete local enum surface: every project-local portable enum (referenced or not, so the
 * IR is a complete import surface), plus any referenced enum regardless of origin. A non-portable
 * enum (`members === null`) is skipped — it only errors where referenced (the type mapper reports
 * KEYMA025 there). Library enums ship as declaration files (already filtered by `discoverEnums`),
 * so a non-declaration source under `node_modules` is the only vendor case to exclude from the
 * eager pass; referenced vendor enums still come in via the use-driven pass below.
 */
function collectLocalAndUsedEnums(
    schemas: IRClassDeclaration[],
    enums: ReadonlyMap<string, EnumInfo>,
): IREnumDeclaration[] {
    const result: IREnumDeclaration[] = [];
    const added = new Set<string>();
    const push = (info: EnumInfo): void => {
        if (info.members == null || added.has(info.name)) return;
        added.add(info.name);
        result.push({ name: info.name, members: info.members, source: info.source });
    };

    // Eager: every project-local portable enum.
    for (const info of enums.values()) {
        if (!info.source.file.replace(/\\/g, "/").includes("/node_modules/")) push(info);
    }
    // Use-driven: any enum a field references (covers a vendor enum reached by reference).
    const used = new Set<string>();
    const visit = (t: IRType): void => {
        if (t.kind === "array") visit(t.of);
        else if (t.kind === "enum" && t.name !== undefined) used.add(t.name);
    };
    for (const schema of schemas) {
        for (const field of schema.fields) visit(field.type);
    }
    for (const name of used) {
        const info = enums.get(name);
        if (info !== undefined) push(info);
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
function analyzeEmbeddedCycles(schemas: IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const known = new Set(schemas.map((s) => s.sourceName));
    const sourceOf = new Map(schemas.map((s) => [s.sourceName, s.source]));

    // schema sourceName → the schemas it inlines via Embedded<T> (incl. Embedded<T>[]).
    // Inheritance is real, so an instance also inlines its parents' embedded fields — walk the
    // full field set so a cycle running through an inherited embed is still detected.
    const bySourceName = new Map(schemas.map((s) => [s.sourceName, s]));
    const embedsOf = new Map<string, string[]>();
    for (const schema of schemas) {
        const targets: string[] = [];
        for (const field of inheritedFields(schema, bySourceName)) {
            const inner = unwrapArray(field.type);
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
