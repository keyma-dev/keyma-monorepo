import ts from "typescript";
import type {
    IRClassDeclaration, IRField, IRType, IRDiagnostic, IRDefault, IRMethod,
} from "@keyma/core/ir";
import {
    fieldExt, setFieldExtSlice, setSchemaExtSlice, setFieldForm,
    type IRValidator, type IRFormatter,
    type IRFieldIndex, type IRIndex, type IREdge, type FieldExtData, type SchemaExtData, type IRFormField,
} from "../ir/extensions.js";
import { mkError, mkWarning, KEYMA017, KEYMA019, KEYMA040, KEYMA061, KEYMA065, KEYMA066, KEYMA098, KEYMA102 } from "./diagnostics.js";
import { getLocation, isFromModule, stringLiteralValue, numericLiteralValue } from "@keyma/compiler/frontend-ts";
import type { RawTaggedField } from "./assign-tags.js";
import { mapTypeNode } from "@keyma/compiler/frontend-ts";
import { lowerValidateArgs, lowerFormatArgs, lowerIndexedArgs, lowerInitializerDefault, lowerFormFieldArg } from "./lower-decorator.js";
import { lowerGetterBody } from "@keyma/compiler/frontend-ts";
import { lowerMethod, lowerSetter, lowerConstructor, lowerDestructor, type MethodLowerCtx } from "@keyma/compiler/frontend-ts";
import type { FnRefVerdict } from "@keyma/compiler/frontend-ts";
import type { ResolvedFactory } from "./discover-validators.js";
import type { DiscoveredSchema } from "./discover.js";
import type { EnumInfo } from "@keyma/compiler/frontend-ts";

type ExtractContext = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
    /** Named TS enum declarations, keyed by name. */
    enums?: ReadonlyMap<string, EnumInfo>;
    diagnostics: IRDiagnostic[];
    /** Resolve a `@Validate(...)` callee to a validator factory (enqueues it for lowering). */
    resolveValidator?: (callee: ts.Identifier) => ResolvedFactory | undefined;
    /** Resolve a `@Format(...)` callee to a formatter factory (enqueues it for lowering). */
    resolveFormatter?: (callee: ts.Identifier) => ResolvedFactory | undefined;
    /** Classify a call target in method bodies so project-local utilities compile. */
    classifyFunction?: (ident: ts.Identifier) => FnRefVerdict;
};

/**
 * Extract an IRClassDeclaration from a discovered class. The schema contains only the
 * class's own fields (not inherited). Flattening happens in a later pass.
 */
