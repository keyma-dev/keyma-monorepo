import ts from "typescript";
import { unwrapArray, inheritedFields } from "@keyma/core/util";
import type {
    IRClassDeclaration, IRMember, IRType, IRDiagnostic, IRFunctionDeclaration,
} from "@keyma/core/ir";
import {
    fieldExt, mutFieldExt, setFieldExtSlice, mutSchemaExt, setSchemaExtSlice, setFieldForm,
    schemaEdge, schemaEphemeral, schemaIndexes, fieldIndexes,
    type IRFormatter, type IRFieldIndex, type IRIndex, type IREdge,
    type FieldExtData, type SchemaExtData,
} from "../ir/extensions.js";
import {
    lowerValidateArgs, lowerFormatArgs, lowerIndexedArgs, lowerFormFieldArg, type LowerContext,
} from "./lower-decorator.js";
import {
    createValidatorFormatterCollector, isFactoryReturnType, type ValidatorFormatterCollector,
} from "./discover-validators.js";
import { lowerValidatorFactory, lowerFormatterFactory, type LowerDeps } from "./lower-validator.js";
import { synthesizeClassMembers } from "./synthesize.js";
import { extractDecoratorOptions } from "@keyma/compiler/frontend-ts";
import type {
    FrontendDomain, DomainBaseContext, DomainContext, HandlerContext, DomainDecorator,
} from "@keyma/compiler/frontend-ts";
import {
    mkError,
    mkWarning,
    KEYMA017,
    KEYMA019,
    KEYMA035,
    KEYMA036,
    KEYMA060,
    KEYMA061,
    KEYMA064,
    KEYMA065,
    KEYMA066,
    KEYMA070,
    KEYMA072,
} from "./diagnostics.js";

/** The module the schema-authoring decorators ship in — what discovery resolves against. */
const SCHEMA_DSL = "@keyma/schema/dsl";

/** DSL marker type names that identify a validator/formatter factory (the schema domain owns these). */
const SCHEMA_MARKERS = { validator: "ValidatorFn", formatter: "FormatterFn" };

/**
 * The schema domain's per-compile state (built by {@link FrontendDomain.init}, threaded to every
 * handler/hook via `ctx.state`). The validator/formatter collector resolves each `@Validate`/
 * `@Format` factory at its use site and yields only the referenced set when drained; the two
 * WeakMaps carry the per-class facts the member-decorator handlers accumulate (endpoint fields
 * from `@From()`/`@To()`, and the `@Edge(...)` mark + its `directed` flag) into `finalizeClass`.
 */
type SchemaState = {
    dslModuleName: string;
    vfCollector: ValidatorFormatterCollector;
    /** `@From()`/`@To()`-decorated field names, per class — for edge derivation + auto-indexing. */
    endpoints: WeakMap<IRClassDeclaration, EndpointAccumulator>;
    /** Classes decorated `@Edge(...)`, with the directed flag — for edge derivation. */
    edgeClasses: WeakMap<IRClassDeclaration, { directed: boolean }>;
    /** The lowered validator/formatter factory declarations, keyed by name — stashed in `check()`
     *  so `afterNormalize` synthesis can pass them as the `functionDecls` dep (for factory-call arg
     *  ordering + inner-arrow shape). */
    factoryDecls: Map<string, IRFunctionDeclaration>;
};

type EndpointAccumulator = { fromFields: string[]; toFields: string[] };

/**
 * The **schema** frontend domain in the inverted control flow: a declarative descriptor. The
 * compiler owns DSL discovery, the base-IR build for every class, base validation, name
 * normalization, binary tags, the function surface, enum collection, and the `@Service` base
 * pass; this domain contributes only its slice — the `@Schema`/`@Edge` + `@Validate`/`@Format`/
 * `@Indexed`/`@Ephemeral`/`@FormField`/`@From`/`@To`/`@Computed` decorators and their enrichment
 * handlers, per-class aggregation (composite-index hoisting + edge derivation), the pre-normalize
 * post-checks, the validator/formatter factory lowering, and the edge cross-reference rewrite.
 * The CLI registers this domain (via `config.domains`); the compiler references no schema symbol,
 * so a UI domain plugs in alongside it additively.
 */
