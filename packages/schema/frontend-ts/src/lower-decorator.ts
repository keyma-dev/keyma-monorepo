import ts from "typescript";
import type { IRValidator, IRFormatterSpec, IRDiagnostic, IRDefault, IRFormField, IRType } from "@keyma/core/ir";
import type { IRFieldIndex } from "../../ir/src/extensions.js";
import {
    mkError,
    KEYMA011, KEYMA013, KEYMA016, KEYMA020, KEYMA021, KEYMA090,
} from "./diagnostics.js";
import { getLocation, numericLiteralValue, stringLiteralValue, booleanLiteralValue } from "@keyma/compiler/frontend-ts";
import { lowerExpr, type FnRefVerdict } from "@keyma/compiler/frontend-ts";
import type { ResolvedFactory } from "@keyma/compiler/frontend-ts";

type LowerContext = {
    checker: ts.TypeChecker;
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    /** Module name of the Keyma DSL (e.g. "@keyma/core/dsl"). */
    dslModuleName: string;
    /** Schema class names; enables portable lowering of non-literal initializers. */
    schemaClassNames?: ReadonlySet<string>;
    /** Resolve a `@Validate(...)` callee to a validator factory (enqueues it for lowering). */
    resolveValidator?: (callee: ts.Identifier) => ResolvedFactory | undefined;
    /** Resolve a `@Format(...)` callee to a formatter factory (enqueues it for lowering). */
    resolveFormatter?: (callee: ts.Identifier) => ResolvedFactory | undefined;
    /** Classify a call target inside an initializer so project-local utilities compile. */
    classifyFunction?: (ident: ts.Identifier) => FnRefVerdict;
};

// ─── @Validate ───────────────────────────────────────────────────────────────

export function lowerValidateArgs(
    args: ts.NodeArray<ts.Expression>,
    ctx: LowerContext
): IRValidator[] {
    const result: IRValidator[] = [];
    for (const arg of args) {
        const v = lowerValidatorArg(arg, ctx);
        if (v !== null) result.push(v);
    }
    return result;
}

function lowerValidatorArg(expr: ts.Expression, ctx: LowerContext): IRValidator | null {
    const callee = getCalleeIdentifier(expr);
    // A validator is a factory call like `minLength(2)` / `isEmail()`: the callee
    // resolves (across imports/aliases) to a function whose return type is the DSL's
    // `ValidatorFn`. The collector lowers its body into the bundle.
    const resolved = callee !== undefined ? ctx.resolveValidator?.(callee) : undefined;

    if (resolved === undefined) {
        ctx.diagnostics.push(
            mkError(KEYMA020, `Expected a call to a validator factory — a function returning ValidatorFn (e.g. minLength(2))`, getLocation(expr, ctx.sourceFile))
        );
        return null;
    }

    if (ts.isCallExpression(expr)) {
        const params = extractCallParams(expr, ctx, resolved.factoryParams);
        if (params === undefined) return null;
        if (params !== null) return { name: resolved.name, params };
    }
    return { name: resolved.name };
}

// ─── @Format ─────────────────────────────────────────────────────────────────

const VALID_PHASES = new Set(["change", "blur", "submit", "save"]);

export function lowerFormatArgs(
    args: ts.NodeArray<ts.Expression>,
    ctx: LowerContext
): { phase: string; spec: IRFormatterSpec }[] {
    const phaseArg = args[0];
    if (!phaseArg) return [];

    const phase = resolvePhaseValue(phaseArg, ctx);
    if (phase === undefined || !VALID_PHASES.has(phase)) {
        ctx.diagnostics.push(
            mkError(KEYMA011, '@Format() first argument must be "change", "blur", "submit", or "save"', getLocation(phaseArg, ctx.sourceFile))
        );
        return [];
    }

    const result: { phase: string; spec: IRFormatterSpec }[] = [];
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (!arg) continue;
        const spec = lowerFormatterArg(arg, ctx);
        if (spec !== null) result.push({ phase, spec });
    }
    return result;
}

/**
 * Resolve the `@Format` phase argument to its string value. Accepts a bare string
 * literal (`"save"`) or a `Phase.*` constant — for the latter the value is read
 * from the resolved string-literal type via the checker.
 */
function resolvePhaseValue(arg: ts.Expression, ctx: LowerContext): string | undefined {
    const lit = stringLiteralValue(arg);
    if (lit !== undefined) return lit;
    const t = ctx.checker.getTypeAtLocation(arg);
    return t.isStringLiteral() ? t.value : undefined;
}