export function extractSchema(
    discovered: DiscoveredSchema,
    ctx: ExtractContext
): IRClassDeclaration {
    const { classNode, className, sourceFile, schemaOptions } = discovered;
    const name = schemaOptions.name ?? className.toLowerCase();
    const visibility = schemaOptions.private === true ? "private" : "public";

    // Endpoint fields are collected during field extraction so the edge can be
    // derived from the @From()/@To() decorators (rather than @Edge options).
    const endpoints: EndpointAccumulator = { fromFields: [], toFields: [] };

    const fieldCtx: FieldExtractContext = {
        ...ctx,
        sourceFile,
        endpoints,
    };

    const methodCtx: MethodLowerCtx = {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
        ...(ctx.enums !== undefined && { enums: ctx.enums }),
        diagnostics: ctx.diagnostics,
        sourceFile,
        ...(ctx.classifyFunction !== undefined ? { classifyFunction: ctx.classifyFunction } : {}),
    };

    const seenNames = new Set<string>();
    const fields: IRField[] = [];
    const rawMethods: IRMethod[] = [];

    for (const member of classNode.members) {
        if (ts.isPropertyDeclaration(member)) {
            if (!member.name || !ts.isIdentifier(member.name)) continue;
            const fieldName = member.name.text;

            if (seenNames.has(fieldName)) {
                ctx.diagnostics.push(
                    mkError(KEYMA040, `Duplicate field name "${fieldName}"`, getLocation(member.name, sourceFile))
                );
                continue;
            }
            seenNames.add(fieldName);

            const field = extractField(member, fieldCtx);
            if (field) fields.push(field);
        } else if (ts.isGetAccessorDeclaration(member)) {
            // Getters are behaviors (re-emitted accessors), not schema fields.
            if (!member.name || !ts.isIdentifier(member.name)) continue;
            const g = lowerGetter(member, member.name.text, memberVisibility(member), fieldCtx);
            if (g) rawMethods.push(g);
        } else if (ts.isMethodDeclaration(member)) {
            if (!member.name || !ts.isIdentifier(member.name)) continue;
            const methodName = member.name.text;
            // A method literally named `destructor` is the finalizer authoring convention
            // (matches the JS emission name); everything else lowers as a plain method.
            const m = methodName === "destructor"
                ? lowerDestructor(member, memberVisibility(member), methodCtx)
                : lowerMethod(member, methodName, memberVisibility(member), methodCtx);
            if (m) rawMethods.push(m);
        } else if (ts.isSetAccessorDeclaration(member)) {
            if (!member.name || !ts.isIdentifier(member.name)) continue;
            const m = lowerSetter(member, member.name.text, memberVisibility(member), methodCtx);
            if (m) rawMethods.push(m);
        } else if (ts.isConstructorDeclaration(member)) {
            const c = lowerConstructor(member, memberVisibility(member), methodCtx);
            if (c) rawMethods.push(c);
        }
        // Skip static members, etc.
    }

    const methods = dedupeMethods(rawMethods, fields, ctx, sourceFile);

    // Group keyed field indexes into schema-level composite IRIndex entries.
    // Fields appear in declaration order, so the iteration order is already correct.
    // Field indexes ride in `field.extensions['schema'].indexes`.
    const compositeGroups = new Map<string, Array<{ fieldName: string; idx: IRFieldIndex }>>();
    for (const field of fields) {
        const ext = fieldExt(field);
        if (ext?.indexes === undefined) continue;
        const keyed = ext.indexes.filter((idx) => idx.key !== undefined);
        for (const idx of keyed) {
            const key = idx.key!;
            if (!compositeGroups.has(key)) compositeGroups.set(key, []);
            compositeGroups.get(key)!.push({ fieldName: field.name, idx });
        }
        // Keyed entries live only in schema-level indexes, not on the field. Preserve the
        // rest of the slice (ephemeral + validator/formatter attachments) — only `indexes` changes.
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
            ctx.diagnostics.push(mkWarning(KEYMA017, `Composite index "${key}" has conflicting unique/sparse values across fields`));
        }
        const irIndex: IRIndex = {
            name: key,
            fields: entries.map(({ fieldName, idx }) => ({
                name: fieldName,
                direction: idx.direction ?? 1,
            })),
        };
        if (unique !== undefined) irIndex.unique = unique;
        if (sparse !== undefined) irIndex.sparse = sparse;
        compositeIndexes.push(irIndex);
    }

    const schema: IRClassDeclaration = {
        name,
        sourceName: className,
        visibility,
        fields,
        source: discovered.source,
    };

    if (methods.length > 0) {
        schema.methods = methods;
    }
    if (schemaOptions.description !== undefined) {
        schema.description = schemaOptions.description;
    }
    if (discovered.parentClassName !== undefined) {
        schema.extends = discovered.parentClassName;
    }

    // Schema-domain metadata (composite indexes, ephemeral, edge) lives under
    // `schema.extensions['schema']` — it is not part of the domain-neutral core IR.
    const schemaExtData: SchemaExtData = {};
    if (compositeIndexes.length > 0) schemaExtData.indexes = compositeIndexes;
    if (schemaOptions.ephemeral === true) schemaExtData.ephemeral = true;
    if (discovered.edgeOptions !== undefined) {
        const edge = deriveEdge(schema, endpoints, discovered.edgeOptions.directed ?? true, ctx);
        if (edge !== undefined) schemaExtData.edge = edge;
    }
    setSchemaExtSlice(schema, schemaExtData);

    return schema;
}