export const schemaFrontendDomain: FrontendDomain = {
    name: "schema",
    dslModule: SCHEMA_DSL,

    init(ctx: DomainBaseContext): SchemaState {
        const dslModuleName = ctx.dslModuleName ?? SCHEMA_DSL;
        return {
            dslModuleName,
            vfCollector: createValidatorFormatterCollector({
                checker: ctx.checker,
                dslModuleName,
                markerNames: SCHEMA_MARKERS,
            }),
            endpoints: new WeakMap(),
            edgeClasses: new WeakMap(),
            factoryDecls: new Map(),
        };
    },

    decorators: [
        // ── Class decorators ──────────────────────────────────────────────────────
        // `@Schema(...)` overrides the base-IR `name`/`visibility`/`description` and marks the
        // class ephemeral. `@Edge(...)` shares those options and additionally records the edge
        // (with its `directed` flag) so `finalizeClass` derives the edge from `@From()`/`@To()`.
        {
            name: "Schema",
            module: SCHEMA_DSL,
            target: "class",
            handle(deco, ir) {
                applyClassOptions(ir as IRClassDeclaration, deco);
            },
        },
        {
            name: "Edge",
            module: SCHEMA_DSL,
            target: "class",
            handle(deco, ir, ctx) {
                const cls = ir as IRClassDeclaration;
                applyClassOptions(cls, deco);
                (ctx.state as SchemaState).edgeClasses.set(cls, { directed: readEdgeDirected(deco) });
            },
        },

        // ── Member decorators ─────────────────────────────────────────────────────
        {
            name: "Validate",
            module: SCHEMA_DSL,
            target: "member",
            handle(deco, ir, ctx) {
                const field = ir as IRMember;
                const vs = lowerValidateArgs(decoratorArgs(deco), lowerCtxFrom(ctx));
                if (vs.length > 0) {
                    const ext = mutFieldExt(field);
                    ext.validators = [...(ext.validators ?? []), ...vs];
                }
                // Promote number → integer once an `integer` validator is attached.
                if (field.type.kind === "number" && (fieldExt(field)?.validators ?? []).some((v) => v.name === "integer")) {
                    field.type = { kind: "integer" };
                }
            },
        },
        {
            name: "Format",
            module: SCHEMA_DSL,
            target: "member",
            handle(deco, ir, ctx) {
                const field = ir as IRMember;
                const fs = lowerFormatArgs(decoratorArgs(deco), lowerCtxFrom(ctx));
                if (fs.length > 0) {
                    const ext = mutFieldExt(field);
                    ext.formatters = [
                        ...(ext.formatters ?? []),
                        ...fs.map(({ phase, spec }) => ({ phase: phase as IRFormatter["phase"], spec })),
                    ];
                }
            },
        },
        {
            name: "Indexed",
            module: SCHEMA_DSL,
            target: "member",
            handle(deco, ir, ctx) {
                const field = ir as IRMember;
                const idx = lowerIndexedArgs(decoratorArgs(deco), lowerCtxFrom(ctx));
                if (idx !== null) {
                    const ext = mutFieldExt(field);
                    ext.indexes = [...(ext.indexes ?? []), idx];
                }
            },
        },
        {
            name: "Ephemeral",
            module: SCHEMA_DSL,
            target: "member",
            handle(_deco, ir) {
                mutFieldExt(ir as IRMember).ephemeral = true;
            },
        },
        {
            name: "FormField",
            module: SCHEMA_DSL,
            target: "member",
            handle(deco, ir, ctx) {
                setFieldForm(ir as IRMember, lowerFormFieldArg(decoratorArgs(deco), lowerCtxFrom(ctx)));
            },
        },
        {
            name: "From",
            module: SCHEMA_DSL,
            target: "member",
            handle(_deco, ir, ctx) {
                endpointsOf(ctx.state as SchemaState, ctx.class).fromFields.push((ir as IRMember).name);
            },
        },
        {
            name: "To",
            module: SCHEMA_DSL,
            target: "member",
            handle(_deco, ir, ctx) {
                endpointsOf(ctx.state as SchemaState, ctx.class).toFields.push((ir as IRMember).name);
            },
        },
        {
            // `@Computed()` only ever belongs on a getter (handled as a deferred behavior by the
            // base getter lowering, KEYMA098). The driver dispatches member decorators only to
            // stored fields, so reaching this handler means it sits on a plain property — a misuse.
            name: "Computed",
            module: SCHEMA_DSL,
            target: "member",
            handle(_deco, ir, ctx) {
                const field = ir as IRMember;
                ctx.diagnostics.push(
                    mkError(
                        KEYMA019,
                        `@Computed() can only be applied to a getter — field "${field.name}" is a plain property`,
                        field.source,
                    ),
                );
            },
        },
    ],

    /**
     * Per-class aggregation after base lowering + member-decorator dispatch: auto-index the edge
     * endpoint fields, hoist keyed field indexes into schema-level composite indexes, derive the
     * edge from `@From()`/`@To()` endpoints, then write the schema-domain slice in its canonical
     * shape (indexes, ephemeral, edge). A no-op on classes carrying none of these.
     */
    finalizeClass(cls: IRClassDeclaration, ctx: DomainContext): void {
        const state = ctx.state as SchemaState;
        const acc = state.endpoints.get(cls);

        // Edge endpoint fields (@From()/@To()) are indexed automatically so the user need not add
        // @Indexed; an explicit @Indexed still wins.
        if (acc !== undefined) {
            for (const fieldName of [...acc.fromFields, ...acc.toFields]) {
                const field = cls.fields.find((f) => f.name === fieldName);
                if (field !== undefined && fieldIndexes(field).length === 0) {
                    mutFieldExt(field).indexes = [{}];
                }
            }
        }

        const compositeIndexes = hoistCompositeIndexes(cls, ctx.diagnostics);

        let edge: IREdge | undefined;
        const edgeMark = state.edgeClasses.get(cls);
        if (edgeMark !== undefined) {
            edge = deriveEdge(cls, acc ?? { fromFields: [], toFields: [] }, edgeMark.directed, ctx.diagnostics);
        }

        // Schema-domain metadata (composite indexes, ephemeral, edge) lives under
        // `cls.extensions['schema']` — written in canonical order so the slice is stable.
        const slice: SchemaExtData = {};
        if (compositeIndexes.length > 0) slice.indexes = compositeIndexes;
        if (schemaEphemeral(cls)) slice.ephemeral = true;
        if (edge !== undefined) slice.edge = edge;
        setSchemaExtSlice(cls, slice);
    },

    /**
     * Pre-normalize extra checks (resolved by `sourceName`) + lower the referenced validator/
     * formatter factories. The post-checks reject ephemeral misuse, structural edge problems,
     * Reference<T> targets without an id, and Embedded<T> cycles; each factory collapses to an
     * ordinary `IRFunctionDeclaration` returned to the driver's function surface.
     */
    check(classes: readonly IRClassDeclaration[], ctx: DomainContext): { functionDeclarations?: IRFunctionDeclaration[] } {
        const state = ctx.state as SchemaState;
        const { diagnostics } = ctx;

        // Persisted schemas must not reference ephemeral schemas; indexes on ephemeral schemas
        // have no effect.
        checkEphemeralUsage(classes, diagnostics);
        // Edge schema structural checks (from/to fields/indexes/refs).
        checkEdgeSchemas(classes, diagnostics);
        // Every Reference<T> target schema must declare an ID field.
        checkReferenceTargetsHaveId(classes, diagnostics);
        // Reject cycles in the Embedded<T> graph (infinite inline data).
        analyzeEmbeddedCycles(classes, diagnostics);

        const lowerDeps: LowerDeps = {
            checker: ctx.checker,
            dslModuleName: state.dslModuleName,
            schemaClassNames: ctx.classNames,
            classifyFunction: ctx.classify,
        };
        const validatorFns = state.vfCollector.drainValidators().map((c) => lowerValidatorFactory(c, diagnostics, lowerDeps));
        const formatterFns = state.vfCollector.drainFormatters().map((c) => lowerFormatterFactory(c, diagnostics, lowerDeps));
        // Stash the lowered factories so `afterNormalize` synthesis can read each one's params (arg
        // ordering) + inner-arrow shape when building the per-class `validate`/`format*` methods.
        state.factoryDecls = new Map([...validatorFns, ...formatterFns].map((d) => [d.name, d]));
        return { functionDeclarations: [...validatorFns, ...formatterFns] };
    },

    /** A project-local function whose return type is `ValidatorFn`/`FormatterFn` is a factory:
     *  excluded from the eager local-function surface (it is lowered above, only where referenced). */
    excludeFromFunctionSurface(returnType, ctx: DomainContext): boolean {
        const state = ctx.state as SchemaState;
        return isFactoryReturnType(returnType, {
            checker: ctx.checker,
            dslModuleName: state.dslModuleName,
            markerNames: SCHEMA_MARKERS,
        });
    },

    /** Post-normalize: (1) rewrite each edge's `from`/`to`/`label` from the authored `sourceName`
     *  to the now-prefixed final `name`; (2) SYNTHESIZE each class's schema-domain methods
     *  (`validate`/`format*`) from base IR and append them to `cls.methods`, so the compiler emits
     *  them blindly (the "eliminate domain backends" flip). Runs after name normalization (final
     *  prefixed names) with the classes still mutable. METHODS ONLY — the `metadata` static stays
     *  compiler-rendered by `buildClassData` (decision-8-amended). */
    afterNormalize(classes: readonly IRClassDeclaration[], nameMap: ReadonlyMap<string, string>, ctx: DomainContext): void {
        for (const cls of classes) {
            const edge = schemaEdge(cls);
            if (edge === undefined) continue;
            edge.from = nameMap.get(edge.from) ?? edge.from;
            edge.to = nameMap.get(edge.to) ?? edge.to;
            // The traversal label is this edge schema's own (now prefixed) name.
            edge.label = cls.name;
        }

        const state = ctx.state as SchemaState;
        const classesBySourceName = new Map(classes.map((c) => [c.sourceName, c]));
        for (const cls of classes) {
            const { methods } = synthesizeClassMembers(cls, {
                functionDecls: state.factoryDecls,
                classesBySourceName,
            });
            if (methods.length > 0) cls.methods = [...(cls.methods ?? []), ...methods];
        }
    },
};