function lowerFormatterArg(expr: ts.Expression, ctx: LowerContext): IRFormatterSpec | null {
    const callee = getCalleeIdentifier(expr);
    // A formatter is a factory call like `trim()` / `truncate(20)`: the callee
    // resolves to a function whose return type is the DSL's `FormatterFn`.
    const resolved = callee !== undefined ? ctx.resolveFormatter?.(callee) : undefined;

    if (resolved === undefined) {
        ctx.diagnostics.push(
            mkError(KEYMA021, `Expected a call to a formatter factory — a function returning FormatterFn (e.g. trim())`, getLocation(expr, ctx.sourceFile))
        );
        return null;
    }

    if (ts.isCallExpression(expr)) {
        const params = extractCallParams(expr, ctx, resolved.factoryParams);
        if (params === undefined) return null;
        if (params !== null) return { name: resolved.name, params };
    }
    return { name: resolved.name };
}

// ─── Callee resolution ───────────────────────────────────────────────────────

/** The identifier being called in a @Validate/@Format argument. */
function getCalleeIdentifier(expr: ts.Expression): ts.Identifier | undefined {
    if (ts.isCallExpression(expr)) {
        return ts.isIdentifier(expr.expression) ? expr.expression : undefined;
    }
    return ts.isIdentifier(expr) ? expr : undefined;
}

// ─── Field default (property initializer) ────────────────────────────────────

/**
 * Lower a field's TypeScript property initializer (`= <expr>`) to an IRDefault.
 * A literal (`"active"`, `0`, `Role.Member`, `[...]`) lowers to `{kind:"literal"}`
 * with a light value-vs-type compatibility check (KEYMA090). Anything else
 * (`(() => new Date())()`, `myFn()`, …) lowers through the shared portable
 * expression engine to `{kind:"expression"}`, to be re-emitted and evaluated per
 * record at create time. Returns null on error (diagnostic already pushed).
 */
export function lowerInitializerDefault(
    init: ts.Expression,
    fieldType: IRType,
    ctx: LowerContext,
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
        schemaClassNames: ctx.schemaClassNames ?? new Set<string>(),
        ...(ctx.classifyFunction !== undefined ? { classifyFunction: ctx.classifyFunction } : {}),
    });
    if (expr === null) return null;
    return { kind: "expression", expression: expr };
}

/** Build a literal IRDefault, checking value-vs-type compatibility (KEYMA090). */
function literalDefault(
    value: string | number | boolean | null | unknown[],
    fieldType: IRType,
    node: ts.Node,
    ctx: LowerContext,
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
    }
}

// ─── @FormField ────────────────────────────────────────────────────────────────

/** Lower a `@FormField({...})` argument to IRFormField. Returns undefined when empty. */
export function lowerFormFieldArg(
    args: ts.NodeArray<ts.Expression>,
    ctx: LowerContext,
): IRFormField | undefined {
    const opts = readObjectLiteralArg(args[0], ctx);
    if (opts === null || opts === undefined) return undefined;

    const form: IRFormField = {};
    for (const key of ["title", "hint", "placeholder", "group"] as const) {
        const node = opts.get(key);
        if (node !== undefined) {
            const v = stringLiteralValue(node);
            if (v === undefined) { ctx.diagnostics.push(mkError(KEYMA011, `${key} must be a string literal`, getLocation(node, ctx.sourceFile))); continue; }
            form[key] = v;
        }
    }
    const order = opts.get("order");
    if (order !== undefined) {
        const v = numericLiteralValue(order);
        if (v === undefined) { ctx.diagnostics.push(mkError(KEYMA011, "order must be a numeric literal", getLocation(order, ctx.sourceFile))); }
        else form.order = v;
    }

    return Object.keys(form).length > 0 ? form : undefined;
}

// ─── @Indexed ────────────────────────────────────────────────────────────────

export function lowerIndexedArgs(
    args: ts.NodeArray<ts.Expression>,
    ctx: LowerContext
): IRFieldIndex | null {
    if (args.length === 0) return {};
    const opts = readObjectLiteralArg(args[0], ctx);
    if (opts === null) return null;
    if (opts === undefined) return {};

    const index: IRFieldIndex = {};

    const unique = opts.get("unique");
    if (unique !== undefined) {
        const v = booleanLiteralValue(unique);
        if (v === undefined) { ctx.diagnostics.push(mkError(KEYMA011, "unique must be a boolean literal", getLocation(unique, ctx.sourceFile))); return null; }
        index.unique = v;
    }

    const sparse = opts.get("sparse");
    if (sparse !== undefined) {
        const v = booleanLiteralValue(sparse);
        if (v === undefined) { ctx.diagnostics.push(mkError(KEYMA011, "sparse must be a boolean literal", getLocation(sparse, ctx.sourceFile))); return null; }
        index.sparse = v;
    }

    const direction = opts.get("direction");
    if (direction !== undefined) {
        const numV = numericLiteralValue(direction);
        const strV = stringLiteralValue(direction);
        if (numV === 1 || numV === -1) {
            index.direction = numV;
        } else if (strV === "text") {
            index.direction = "text";
        } else {
            ctx.diagnostics.push(mkError(KEYMA016, `@Indexed direction must be 1, -1, or "text"`, getLocation(direction, ctx.sourceFile)));
            return null;
        }
    }

    const key = opts.get("key");
    if (key !== undefined) {
        const v = stringLiteralValue(key);
        if (v === undefined) { ctx.diagnostics.push(mkError(KEYMA011, "key must be a string literal", getLocation(key, ctx.sourceFile))); return null; }
        index.key = v;
    }

    return index;
}

