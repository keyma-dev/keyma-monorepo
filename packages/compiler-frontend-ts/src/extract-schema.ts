import ts from "typescript";
import type {
    IRSchema, IRField, IRValidator, IRFormatter, IRFieldIndex, IRIndex, IRDiagnostic, IREdge,
} from "@keyma/ir";
import { mkError, mkWarning, KEYMA015, KEYMA017, KEYMA040 } from "./diagnostics.js";
import { getLocation, isFromModule } from "./util.js";
import { mapTypeNode } from "./map-type.js";
import { lowerValidateArgs, lowerFormatArgs, lowerIndexedArgs } from "./lower-decorator.js";
import { lowerGetterBody } from "./lower-expression.js";
import type { DiscoveredSchema } from "./discover.js";

type ExtractContext = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
    diagnostics: IRDiagnostic[];
    /** Optional: maps function name → validator name from @Validator-decorated declarations. */
    discoveredValidators?: Map<string, string>;
    /** Optional: maps function name → formatter name from @Formatter-decorated declarations. */
    discoveredFormatters?: Map<string, string>;
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

    const fieldCtx = {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
        diagnostics: ctx.diagnostics,
        sourceFile,
    };

    const seenNames = new Set<string>();
    const fields: IRField[] = [];

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
        }
        // Skip MethodDeclaration, SetAccessorDeclaration, constructor, etc.
    }

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
        const eo = discovered.edgeOptions;
        const edge: IREdge = {
            from: eo.fromClassName,
            fromField: eo.fromField ?? "from",
            to: eo.toClassName,
            toField: eo.toField ?? "to",
            label: eo.label ?? className,
            directed: eo.directed ?? true,
        };
        schema.edge = edge;
    }

    return schema;
}

type FieldExtractContext = ExtractContext & {
    sourceFile: ts.SourceFile;
};

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

    // Is it optional? (has ?)
    const isOptional = "questionToken" in member && member.questionToken !== undefined;
    const required = !isOptional;

    // Computed getter vs. regular property
    const isGetter = ts.isGetAccessorDeclaration(member);

    if (isGetter) {
        return extractComputedField(member as ts.GetAccessorDeclaration, fieldName, visibility, required, ctx);
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

    const lowerCtx = {
        checker: ctx.checker,
        diagnostics: ctx.diagnostics,
        sourceFile: sf,
        dslModuleName: ctx.dslModuleName,
        ...(ctx.discoveredValidators !== undefined && { discoveredValidators: ctx.discoveredValidators }),
        ...(ctx.discoveredFormatters !== undefined && { discoveredFormatters: ctx.discoveredFormatters }),
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
        }
    }

    // Promote number → integer if @Validate(isInteger) is present
    if (irType.kind === "number" && validators.some((v) => v.name === "integer")) {
        irType = { kind: "integer" };
    }

    const field: IRField = {
        name: fieldName,
        type: irType,
        visibility,
        readonly: isReadonly,
        required,
        validators,
        formatters,
        indexes: fieldIndexes,
        source: getLocation(prop, sf),
    };
    if (ephemeral) field.ephemeral = true;

    return field;
}

function extractComputedField(
    getter: ts.GetAccessorDeclaration,
    fieldName: string,
    visibility: "public" | "private",
    required: boolean,
    ctx: FieldExtractContext
): IRField | null {
    const sf = ctx.sourceFile;

    // Must not have a setter
    const parentClass = getter.parent;
    if (ts.isClassDeclaration(parentClass) || ts.isClassExpression(parentClass)) {
        const hasSetter = parentClass.members.some(
            (m): m is ts.SetAccessorDeclaration =>
                ts.isSetAccessorDeclaration(m) &&
                ts.isIdentifier(m.name) &&
                m.name.text === fieldName
        );
        if (hasSetter) {
            ctx.diagnostics.push(
                mkError(KEYMA015, `Computed getter "${fieldName}" must not have a setter`, getLocation(getter, sf))
            );
            return null;
        }
    }

    // Determine type from the getter's return type annotation (if present)
    let irType: import("@keyma/ir").IRType = { kind: "string" }; // default
    if (getter.type) {
        const typeResult = mapTypeNode(getter.type, {
            checker: ctx.checker,
            dslModuleName: ctx.dslModuleName,
            schemaClassNames: ctx.schemaClassNames,
            diagnostics: ctx.diagnostics,
            sourceFile: sf,
        });
        if ("diag" in typeResult) {
            ctx.diagnostics.push(typeResult.diag);
        } else {
            irType = typeResult.type;
        }
    }

    // Lower the getter body to an expression
    const exprResult = lowerGetterBody(getter, { diagnostics: ctx.diagnostics, sourceFile: sf });
    if ("diag" in exprResult) {
        ctx.diagnostics.push(exprResult.diag);
        return null;
    }

    // Read @Indexed decorator from the getter
    const fieldIndexes: IRFieldIndex[] = [];
    const lowerCtx = {
        checker: ctx.checker,
        diagnostics: ctx.diagnostics,
        sourceFile: sf,
        dslModuleName: ctx.dslModuleName,
        ...(ctx.discoveredValidators !== undefined && { discoveredValidators: ctx.discoveredValidators }),
        ...(ctx.discoveredFormatters !== undefined && { discoveredFormatters: ctx.discoveredFormatters }),
    };

    for (const deco of ts.getDecorators(getter) ?? []) {
        if (!ts.isDecorator(deco)) continue;
        const expr = deco.expression;
        if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) continue;
        const decoName = getDecoratorIdentifierName(expr, ctx);
        if (decoName === "Indexed") {
            const idx = lowerIndexedArgs(expr.arguments, lowerCtx);
            if (idx !== null) fieldIndexes.push(idx);
        }
    }

    const field: IRField = {
        name: fieldName,
        type: irType,
        visibility,
        readonly: true,
        required,
        validators: [],
        formatters: [],
        indexes: fieldIndexes,
        computed: { expression: exprResult.expr },
        source: getLocation(getter, sf),
    };

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