// ─── Handler helpers ─────────────────────────────────────────────────────────────

const EMPTY_ARGS = ts.factory.createNodeArray<ts.Expression>([]);

/** The decorator-call argument list, or an empty list for a bare `@Decorator` (no parens). */
function decoratorArgs(deco: ts.Decorator): ts.NodeArray<ts.Expression> {
    const expr = deco.expression;
    return ts.isCallExpression(expr) ? expr.arguments : EMPTY_ARGS;
}

/** Build the decorator-argument lowering context from a handler context + the domain's state. */
function lowerCtxFrom(ctx: HandlerContext): LowerContext {
    const state = ctx.state as SchemaState;
    return {
        checker: ctx.checker,
        diagnostics: ctx.diagnostics,
        sourceFile: ctx.sourceFile,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.classNames,
        resolveValidator: state.vfCollector.resolveValidator,
        resolveFormatter: state.vfCollector.resolveFormatter,
        classifyFunction: ctx.classify,
    };
}

/** Get-or-create the per-class endpoint accumulator in the domain state. */
function endpointsOf(state: SchemaState, cls: IRClassDeclaration): EndpointAccumulator {
    let acc = state.endpoints.get(cls);
    if (acc === undefined) {
        acc = { fromFields: [], toFields: [] };
        state.endpoints.set(cls, acc);
    }
    return acc;
}

