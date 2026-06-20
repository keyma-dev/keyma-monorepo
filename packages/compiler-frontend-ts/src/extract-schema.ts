import ts from "typescript";
import type {
    IRSchema, IRField, IRType, IRValidator, IRFormatter, IRFieldIndex, IRIndex, IRDiagnostic, IREdge, IRDefault, IRFormField, IRMethod,
} from "@keyma/ir";
import { mkError, mkWarning, KEYMA017, KEYMA019, KEYMA040, KEYMA061, KEYMA065, KEYMA066 } from "./diagnostics.js";
import { getLocation, isFromModule, stringLiteralValue } from "./util.js";
import { mapTypeNode } from "./map-type.js";
import { lowerValidateArgs, lowerFormatArgs, lowerIndexedArgs, lowerInitializerDefault, lowerFormFieldArg } from "./lower-decorator.js";
import { lowerGetterBody } from "./lower-expression.js";
import { lowerMethod, lowerSetter, type MethodLowerCtx } from "./lower-method.js";
import type { FnRefVerdict } from "./lower-portable-expr.js";
import type { ResolvedFactory } from "./discover-validators.js";
import type { DiscoveredSchema } from "./discover.js";
import type { EnumInfo } from "./discover-enums.js";

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
 * Extract an IRSchema from a discovered class. The schema contains only the
 * class's own fields (not inherited). Flattening happens in a later pass.
 */
export function extractSchema(
    discovered: DiscoveredSchema,
    ctx: ExtractContext
): IRSchema {
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
        if (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
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
        } else if (ts.isMethodDeclaration(member)) {
            if (!member.name || !ts.isIdentifier(member.name)) continue;
            const m = lowerMethod(member, member.name.text, memberVisibility(member), methodCtx);
            if (m) rawMethods.push(m);
        } else if (ts.isSetAccessorDeclaration(member)) {
            if (!member.name || !ts.isIdentifier(member.name)) continue;
            const m = lowerSetter(member, member.name.text, memberVisibility(member), methodCtx);
            if (m) rawMethods.push(m);
        }
        // Skip the constructor, get accessors handled as fields, static members, etc.
    }

    const methods = dedupeMethods(rawMethods, fields, ctx, sourceFile);

    // Group keyed field indexes into schema-level composite IRIndex entries.
    // Fields appear in declaration order, so the iteration order is already correct.
    const compositeGroups = new Map<string, Array<{ fieldName: string; idx: IRFieldIndex }>>();
    for (const field of fields) {
        const keyed = field.indexes.filter((idx) => idx.key !== undefined);
        for (const idx of keyed) {
            const key = idx.key!;
            if (!compositeGroups.has(key)) compositeGroups.set(key, []);
            compositeGroups.get(key)!.push({ fieldName: field.name, idx });
        }
        // Keyed entries live only in schema.indexes, not on the field.
        field.indexes = field.indexes.filter((idx) => idx.key === undefined);
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

    const schema: IRSchema = {
        id: `schema:${name}`,
        name,
        sourceName: className,
        visibility,
        fields,
        indexes: compositeIndexes,
        source: discovered.source,
    };

    if (methods.length > 0) {
        schema.methods = methods;
    }
    if (schemaOptions.ephemeral === true) {
        schema.ephemeral = true;
    }
    if (schemaOptions.description !== undefined) {
        schema.description = schemaOptions.description;
    }
    if (discovered.parentClassName !== undefined) {
        schema.extends = discovered.parentClassName;
    }
    if (discovered.edgeOptions !== undefined) {
        const edge = deriveEdge(schema, endpoints, discovered.edgeOptions.directed ?? true, ctx);
        if (edge !== undefined) schema.edge = edge;
    }

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
    schema: IRSchema,
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
 * Resolve member-name collisions among methods/setters. A setter may legitimately
 * share a name with a field (a stored field or a `@Computed` getter — the get/set
 * pair); a method may not. Duplicate method/setter names collide regardless. Drops
 * conflicting behaviors with KEYMA040.
 */
function dedupeMethods(
    rawMethods: IRMethod[],
    fields: IRField[],
    ctx: ExtractContext,
    sourceFile: ts.SourceFile,
): IRMethod[] {
    const fieldNames = new Set(fields.map((f) => f.name));
    const seen = new Set<string>();
    const result: IRMethod[] = [];
    for (const m of rawMethods) {
        if (seen.has(m.name)) {
            ctx.diagnostics.push(mkError(KEYMA040, `Duplicate member name "${m.name}"`, m.source));
            continue;
        }
        if (m.kind === "method" && fieldNames.has(m.name)) {
            ctx.diagnostics.push(mkError(KEYMA040, `Method "${m.name}" conflicts with a field of the same name`, m.source));
            continue;
        }
        seen.add(m.name);
        result.push(m);
    }
    return result;
}

function extractField(
    member: ts.PropertyDeclaration | ts.GetAccessorDeclaration,
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

    // Computed getter vs. regular property. Computed fields must be opted in with
    // `@Computed()` so the intent is explicit.
    const isGetter = ts.isGetAccessorDeclaration(member);
    const hasComputed = (ts.getDecorators(member) ?? []).some(
        (d) => ts.isCallExpression(d.expression) && getDecoratorIdentifierName(d.expression, ctx) === "Computed",
    );

    if (isGetter) {
        if (!hasComputed) {
            ctx.diagnostics.push(
                mkWarning(
                    KEYMA019,
                    `Getter "${fieldName}" is ignored — decorate it with @Computed() to expose it as a computed field`,
                    getLocation(member, sf),
                ),
            );
            return null;
        }
        return extractComputedField(member as ts.GetAccessorDeclaration, fieldName, visibility, isOptional, ctx);
    }

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
        validators,
        formatters,
        indexes: fieldIndexes,
        source: getLocation(prop, sf),
    };
    if (typeResult.nullable === true) field.nullable = true;
    if (ephemeral) field.ephemeral = true;
    if (defaultValue !== undefined) field.default = defaultValue;
    if (form !== undefined) field.form = form;
    if (deprecated !== undefined) field.deprecated = deprecated;

    return field;
}