type EndpointAccumulator = { fromFields: string[]; toFields: string[] };

/** Core (array-unwrapped) reference target schema of a field type. */
function referenceTargetOf(type: IRType): string | undefined {
    let t: IRType = type;
    while (t.kind === "array") t = t.of;
    return t.kind === "reference" || t.kind === "embedded" ? t.schema : undefined;
}

/**
 * Build the IREdge from the @From()/@To()-decorated endpoint fields. The
 * traversal label is the schema `name`. Emits KEYMA065 (missing endpoint),
 * KEYMA066 (duplicate endpoint), and KEYMA061 (endpoint field not a reference
 * type). Returns undefined when the edge cannot be formed.
 */
function deriveEdge(
    schema: IRClassDeclaration,
    endpoints: EndpointAccumulator,
    directed: boolean,
    ctx: ExtractContext,
): IREdge | undefined {
    const { fromFields, toFields } = endpoints;

    if (fromFields.length > 1 || toFields.length > 1) {
        ctx.diagnostics.push(
            mkError(
                KEYMA066,
                `Edge schema "${schema.sourceName}" declares multiple @From()/@To() fields — exactly one of each is allowed`,
                schema.source,
            ),
        );
    }
    if (fromFields.length === 0 || toFields.length === 0) {
        ctx.diagnostics.push(
            mkError(
                KEYMA065,
                `Edge schema "${schema.sourceName}" must declare one @From() and one @To() field`,
                schema.source,
            ),
        );
        return undefined;
    }

    const fromField = fromFields[0]!;
    const toField = toFields[0]!;
    const from = referenceTargetOf(schema.fields.find((f) => f.name === fromField)!.type);
    const to = referenceTargetOf(schema.fields.find((f) => f.name === toField)!.type);

    if (from === undefined || to === undefined) {
        const bad = from === undefined ? fromField : toField;
        ctx.diagnostics.push(
            mkError(
                KEYMA061,
                `Edge schema "${schema.sourceName}" endpoint field "${bad}" must be a node reference (a @Schema class or Reference<T>)`,
                schema.source,
            ),
        );
        return undefined;
    }

    return { from, fromField, to, toField, label: schema.name, directed };
}

type FieldExtractContext = ExtractContext & {
    sourceFile: ts.SourceFile;
    /** Collects @From()/@To()-decorated field names for edge derivation. */
    endpoints?: EndpointAccumulator;
};

/** Public/private visibility of a class member from its TS modifiers. */
function memberVisibility(member: ts.ClassElement): "public" | "private" {
    const flags = ts.getCombinedModifierFlags(member);
    return (flags & ts.ModifierFlags.Private) || (flags & ts.ModifierFlags.Protected) ? "private" : "public";
}

/**
 * Resolve member-name collisions among behaviors (methods, setters, getters). A
 * getter and a setter of the same name are allowed (an accessor get/set pair); a
 * setter may also share a name with a stored field. Everything else collides: two
 * getters, two setters, a method colliding with anything, or a getter colliding
 * with a stored field. Drops conflicting behaviors with KEYMA040.
 */
function dedupeMethods(
    rawMethods: IRMethod[],
    fields: IRField[],
    ctx: ExtractContext,
    _sourceFile: ts.SourceFile,
): IRMethod[] {
    const fieldNames = new Set(fields.map((f) => f.name));
    const seen = new Map<string, Partial<Record<IRMethod["kind"], true>>>();
    const result: IRMethod[] = [];
    for (const m of rawMethods) {
        // A method may not share a name with a stored field; a getter may not
        // either (both would define the same member on the class). A setter for a
        // stored field is allowed.
        if ((m.kind === "method" || m.kind === "getter") && fieldNames.has(m.name)) {
            ctx.diagnostics.push(mkError(KEYMA040, `${m.kind === "method" ? "Method" : "Getter"} "${m.name}" conflicts with a field of the same name`, m.source));
            continue;
        }
        const prior: Partial<Record<IRMethod["kind"], true>> = seen.get(m.name) ?? {};
        // A getter pairs only with a setter; a setter pairs only with a getter.
        const conflict =
            (m.kind === "method" && (prior.getter || prior.setter || prior.method)) ||
            (m.kind === "getter" && (prior.getter || prior.method)) ||
            (m.kind === "setter" && (prior.setter || prior.method));
        if (conflict) {
            ctx.diagnostics.push(mkError(KEYMA040, `Duplicate member name "${m.name}"`, m.source));
            continue;
        }
        prior[m.kind] = true;
        seen.set(m.name, prior);
        result.push(m);
    }
    return result;
}