/** Apply `@Schema`/`@Edge` options over the base IR: `name`/`private`/`description`/`ephemeral`. */
function applyClassOptions(cls: IRClassDeclaration, deco: ts.Decorator): void {
    const opts = extractDecoratorOptions(deco);
    if (opts.name !== undefined) cls.name = opts.name;
    if (opts.private === true) cls.visibility = "private";
    if (opts.description !== undefined) cls.description = opts.description;
    if (opts.ephemeral === true) mutSchemaExt(cls).ephemeral = true;
}

/** Read `@Edge({ directed })` — defaults to true (a directed edge) when omitted. */
function readEdgeDirected(deco: ts.Decorator): boolean {
    const expr = deco.expression;
    if (!ts.isCallExpression(expr) || expr.arguments.length === 0) return true;
    const arg = expr.arguments[0];
    if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return true;
    for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        if (prop.name.text !== "directed") continue;
        if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
        if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
    }
    return true;
}

// ─── finalizeClass helpers ───────────────────────────────────────────────────────

/**
 * Group keyed field indexes (`@Indexed({ key })`) into schema-level composite `IRIndex` entries
 * and strip them from the fields (non-keyed single-field indexes stay on the field). Fields appear
 * in declaration order, so the iteration order is already correct. Emits KEYMA017 on a composite
 * key whose members disagree on unique/sparse.
 */
