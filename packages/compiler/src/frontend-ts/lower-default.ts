import ts from "typescript";
import type { IRDefault, IRType, IRDiagnostic } from "@keyma/core/ir";
import { mkError, KEYMA090 } from "./diagnostics.js";
import { getLocation } from "./util.js";
import { lowerExpr, type FnRefVerdict } from "./lower-portable-expr.js";

/** Inputs for lowering a field's property initializer to an {@link IRDefault}. */
export type DefaultLowerContext = {
    checker: ts.TypeChecker;
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    /** DSL module for the portable expression engine (non-literal initializers). */
    dslModuleName: string;
    /** Lowered class names — enables portable lowering of non-literal initializers. */
    classNames: ReadonlySet<string>;
    /** Classify a call target inside an initializer so project-local utilities compile. */
    classify?: (ident: ts.Identifier) => FnRefVerdict;
};

/**
 * Lower a field's TypeScript property initializer (`= <expr>`) to an IRDefault — a base-language
 * concern (every lowered class, decorated or not, may carry property defaults). A literal
 * (`"active"`, `0`, `Role.Member`, `[...]`) lowers to `{kind:"literal"}` with a light
 * value-vs-type compatibility check (KEYMA090). Anything else (`(() => new Date())()`, `myFn()`,
 * …) lowers through the shared portable expression engine to `{kind:"expression"}`, to be
 * re-emitted and evaluated per record at create time. Returns null on error (diagnostic already
 * pushed).
 */
export function lowerInitializerDefault(
    init: ts.Expression,
    fieldType: IRType,
    ctx: DefaultLowerContext,
): IRDefault | null {
    // Enum-member / const access (e.g. `Role.Member`) that resolves to a literal.
    if (ts.isPropertyAccessExpression(init)) {
        const t = ctx.checker.getTypeAtLocation(init);
        const v = t.isStringLiteral() ? t.value : t.isNumberLiteral() ? t.value : undefined;
        if (v !== undefined) return literalDefault(v, fieldType, init, ctx);
        // A non-literal member access falls through to portable expression lowering.
    }

    // Plain literal initializers (string/number/boolean/null/array, negative numbers).
    if (isLiteralInitializer(init)) {
        const r = evalLiteralValue(init, ctx);
        if (!r.ok) return null;
        return literalDefault(r.value as string | number | boolean | null | unknown[], fieldType, init, ctx);
    }

    // Otherwise: a portable expression default, re-emitted and evaluated per record.
    const expr = lowerExpr(init, {
        diagnostics: ctx.diagnostics,
        sourceFile: ctx.sourceFile,
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        classNames: ctx.classNames,
        ...(ctx.classify !== undefined ? { classifyFunction: ctx.classify } : {}),
    });
    if (expr === null) return null;
    return { kind: "expression", expression: expr };
}

/** Build a literal IRDefault, checking value-vs-type compatibility (KEYMA090). */
function literalDefault(
    value: string | number | boolean | null | unknown[],
    fieldType: IRType,
    node: ts.Node,
    ctx: DefaultLowerContext,
): IRDefault | null {
    if (!literalMatchesType(value, fieldType)) {
        ctx.diagnostics.push(mkError(
            KEYMA090,
            `Default value ${JSON.stringify(value)} is not compatible with field type "${fieldType.kind}"`,
            getLocation(node, ctx.sourceFile),
        ));
        return null;
    }
    return { kind: "literal", value };
}

/** Whether an initializer is a plain literal handled by `evalLiteralValue`. */
function isLiteralInitializer(node: ts.Expression): boolean {
    switch (node.kind) {
        case ts.SyntaxKind.StringLiteral:
        case ts.SyntaxKind.NumericLiteral:
        case ts.SyntaxKind.TrueKeyword:
        case ts.SyntaxKind.FalseKeyword:
        case ts.SyntaxKind.NullKeyword:
            return true;
    }
    if (ts.isArrayLiteralExpression(node)) return true;
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)
    ) return true;
    return false;
}

/** A light compatibility check between a literal default and the field's type. */
function literalMatchesType(value: unknown, type: IRType): boolean {
    switch (type.kind) {
        case "json":
            return true; // any JSON value
        case "string": case "id": case "decimal": case "date": case "dateTime": case "time":
            return typeof value === "string";
        case "number": case "integer":
            return typeof value === "number";
        case "bigint":
            return typeof value === "number" || typeof value === "bigint";
        case "boolean":
            return typeof value === "boolean";
        case "enum":
            return typeof value === "string" && type.values.includes(value);
        case "array":
            return Array.isArray(value);
        case "bytes": case "reference": case "embedded":
            return value === null; // only null is a sensible literal default here
        case "instance": case "function": case "external": case "typeVar": case "optional":
            return false; // never a stored field type — no literal default applies
    }
}

type EvalResult = { ok: true; value: unknown } | { ok: false };

/** Evaluate a plain literal initializer to its JS value. Bad array elements / spreads are
 *  reported as KEYMA090 (an incompatible default), keeping decorator-arg codes in the schema. */
function evalLiteralValue(node: ts.Expression, ctx: DefaultLowerContext): EvalResult {
    if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
    if (ts.isStringLiteral(node)) return { ok: true, value: node.text };
    if (ts.isNumericLiteral(node)) return { ok: true, value: Number(node.text) };
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)
    ) {
        return { ok: true, value: -Number(node.operand.text) };
    }
    if (ts.isArrayLiteralExpression(node)) {
        const values: unknown[] = [];
        for (const el of node.elements) {
            if (ts.isSpreadElement(el)) {
                ctx.diagnostics.push(mkError(KEYMA090, "Spread elements are not supported in a literal default", getLocation(el, ctx.sourceFile)));
                return { ok: false };
            }
            const r = evalLiteralValue(el, ctx);
            if (!r.ok) return { ok: false };
            values.push(r.value);
        }
        return { ok: true, value: values };
    }
    ctx.diagnostics.push(mkError(KEYMA090, "Default array element must be a string, number, boolean, or null literal", getLocation(node, ctx.sourceFile)));
    return { ok: false };
}