function extractField(
    member: ts.PropertyDeclaration,
    ctx: FieldExtractContext
): IRField | null {
    const sf = ctx.sourceFile;
    const fieldName = (member.name as ts.Identifier).text;

    // Visibility from modifiers
    const modFlags = ts.getCombinedModifierFlags(member);
    const isPrivate = !!(modFlags & ts.ModifierFlags.Private) || !!(modFlags & ts.ModifierFlags.Protected);
    const isReadonly = !!(modFlags & ts.ModifierFlags.Readonly);
    const visibility: "public" | "private" = isPrivate ? "private" : "public";

    // Is the key optional? (`?` modifier — the presence axis; `| undefined` in the
    // type also feeds this, captured from the mapped type below)
    const isOptional = "questionToken" in member && member.questionToken !== undefined;

    // `@Computed()` only ever belongs on a getter (handled as a behavior); on a
    // plain property it is a misuse.
    const hasComputed = (ts.getDecorators(member) ?? []).some(
        (d) => ts.isCallExpression(d.expression) && getDecoratorIdentifierName(d.expression, ctx) === "Computed",
    );

    if (hasComputed) {
        ctx.diagnostics.push(
            mkError(
                KEYMA019,
                `@Computed() can only be applied to a getter — field "${fieldName}" is a plain property`,
                getLocation(member, sf),
            ),
        );
        return null;
    }

    const prop = member as ts.PropertyDeclaration;

    // Type
    if (!prop.type) {
        // No explicit type annotation — we can't map it
        ctx.diagnostics.push(
            mkError("KEYMA010", `Field "${fieldName}" must have an explicit type annotation`, getLocation(prop, sf))
        );
        return null;
    }

    const typeResult = mapTypeNode(prop.type, {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
        ...(ctx.enums !== undefined && { enums: ctx.enums }),
        diagnostics: ctx.diagnostics,
        sourceFile: sf,
    });

    if ("diag" in typeResult) {
        ctx.diagnostics.push(typeResult.diag);
        return null;
    }

    let irType = typeResult.type;

    // Decorators
    const decorators = ts.getDecorators(prop) ?? [];
    const validators: IRValidator[] = [];
    const formatters: IRFormatter[] = [];
    const fieldIndexes: IRFieldIndex[] = [];
    let ephemeral = false;
    let isEndpoint = false;
    let defaultValue: IRDefault | undefined;
    let form: IRFormField | undefined;
    let deprecated: boolean | string | undefined;
    // Binary tag hints (consumed by the assignTags pass when binary is enabled; otherwise
    // stripped). `tagPin` is an explicit @Tag(n); `renamedFrom` carries a tag across a rename.
    let tagPin: number | undefined;
    let renamedFrom: string | undefined;

    const lowerCtx = {
        checker: ctx.checker,
        diagnostics: ctx.diagnostics,
        sourceFile: sf,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
        ...(ctx.resolveValidator !== undefined && { resolveValidator: ctx.resolveValidator }),
        ...(ctx.resolveFormatter !== undefined && { resolveFormatter: ctx.resolveFormatter }),
        ...(ctx.classifyFunction !== undefined && { classifyFunction: ctx.classifyFunction }),
    };

    for (const deco of decorators) {
        if (!ts.isDecorator(deco)) continue;
        const expr = deco.expression;
        if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) continue;
        const decoName = getDecoratorIdentifierName(expr, ctx);
        if (!decoName) continue;

        if (decoName === "Validate") {
            const vs = lowerValidateArgs(expr.arguments, lowerCtx);
            validators.push(...vs);
        } else if (decoName === "Format") {
            const fs = lowerFormatArgs(expr.arguments, lowerCtx);
            for (const { phase, spec } of fs) {
                formatters.push({ phase: phase as IRFormatter["phase"], spec });
            }
        } else if (decoName === "Indexed") {
            const idx = lowerIndexedArgs(expr.arguments, lowerCtx);
            if (idx !== null) fieldIndexes.push(idx);
        } else if (decoName === "Ephemeral") {
            ephemeral = true;
        } else if (decoName === "FormField") {
            form = lowerFormFieldArg(expr.arguments, lowerCtx);
        } else if (decoName === "Deprecated") {
            const reasonNode = expr.arguments[0];
            deprecated = reasonNode !== undefined ? (stringLiteralValue(reasonNode) ?? true) : true;
        } else if (decoName === "Tag") {
            const arg = expr.arguments[0];
            const n = arg !== undefined ? numericLiteralValue(arg) : undefined;
            if (n === undefined || !Number.isInteger(n) || n < 1 || n > 2147483647) {
                ctx.diagnostics.push(
                    mkError(
                        KEYMA102,
                        `@Tag on field "${fieldName}" must be a positive integer literal in range 1..2147483647`,
                        getLocation(prop, sf),
                    ),
                );
            } else {
                tagPin = n;
            }
        } else if (decoName === "RenamedFrom") {
            const arg = expr.arguments[0];
            const old = arg !== undefined ? stringLiteralValue(arg) : undefined;
            if (old !== undefined && old !== "") renamedFrom = old;
        } else if (decoName === "From" || decoName === "To") {
            isEndpoint = true;
            const bucket = decoName === "From" ? ctx.endpoints?.fromFields : ctx.endpoints?.toFields;
            bucket?.push(fieldName);
        }
    }

    // Edge endpoint fields (@From()/@To()) are indexed automatically so the
    // user need not add @Indexed; an explicit @Indexed still wins.
    if (isEndpoint && fieldIndexes.length === 0) {
        fieldIndexes.push({});
    }

    // Promote number → integer if @Validate(isInteger) is present
    if (irType.kind === "number" && validators.some((v) => v.name === "integer")) {
        irType = { kind: "integer" };
    }

    // Default value from the field's TypeScript property initializer (`= <expr>`).
    if (prop.initializer !== undefined) {
        const d = lowerInitializerDefault(prop.initializer, irType, lowerCtx);
        if (d !== null) defaultValue = d;
    }

    const field: IRField = {
        name: fieldName,
        type: irType,
        visibility,
        readonly: isReadonly,
        required: !(isOptional || typeResult.optional === true),
        source: getLocation(prop, sf),
    };
    if (typeResult.nullable === true) field.nullable = true;
    if (defaultValue !== undefined) field.default = defaultValue;
    // `@FormField` presentational metadata is UI-domain data — it rides in the field's
    // `extensions['ui']` slice, not on the domain-neutral core IRField.
    setFieldForm(field, form);
    if (deprecated !== undefined) field.deprecated = deprecated;
    // Stash the binary tag hints. `tag` (the @Tag pin) is a real IRField property; the
    // assignTags pass reinterprets a pre-existing `tag` as a manual pin. `renamedFrom` is a
    // frontend-transient property the pass consumes and deletes (never reaches the IR / backends).
    if (tagPin !== undefined) field.tag = tagPin;
    if (renamedFrom !== undefined) (field as RawTaggedField).renamedFrom = renamedFrom;

    // Schema-domain per-field metadata (indexes + ephemeral + validator/formatter
    // attachments) rides in the field's `extensions['schema']` slice — "which function
    // validates/formats this field, in which phase" is irreducibly schema-semantic, so it
    // is not part of the domain-neutral core IRField. `extractSchema`'s composite-index pass
    // later re-filters the index list (keyed entries are hoisted to schema-level indexes).
    const fExt: FieldExtData = {};
    if (fieldIndexes.length > 0) fExt.indexes = fieldIndexes;
    if (ephemeral) fExt.ephemeral = true;
    if (validators.length > 0) fExt.validators = validators;
    if (formatters.length > 0) fExt.formatters = formatters;
    setFieldExtSlice(field, fExt);

    return field;
}

