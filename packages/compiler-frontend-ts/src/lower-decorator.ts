import ts from "typescript";
import type { IRValidator, IRFormatterSpec, IRFieldIndex, IRDiagnostic } from "@keyma/ir";
import {
    mkError,
    KEYMA011, KEYMA013, KEYMA016, KEYMA020, KEYMA021,
} from "./diagnostics.js";
import { getLocation, numericLiteralValue, stringLiteralValue, booleanLiteralValue, resolveAlias, isFromModule } from "./util.js";

type LowerContext = {
    checker: ts.TypeChecker;
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    /** Module name of the Keyma DSL (e.g. "@keyma/dsl"). */
    dslModuleName: string;
    /** Map from function name → validator name (from Validator(name, fn) declarations). */
    discoveredValidators?: Map<string, string>;
    /** Map from function name → formatter name (from Formatter(name, fn) declarations). */
    discoveredFormatters?: Map<string, string>;
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

    // Path 1: follow the callee to its `Validator("name", fn)` declaration. A
    // factory call like @Validate(required()) has the generic return type
    // ValidatorRef, whose __validatorName is `string` (not a literal), so the
    // name can only be recovered from the originating declaration — across
    // imports and aliases. The discovered-name map is a same-text fallback.
    const resolved = callee !== undefined ? resolveFactory(callee, "Validator", ctx) : undefined;
    let name = resolved?.name ?? (callee !== undefined ? ctx.discoveredValidators?.get(callee.text) : undefined);

    // Path 2: a ValidatorRef carrying a string-literal __validatorName — a
    // hand-written ref, or an `as const` factory result declared in this file.
    if (name === undefined) {
        const nameProp = ctx.checker.getTypeAtLocation(expr).getProperty("__validatorName");
        if (nameProp !== undefined) {
            const nameType = ctx.checker.getTypeOfSymbol(nameProp);
            if (!nameType.isStringLiteral()) {
                ctx.diagnostics.push(
                    mkError(KEYMA020, `Cannot determine validator name at compile time — the ValidatorRef must carry a string literal __validatorName (use "as const" on the export)`, getLocation(expr, ctx.sourceFile))
                );
                return null;
            }
            name = nameType.value;
        }
    }

    if (name === undefined) {
        ctx.diagnostics.push(
            mkError(KEYMA020, `Expected a ValidatorRef or a call to a Validator(name, fn) factory`, getLocation(expr, ctx.sourceFile))
        );
        return null;
    }

    if (ts.isCallExpression(expr)) {
        const params = extractCallParams(expr, ctx, resolved?.factoryParams);
        if (params === undefined) return null;
        if (params !== null) return { name, params };
    }
    return { name };
}

// ─── @Format ─────────────────────────────────────────────────────────────────

const VALID_PHASES = new Set(["change", "blur", "submit", "save"]);

export function lowerFormatArgs(
    args: ts.NodeArray<ts.Expression>,
    ctx: LowerContext
): { phase: string; spec: IRFormatterSpec }[] {
    const phaseArg = args[0];
    if (!phaseArg) return [];

    const phase = stringLiteralValue(phaseArg);
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

function lowerFormatterArg(expr: ts.Expression, ctx: LowerContext): IRFormatterSpec | null {
    const callee = getCalleeIdentifier(expr);

    // Path 1: follow the callee to its `Formatter("name", fn)` declaration. As
    // with validators, a factory call like @Format("change", trim()) has the
    // generic return type FormatterRef, whose __formatterName is `string`, so
    // the name is recovered from the originating declaration (imports/aliases
    // included). The discovered-name map is a same-text fallback.
    const resolved = callee !== undefined ? resolveFactory(callee, "Formatter", ctx) : undefined;
    let name = resolved?.name ?? (callee !== undefined ? ctx.discoveredFormatters?.get(callee.text) : undefined);

    // Path 2: a FormatterRef carrying a string-literal __formatterName — a
    // hand-written ref, or an `as const` factory result declared in this file.
    if (name === undefined) {
        const nameProp = ctx.checker.getTypeAtLocation(expr).getProperty("__formatterName");
        if (nameProp !== undefined) {
            const nameType = ctx.checker.getTypeOfSymbol(nameProp);
            if (!nameType.isStringLiteral()) {
                ctx.diagnostics.push(
                    mkError(KEYMA021, `Cannot determine formatter name at compile time — the FormatterRef must carry a string literal __formatterName (use "as const" on the export)`, getLocation(expr, ctx.sourceFile))
                );
                return null;
            }
            name = nameType.value;
        }
    }

    if (name === undefined) {
        ctx.diagnostics.push(
            mkError(KEYMA021, `Expected a FormatterRef or a call to a Formatter(name, fn) factory`, getLocation(expr, ctx.sourceFile))
        );
        return null;
    }

    if (ts.isCallExpression(expr)) {
        const params = extractCallParams(expr, ctx, resolved?.factoryParams);
        if (params === undefined) return null;
        if (params !== null) return { name, params };
    }
    return { name };
}

// ─── Factory name resolution ────────────────────────────────────────────────

/** The registered name plus the factory's parameter list, recovered from a declaration. */
type ResolvedFactory = { name: string; factoryParams: readonly ts.ParameterDeclaration[] };

/** The identifier being called or referenced in a @Validate/@Format argument. */
function getCalleeIdentifier(expr: ts.Expression): ts.Identifier | undefined {
    if (ts.isCallExpression(expr)) {
        return ts.isIdentifier(expr.expression) ? expr.expression : undefined;
    }
    return ts.isIdentifier(expr) ? expr : undefined;
}

/**
 * Follow a callee identifier across imports/aliases to its originating
 * `Validator("name", fn)` / `Formatter("name", fn)` declaration and return the
 * registered name plus the factory's parameter list, or undefined if it does
 * not resolve to one.
 *
 * This is the only way to recover the name for a factory call such as
 * `@Validate(required())`: the factory's declared return type is the opaque
 * `ValidatorRef`, whose `__validatorName` is `string` (not a string literal),
 * so the name cannot be read off the call expression's type. The factory's own
 * parameter names (e.g. `value` in `minLength(value)`) are likewise erased to a
 * generic rest parameter on the call site, so they too come from the declaration.
 */
function resolveFactory(
    ident: ts.Identifier,
    factory: "Validator" | "Formatter",
    ctx: LowerContext,
): ResolvedFactory | undefined {
    const symbol = ctx.checker.getSymbolAtLocation(ident);
    if (symbol === undefined) return undefined;
    const resolved = resolveAlias(symbol, ctx.checker);

    for (const decl of resolved.getDeclarations() ?? []) {
        if (!ts.isVariableDeclaration(decl)) continue;
        const init = decl.initializer;
        if (init === undefined || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) continue;
        if (init.expression.text !== factory) continue;

        // The factory must be the DSL's Validator/Formatter, not a same-named local.
        const factorySym = ctx.checker.getSymbolAtLocation(init.expression);
        if (factorySym === undefined || !isFromModule(factorySym, ctx.checker, ctx.dslModuleName)) continue;

        const nameArg = init.arguments[0];
        if (nameArg === undefined || !ts.isStringLiteral(nameArg)) continue;

        const factoryFn = init.arguments[1];
        const factoryParams = factoryFn !== undefined && (ts.isArrowFunction(factoryFn) || ts.isFunctionExpression(factoryFn))
            ? factoryFn.parameters
            : [];
        return { name: nameArg.text, factoryParams };
    }
    return undefined;
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