function hoistCompositeIndexes(cls: IRClassDeclaration, diagnostics: IRDiagnostic[]): IRIndex[] {
    const compositeGroups = new Map<string, Array<{ fieldName: string; idx: IRFieldIndex }>>();
    for (const field of cls.fields) {
        const ext = fieldExt(field);
        if (ext?.indexes === undefined) continue;
        const keyed = ext.indexes.filter((idx) => idx.key !== undefined);
        for (const idx of keyed) {
            const key = idx.key!;
            if (!compositeGroups.has(key)) compositeGroups.set(key, []);
            compositeGroups.get(key)!.push({ fieldName: field.name, idx });
        }
        // Keyed entries live only in schema-level indexes, not on the field. Preserve the rest of
        // the slice (ephemeral + validator/formatter attachments) — only `indexes` changes.
        const remaining = ext.indexes.filter((idx) => idx.key === undefined);
        const newExt: FieldExtData = { ...ext };
        if (remaining.length > 0) newExt.indexes = remaining;
        else delete newExt.indexes;
        setFieldExtSlice(field, newExt);
    }

    const compositeIndexes: IRIndex[] = [];
    for (const [key, entries] of compositeGroups) {
        let unique: boolean | undefined;
        let sparse: boolean | undefined;
        let conflict = false;
        for (const { idx } of entries) {
            if (idx.unique !== undefined) {
                if (unique !== undefined && unique !== idx.unique) conflict = true;
                unique = idx.unique;
            }
            if (idx.sparse !== undefined) {
                if (sparse !== undefined && sparse !== idx.sparse) conflict = true;
                sparse = idx.sparse;
            }
        }
        if (conflict) {
            diagnostics.push(mkWarning(KEYMA017, `Composite index "${key}" has conflicting unique/sparse values across fields`));
        }
        const irIndex: IRIndex = {
            name: key,
            fields: entries.map(({ fieldName, idx }) => ({ name: fieldName, direction: idx.direction ?? 1 })),
        };
        if (unique !== undefined) irIndex.unique = unique;
        if (sparse !== undefined) irIndex.sparse = sparse;
        compositeIndexes.push(irIndex);
    }
    return compositeIndexes;
}

/** Core (array-unwrapped) reference target schema of a field type. */
function referenceTargetOf(type: IRType): string | undefined {
    let t: IRType = type;
    while (t.kind === "array") t = t.of;
    return t.kind === "reference" || t.kind === "embedded" ? t.target : undefined;
}

/**
 * Build the IREdge from the `@From()`/`@To()`-decorated endpoint fields. The traversal label is
 * the schema `name`. Emits KEYMA065 (missing endpoint), KEYMA066 (duplicate endpoint), and
 * KEYMA061 (endpoint field not a reference type). Returns undefined when the edge cannot be formed.
 */
function deriveEdge(
    cls: IRClassDeclaration,
    endpoints: EndpointAccumulator,
    directed: boolean,
    diagnostics: IRDiagnostic[],
): IREdge | undefined {
    const { fromFields, toFields } = endpoints;

    if (fromFields.length > 1 || toFields.length > 1) {
        diagnostics.push(
            mkError(
                KEYMA066,
                `Edge schema "${cls.sourceName}" declares multiple @From()/@To() fields — exactly one of each is allowed`,
                cls.source,
            ),
        );
    }
    if (fromFields.length === 0 || toFields.length === 0) {
        diagnostics.push(
            mkError(
                KEYMA065,
                `Edge schema "${cls.sourceName}" must declare one @From() and one @To() field`,
                cls.source,
            ),
        );
        return undefined;
    }

    const fromField = fromFields[0]!;
    const toField = toFields[0]!;
    const from = referenceTargetOf(cls.fields.find((f) => f.name === fromField)!.type);
    const to = referenceTargetOf(cls.fields.find((f) => f.name === toField)!.type);

    if (from === undefined || to === undefined) {
        const bad = from === undefined ? fromField : toField;
        diagnostics.push(
            mkError(
                KEYMA061,
                `Edge schema "${cls.sourceName}" endpoint field "${bad}" must be a node reference (a @Schema class or Reference<T>)`,
                cls.source,
            ),
        );
        return undefined;
    }

    return { from, fromField, to, toField, label: cls.name, directed };
}

