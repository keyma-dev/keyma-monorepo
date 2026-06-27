import ts from "typescript";
import type {
    IRClassDeclaration, IRMember, IRMethod, IRType, IRDefault, IRDiagnostic,
} from "@keyma/core/ir";
import { mapTypeNode } from "./map-type.js";
import { lowerMethod, lowerSetter, lowerConstructor, lowerDestructor, type MethodLowerCtx } from "./lower-method.js";
import { lowerGetterBody } from "./lower-expression.js";
import { lowerInitializerDefault } from "./lower-default.js";
import { getLocation, isCoreDslSymbol, stringLiteralValue, numericLiteralValue } from "./util.js";
import { mkError, mkWarning, KEYMA010, KEYMA040, KEYMA098, KEYMA102 } from "./diagnostics.js";
import type { RawTaggedField } from "./assign-tags.js";
import type { EnumInfo } from "./discover-enums.js";
import type { FnRefVerdict } from "./lower-portable-expr.js";

/** Recognize a decorator as a registered domain/core Keyma decorator → its identifier name,
 *  or `undefined` when it is not a Keyma decorator. The compiler driver builds this from the
 *  registered domains' decorators + the core decorator identities. */
export type DecoratorRecognizer = (deco: ts.Decorator) => string | undefined;

/** Inputs the base class-lowering needs — all domain-neutral. */
export type LowerClassContext = {
    checker: ts.TypeChecker;
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    /** DSL module for type recognition (canonically `@keyma/core/dsl`). */
    dslModuleName: string;
    /** All lowered class sourceNames — for `Reference<T>`/`Embedded<T>`/bare-class resolution. */
    classNames: ReadonlySet<string>;
    enums: ReadonlyMap<string, EnumInfo>;
    /** Shared function collector classifier (for utility fns referenced in method/default bodies). */
    classify?: (ident: ts.Identifier) => FnRefVerdict;
    /** Recognize a Keyma decorator (used for the getter field-only-decorator deferral). */
    recognize: DecoratorRecognizer;
};

/** The base IR plus the field↔node correlation the driver needs to dispatch domain decorators. */
export type LowerClassResult = {
    ir: IRClassDeclaration;
    classNode: ts.ClassDeclaration;
    /** (stored-field IRMember, its property declaration) — for domain member-decorator dispatch. */
    fieldNodes: Array<{ member: IRMember; node: ts.PropertyDeclaration }>;
};

/**
 * Build the domain-neutral base `IRClassDeclaration` for one class declaration: its stored fields
 * (typed, with visibility/readonly/optional/nullable/defaults), its behaviors (methods, getters,
 * setters, constructor, destructor), its `extends` link, and the core decorators
 * (`@Tag`/`@RenamedFrom`/`@Deprecated`). The class `name` defaults to the lowercased class
 * identifier and `visibility` to public; a domain's class decorator (`@Schema`/`@Edge`) overrides
 * these and enriches the node. Returns `null` for an anonymous class declaration.
 */