/**
 * Lower a getter to an `IRMethod` behavior (`kind: "getter"`) — a re-emitted class
 * accessor, NOT a schema field. The body lowers the full portable statement subset
 * (`const`/`if`/`return`) and must reach a `return` (KEYMA014). Field-only decorators
 * on a getter (`@Computed`, `@Indexed`,
 * `@FormField`, `@Deprecated`) carry no behavior meaning yet: computed-field support
 * (storage / indexing / materialization) is deferred to a future release, so they
 * are ignored with a single KEYMA098 warning and the getter is emitted as a plain
 * accessor.
 */
function lowerGetter(
    getter: ts.GetAccessorDeclaration,
    fieldName: string,
    visibility: "public" | "private",
    ctx: FieldExtractContext
): IRMethod | null {
    const sf = ctx.sourceFile;

    // Lower the body to portable statements (shared portable engine, field-reference mode).
    const statements = lowerGetterBody(getter, {
        diagnostics: ctx.diagnostics,
        sourceFile: sf,
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
    });
    if (statements === null) {
        return null;
    }

    // Return type from the getter's annotation (defaults to string when absent).
    let returnType: IRType = { kind: "string" };
    if (getter.type) {
        const typeResult = mapTypeNode(getter.type, {
            checker: ctx.checker,
            dslModuleName: ctx.dslModuleName,
            schemaClassNames: ctx.schemaClassNames,
            ...(ctx.enums !== undefined && { enums: ctx.enums }),
            diagnostics: ctx.diagnostics,
            sourceFile: sf,
        });
        if ("diag" in typeResult) {
            ctx.diagnostics.push(typeResult.diag);
        } else {
            returnType = typeResult.type;
        }
    }

    // Warn that field-only decorators on the getter are ignored (deferred feature).
    const deferred: string[] = [];
    for (const deco of ts.getDecorators(getter) ?? []) {
        if (!ts.isDecorator(deco)) continue;
        const dexpr = deco.expression;
        if (!ts.isCallExpression(dexpr) || !ts.isIdentifier(dexpr.expression)) continue;
        const decoName = getDecoratorIdentifierName(dexpr, ctx);
        if (decoName === "Computed" || decoName === "Indexed" || decoName === "FormField" || decoName === "Deprecated") {
            const label = `@${decoName}`;
            if (!deferred.includes(label)) deferred.push(label);
        }
    }
    if (deferred.length > 0) {
        ctx.diagnostics.push(
            mkWarning(
                KEYMA098,
                `Getter "${fieldName}": ${deferred.join(", ")} ignored — computed-field support (storage/indexing/materialization) is deferred to a future release; the getter is emitted as a plain accessor`,
                getLocation(getter, sf),
            ),
        );
    }

    return {
        name: fieldName,
        kind: "getter",
        params: [],
        returnType,
        statements,
        visibility,
        source: getLocation(getter, sf),
    };
}

/** Get the identifier name of a decorator's callee, verifying it's from the DSL module. */
function getDecoratorIdentifierName(
    callExpr: ts.CallExpression,
    ctx: FieldExtractContext
): string | null {
    if (!ts.isIdentifier(callExpr.expression)) return null;
    const ident = callExpr.expression;
    const symbol = ctx.checker.getSymbolAtLocation(ident);
    if (!symbol) return null;
    if (isFromModule(symbol, ctx.checker, ctx.dslModuleName)) {
        return ident.text;
    }
    // Accept it if symbol resolution fails (e.g. user wrote @Validate without importing from DSL)
    return null;
}