// ─── Pre-normalize post-checks (resolved by sourceName) ──────────────────────────

function checkEphemeralUsage(schemas: readonly IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const ephemeralSchemas = new Set(schemas.filter((s) => schemaEphemeral(s)).map((s) => s.sourceName));

    for (const schema of schemas) {
        // KEYMA035: a persisted (non-ephemeral) schema cannot hold a Reference<T>
        // to an ephemeral schema — a foreign key to data that is never stored.
        // Embedded<T> of an ephemeral schema is fine (the data is inlined).
        if (!schemaEphemeral(schema)) {
            for (const field of schema.fields) {
                const inner = unwrapArray(field.type);
                if (inner.kind === "reference" && ephemeralSchemas.has(inner.target)) {
                    diagnostics.push(
                        mkError(
                            KEYMA035,
                            `Persisted schema "${schema.sourceName}" references ephemeral schema "${inner.target}" via field "${field.name}" — ephemeral schemas are never stored and cannot be a reference target`,
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

function checkEdgeSchemas(schemas: readonly IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const bySourceName = new Map(schemas.map((s) => [s.sourceName, s]));
    const edgeSourceNames = new Set(schemas.filter((s) => schemaEdge(s) !== undefined).map((s) => s.sourceName));

    // Edge schemas must not be used as referenced node types by other schemas.
    for (const schema of schemas) {
        if (schemaEdge(schema) !== undefined) continue;  // checked separately below
        for (const field of schema.fields) {
            const inner = unwrapArray(field.type);
            if ((inner.kind === "reference" || inner.kind === "embedded") && edgeSourceNames.has(inner.target)) {
                diagnostics.push(
                    mkError(
                        KEYMA064,
                        `Schema "${schema.sourceName}" references edge schema "${inner.target}" via field "${field.name}" — edges are not addressable as nodes`,
                        field.source,
                    ),
                );
            }
        }
    }

    // Per-edge structural checks. The endpoint fields, their names, and target schemas are derived
    // from @From()/@To() in finalizeClass (which also emits KEYMA061/065/066). Here we only verify
    // the targets are node schemas — not edges — since that needs the full schema set.
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

function checkReferenceTargetsHaveId(schemas: readonly IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
    const bySourceName = new Map(schemas.map((s) => [s.sourceName, s]));

    for (const schema of schemas) {
        for (const field of schema.fields) {
            const inner = unwrapArray(field.type);
            if (inner.kind !== "reference") continue;
            const target = bySourceName.get(inner.target);
            if (target === undefined) continue;
            // The id field may be inherited (the target extends a base that declares it).
            const idField = inheritedFields(target, bySourceName).find((f) => f.type.kind === "id");
            if (idField === undefined) {
                diagnostics.push(
                    mkError(
                        KEYMA070,
                        `Field "${field.name}" on schema "${schema.sourceName}" is Reference<${inner.target}>, but "${inner.target}" has no field of type ID — Reference<T> requires T to declare an "id: ID" field`,
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
 * Reject cycles in the Embedded<T> graph (KEYMA072, incl. a self-embed). `Embedded<T>`
 * is an inline copy, so a cycle of embeds describes infinitely-nested data and can
 * never be materialized. Only embedded edges are followed — `Reference<T>` stores
 * just an id, so reference cycles are legal (a foreign-key loop). Runs pre-normalization,
 * so embedded targets are still authored `sourceName`s. Uses a 3-colour DFS across
 * schemas.
 */
function analyzeEmbeddedCycles(schemas: readonly IRClassDeclaration[], diagnostics: IRDiagnostic[]): void {
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
            if (inner.kind === "embedded" && known.has(inner.target)) targets.push(inner.target);
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