export function lowerClass(
    classNode: ts.ClassDeclaration,
    ctx: LowerClassContext,
): LowerClassResult | null {
    if (!classNode.name) return null;
    const className = classNode.name.text;
    const sourceFile = ctx.sourceFile;

    const methodCtx: MethodLowerCtx = {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        classNames: ctx.classNames,
        enums: ctx.enums,
        diagnostics: ctx.diagnostics,
        sourceFile,
        ...(ctx.classify !== undefined ? { classifyFunction: ctx.classify } : {}),
    };

    const seenNames = new Set<string>();
    const fields: IRMember[] = [];
    const fieldNodes: Array<{ member: IRMember; node: ts.PropertyDeclaration }> = [];
    const rawMethods: IRMethod[] = [];

    for (const member of classNode.members) {
        if (ts.isPropertyDeclaration(member)) {
            if (!member.name || !ts.isIdentifier(member.name)) continue;
            const fieldName = member.name.text;
            if (seenNames.has(fieldName)) {
                ctx.diagnostics.push(
                    mkError(KEYMA040, `Duplicate field name "${fieldName}"`, getLocation(member.name, sourceFile)),
                );
                continue;
            }
            seenNames.add(fieldName);
            const field = lowerField(member, ctx);
            if (field) {
                fields.push(field);
                fieldNodes.push({ member: field, node: member });
            }
        } else if (ts.isGetAccessorDeclaration(member)) {
            // Getters are behaviors (re-emitted accessors), not stored fields.
            if (!member.name || !ts.isIdentifier(member.name)) continue;
            const g = lowerGetter(member, member.name.text, memberVisibility(member), ctx);
            if (g) rawMethods.push(g);
        } else if (ts.isMethodDeclaration(member)) {
            if (!member.name || !ts.isIdentifier(member.name)) continue;
            const methodName = member.name.text;
            // A method literally named `destructor` is the finalizer authoring convention.
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

    const methods = dedupeMethods(rawMethods, fields, ctx.diagnostics);

    const ir: IRClassDeclaration = {
        name: className.toLowerCase(),
        sourceName: className,
        visibility: "public",
        fields,
        source: getLocation(classNode.name, sourceFile),
    };
    if (methods.length > 0) ir.methods = methods;
    const parentClassName = parentOf(classNode);
    if (parentClassName !== undefined) ir.extends = parentClassName;

    return { ir, classNode, fieldNodes };
}

/** Public/private visibility of a class member from its TS modifiers. */
export function memberVisibility(member: ts.ClassElement): "public" | "private" {
    const flags = ts.getCombinedModifierFlags(member);
    return (flags & ts.ModifierFlags.Private) || (flags & ts.ModifierFlags.Protected) ? "private" : "public";
}

/** The single `extends` parent class identifier, or undefined. */
function parentOf(node: ts.ClassDeclaration): string | undefined {
    if (!node.heritageClauses) return undefined;
    for (const clause of node.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        const parentRef = clause.types[0];
        if (!parentRef) continue;
        const parentExpr = parentRef.expression;
        if (!ts.isIdentifier(parentExpr)) continue;
        return parentExpr.text;
    }
    return undefined;
}

/** Lower the base IRMember for a stored property — type, visibility, modifiers, default, and the
 *  core `@Tag`/`@RenamedFrom`/`@Deprecated` decorators. Domain member decorators are NOT processed
 *  here (the driver dispatches them to the owning domain's handlers afterward). */
function lowerField(member: ts.PropertyDeclaration, ctx: LowerClassContext): IRMember | null {
    const sf = ctx.sourceFile;
    const fieldName = (member.name as ts.Identifier).text;

    const modFlags = ts.getCombinedModifierFlags(member);
    const isPrivate = !!(modFlags & ts.ModifierFlags.Private) || !!(modFlags & ts.ModifierFlags.Protected);
    const isReadonly = !!(modFlags & ts.ModifierFlags.Readonly);
    const visibility: "public" | "private" = isPrivate ? "private" : "public";
    const isOptional = "questionToken" in member && member.questionToken !== undefined;

    if (!member.type) {
        ctx.diagnostics.push(
            mkError(KEYMA010, `Field "${fieldName}" must have an explicit type annotation`, getLocation(member, sf)),
        );
        return null;
    }

    const typeResult = mapTypeNode(member.type, {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        classNames: ctx.classNames,
        enums: ctx.enums,
        diagnostics: ctx.diagnostics,
        sourceFile: sf,
    });
    if ("diag" in typeResult) {
        ctx.diagnostics.push(typeResult.diag);
        return null;
    }
    const irType: IRType = typeResult.type;

    // Core decorators — recognized by their `@keyma/core/dsl` identity regardless of which
    // umbrella the author imported them through.
    let deprecated: boolean | string | undefined;
    let tagPin: number | undefined;
    let renamedFrom: string | undefined;
    for (const deco of ts.getDecorators(member) ?? []) {
        const expr = deco.expression;
        const ident = ts.isCallExpression(expr) ? expr.expression : expr;
        if (!ts.isIdentifier(ident)) continue;
        const symbol = ctx.checker.getSymbolAtLocation(ident);
        if (symbol === undefined) continue;
        const args = ts.isCallExpression(expr) ? expr.arguments : undefined;
        if (isCoreDslSymbol(symbol, ctx.checker, "Deprecated")) {
            const reasonNode = args?.[0];
            deprecated = reasonNode !== undefined ? (stringLiteralValue(reasonNode) ?? true) : true;
        } else if (isCoreDslSymbol(symbol, ctx.checker, "Tag")) {
            const arg = args?.[0];
            const n = arg !== undefined ? numericLiteralValue(arg) : undefined;
            if (n === undefined || !Number.isInteger(n) || n < 1 || n > 2147483647) {
                ctx.diagnostics.push(
                    mkError(
                        KEYMA102,
                        `@Tag on field "${fieldName}" must be a positive integer literal in range 1..2147483647`,
                        getLocation(member, sf),
                    ),
                );
            } else {
                tagPin = n;
            }
        } else if (isCoreDslSymbol(symbol, ctx.checker, "RenamedFrom")) {
            const arg = args?.[0];
            const old = arg !== undefined ? stringLiteralValue(arg) : undefined;
            if (old !== undefined && old !== "") renamedFrom = old;
        }
    }

    // Default value from the field's TypeScript property initializer (`= <expr>`).
    let defaultValue: IRDefault | undefined;
    if (member.initializer !== undefined) {
        const d = lowerInitializerDefault(member.initializer, irType, {
            checker: ctx.checker,
            diagnostics: ctx.diagnostics,
            sourceFile: sf,
            dslModuleName: ctx.dslModuleName,
            classNames: ctx.classNames,
            ...(ctx.classify !== undefined ? { classify: ctx.classify } : {}),
        });
        if (d !== null) defaultValue = d;
    }

    const field: IRMember = {
        name: fieldName,
        type: irType,
        visibility,
        readonly: isReadonly,
        required: !(isOptional || typeResult.optional === true),
        source: getLocation(member, sf),
    };
    if (typeResult.nullable === true) field.nullable = true;
    if (defaultValue !== undefined) field.default = defaultValue;
    if (deprecated !== undefined) field.deprecated = deprecated;
    if (tagPin !== undefined) field.tag = tagPin;
    if (renamedFrom !== undefined) (field as RawTaggedField).renamedFrom = renamedFrom;

    return field;
}

/**
 * Lower a getter to an `IRMethod` behavior (`kind: "getter"`). The body lowers the portable
 * statement subset and must reach a `return` (KEYMA014, emitted by the body engine). Any
 * field-only decorator on a getter (recognized via `ctx.recognize`) carries no behavior meaning
 * yet — computed-field support is deferred — so it is ignored with a single KEYMA098 warning and
 * the getter is emitted as a plain accessor.
 */
function lowerGetter(
    getter: ts.GetAccessorDeclaration,
    fieldName: string,
    visibility: "public" | "private",
    ctx: LowerClassContext,
): IRMethod | null {
    const sf = ctx.sourceFile;

    const statements = lowerGetterBody(getter, {
        diagnostics: ctx.diagnostics,
        sourceFile: sf,
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        classNames: ctx.classNames,
    });
    if (statements === null) return null;

    let returnType: IRType = { kind: "string" };
    if (getter.type) {
        const typeResult = mapTypeNode(getter.type, {
            checker: ctx.checker,
            dslModuleName: ctx.dslModuleName,
            classNames: ctx.classNames,
            enums: ctx.enums,
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
        const name = ctx.recognize(deco);
        if (name === undefined) continue;
        const label = `@${name}`;
        if (!deferred.includes(label)) deferred.push(label);
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

/**
 * Resolve member-name collisions among behaviors (methods, setters, getters). A getter/setter
 * pair of the same name is allowed; a setter may also share a name with a stored field.
 * Everything else collides (KEYMA040): two getters, two setters, a method colliding with anything,
 * or a getter colliding with a stored field.
 */
function dedupeMethods(rawMethods: IRMethod[], fields: IRMember[], diagnostics: IRDiagnostic[]): IRMethod[] {
    const fieldNames = new Set(fields.map((f) => f.name));
    const seen = new Map<string, Partial<Record<IRMethod["kind"], true>>>();
    const result: IRMethod[] = [];
    for (const m of rawMethods) {
        if ((m.kind === "method" || m.kind === "getter") && fieldNames.has(m.name)) {
            diagnostics.push(mkError(KEYMA040, `${m.kind === "method" ? "Method" : "Getter"} "${m.name}" conflicts with a field of the same name`, m.source));
            continue;
        }
        const prior: Partial<Record<IRMethod["kind"], true>> = seen.get(m.name) ?? {};
        const conflict =
            (m.kind === "method" && (prior.getter || prior.setter || prior.method)) ||
            (m.kind === "getter" && (prior.getter || prior.method)) ||
            (m.kind === "setter" && (prior.setter || prior.method));
        if (conflict) {
            diagnostics.push(mkError(KEYMA040, `Duplicate member name "${m.name}"`, m.source));
            continue;
        }
        prior[m.kind] = true;
        seen.set(m.name, prior);
        result.push(m);
    }
    return result;
}