// ─── Call param extraction ────────────────────────────────────────────────────

/**
 * Extract params from a factory call expression, using the factory's parameter
 * names as keys. Returns null if there are no args, undefined if an error
 * occurred (already pushed to diagnostics).
 *
 * `factoryParams` are the declarations of the originating `Validator`/`Formatter`
 * factory (recovered by following the callee). They are preferred because a
 * factory's return type erases its parameter names to a generic rest parameter,
 * so the call site's resolved signature would name them `args`. When absent
 * (e.g. a plain local function ref), the call's resolved signature is used.
 */
function extractCallParams(
    callExpr: ts.CallExpression,
    ctx: LowerContext,
    factoryParams?: readonly ts.ParameterDeclaration[]
): Record<string, unknown> | null | undefined {
    if (callExpr.arguments.length === 0) return null;

    const params = paramInfo(callExpr, ctx, factoryParams);
    if (params === undefined || params.length === 0) return null;

    const result: Record<string, unknown> = {};

    for (let i = 0; i < params.length; i++) {
        const param = params[i];
        if (!param) continue;

        const { name: paramName, isRest } = param;

        if (isRest) {
            const values: unknown[] = [];
            for (let j = i; j < callExpr.arguments.length; j++) {
                const restArg = callExpr.arguments[j];
                if (!restArg) continue;
                if (ts.isSpreadElement(restArg)) {
                    ctx.diagnostics.push(mkError(KEYMA011, "Spread arguments are not supported in validator/formatter factory calls", getLocation(restArg, ctx.sourceFile)));
                    return undefined;
                }
                const r = evalLiteralValue(restArg, ctx);
                if (!r.ok) return undefined;
                values.push(r.value);
            }
            if (values.length > 0) result[paramName] = values;
            break;
        }

        const arg = callExpr.arguments[i];
        if (arg === undefined) break; // optional param, not provided

        const r = evalLiteralValue(arg, ctx);
        if (!r.ok) return undefined;
        if (r.value !== undefined) result[paramName] = r.value;
    }

    return Object.keys(result).length > 0 ? result : null;
}

type ParamInfo = { name: string; isRest: boolean };

/**
 * Normalize the parameter list for a factory call to `{ name, isRest }[]`,
 * preferring the factory's own parameter declarations and otherwise reading the
 * call's resolved signature. Returns undefined if neither is available.
 */
function paramInfo(
    callExpr: ts.CallExpression,
    ctx: LowerContext,
    factoryParams?: readonly ts.ParameterDeclaration[]
): ParamInfo[] | undefined {
    if (factoryParams !== undefined) {
        // Mirror lowerFactory's naming so call-site param keys match the
        // declaration's factoryParams names.
        return factoryParams.map((p) => ({
            name: ts.isIdentifier(p.name) ? p.name.text : "_",
            isRest: p.dotDotDotToken !== undefined,
        }));
    }

    const sig = ctx.checker.getResolvedSignature(callExpr);
    if (!sig) return undefined;
    return sig.getParameters().map((sym) => {
        const decl = sym.getDeclarations()?.[0];
        return {
            name: sym.getName(),
            isRest: decl !== undefined && ts.isParameter(decl) && decl.dotDotDotToken !== undefined,
        };
    });
}

type EvalResult = { ok: true; value: unknown } | { ok: false };

function evalLiteralValue(node: ts.Expression, ctx: LowerContext): EvalResult {
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) return { ok: true, value: undefined };
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
                ctx.diagnostics.push(mkError(KEYMA011, "Spread elements are not supported in validator/formatter arguments", getLocation(el, ctx.sourceFile)));
                return { ok: false };
            }
            const r = evalLiteralValue(el, ctx);
            if (!r.ok) return { ok: false };
            values.push(r.value);
        }
        return { ok: true, value: values };
    }

    ctx.diagnostics.push(mkError(KEYMA013, `Argument must be a string, number, boolean, array, null, or undefined literal`, getLocation(node, ctx.sourceFile)));
    return { ok: false };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readObjectLiteralArg(
    arg: ts.Expression | undefined,
    ctx: LowerContext
): Map<string, ts.Expression> | undefined | null {
    if (arg === undefined) return undefined;
    if (!ts.isObjectLiteralExpression(arg)) {
        ctx.diagnostics.push(mkError(KEYMA011, "Expected an object literal argument", getLocation(arg, ctx.sourceFile)));
        return null;
    }
    const map = new Map<string, ts.Expression>();
    for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
            ctx.diagnostics.push(mkError(KEYMA011, "Object literal properties must be simple assignments", getLocation(prop, ctx.sourceFile)));
            return null;
        }
        map.set(prop.name.text, prop.initializer);
    }
    return map;
}

export type { LowerContext };