function extractComputedField(
    getter: ts.GetAccessorDeclaration,
    fieldName: string,
    visibility: "public" | "private",
    isOptional: boolean,
    ctx: FieldExtractContext
): IRField | null {
    const sf = ctx.sourceFile;
    let typeNullable = false;
    let typeOptional = false;

    // A getter/setter pair is allowed: the getter becomes a computed field and the
    // setter is collected separately as a behavior (see dedupeMethods).

    // Determine type from the getter's return type annotation (if present)
    let irType: import("@keyma/ir").IRType = { kind: "string" }; // default
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
            irType = typeResult.type;
            typeNullable = typeResult.nullable === true;
            typeOptional = typeResult.optional === true;
        }
    }

    // Lower the getter body to an expression (shared portable engine, field mode)
    const expr = lowerGetterBody(getter, {
        diagnostics: ctx.diagnostics,
        sourceFile: sf,
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
    });
    if (expr === null) {
        return null;
    }

    // Read @Indexed / @FormField / @Deprecated decorators from the getter
    const fieldIndexes: IRFieldIndex[] = [];
    let form: IRFormField | undefined;
    let deprecated: boolean | string | undefined;
    const lowerCtx = {
        checker: ctx.checker,
        diagnostics: ctx.diagnostics,
        sourceFile: sf,
        dslModuleName: ctx.dslModuleName,
        ...(ctx.resolveValidator !== undefined && { resolveValidator: ctx.resolveValidator }),
        ...(ctx.resolveFormatter !== undefined && { resolveFormatter: ctx.resolveFormatter }),
    };

    for (const deco of ts.getDecorators(getter) ?? []) {
        if (!ts.isDecorator(deco)) continue;
        const expr = deco.expression;
        if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) continue;
        const decoName = getDecoratorIdentifierName(expr, ctx);
        if (decoName === "Indexed") {
            const idx = lowerIndexedArgs(expr.arguments, lowerCtx);
            if (idx !== null) fieldIndexes.push(idx);
        } else if (decoName === "FormField") {
            form = lowerFormFieldArg(expr.arguments, lowerCtx);
        } else if (decoName === "Deprecated") {
            const reasonNode = expr.arguments[0];
            deprecated = reasonNode !== undefined ? (stringLiteralValue(reasonNode) ?? true) : true;
        }
    }

    const field: IRField = {
        name: fieldName,
        type: irType,
        visibility,
        readonly: true,
        required: !(isOptional || typeOptional),
        validators: [],
        formatters: [],
        indexes: fieldIndexes,
        computed: { expression: expr },
        source: getLocation(getter, sf),
    };
    if (typeNullable) field.nullable = true;
    if (form !== undefined) field.form = form;
    if (deprecated !== undefined) field.deprecated = deprecated;

    return field;
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
