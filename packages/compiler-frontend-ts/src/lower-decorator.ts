import ts from "typescript";
import type { IRValidator, IRFormatterSpec, IRFieldIndex, IRDiagnostic, IRDefault, IRFormField, IRType } from "@keyma/ir";
import {
    mkError,
    KEYMA011, KEYMA013, KEYMA016, KEYMA020, KEYMA021, KEYMA090, KEYMA091,
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

        // Two forms: `Validator("name", fn)` and `Validator(fn)` (name inferred
        // from the const binding). Recover the name and the factory accordingly.
        const arg0 = init.arguments[0];
        let name: string;
        let factoryFn: ts.Expression | undefined;
        if (arg0 !== undefined && ts.isStringLiteral(arg0)) {
            name = arg0.text;
            factoryFn = init.arguments[1];
        } else if (arg0 !== undefined && (ts.isArrowFunction(arg0) || ts.isFunctionExpression(arg0)) && ts.isIdentifier(decl.name)) {
            name = decl.name.text;
            factoryFn = arg0;
        } else {
            continue;
        }

        const factoryParams = factoryFn !== undefined && (ts.isArrowFunction(factoryFn) || ts.isFunctionExpression(factoryFn))
            ? factoryFn.parameters
            : [];
        return { name, factoryParams };
    }
    return undefined;
}

// ─── @Default ──────────────────────────────────────────────────────────────────

/**
 * Lower a `@Default(...)` argument to an IRDefault. Accepts a literal value or a
 * named generator (`Now`, `Uuid`) imported from the DSL. The `fieldType` is used
 * for a light literal-vs-type compatibility check (KEYMA090). Returns null on error.
 */
export function lowerDefaultArg(
    args: ts.NodeArray<ts.Expression>,
    fieldType: IRType,
    ctx: LowerContext,
): IRDefault | null {
    const arg = args[0];
    if (arg === undefined) {
        ctx.diagnostics.push(mkError(KEYMA091, "@Default() requires a value"));
        return null;
    }

    // Named generator: @Default(Now) / @Default(Uuid)
    if (ts.isIdentifier(arg)) {
        const gen = resolveDefaultGenerator(arg, ctx);
        if (gen !== undefined) return { kind: "generator", name: gen };
    }

    // Enum-member / const access (e.g. `Role.Member`) — resolve to its literal value.
    if (ts.isPropertyAccessExpression(arg)) {
        const t = ctx.checker.getTypeAtLocation(arg);
        const v = t.isStringLiteral() ? t.value : t.isNumberLiteral() ? t.value : undefined;
        if (v === undefined) {
            ctx.diagnostics.push(mkError(
                KEYMA091,
                "@Default() must be a literal, a named generator (Now, Uuid), or a string-enum member",
                getLocation(arg, ctx.sourceFile),
            ));
            return null;
        }
        if (!literalMatchesType(v, fieldType)) {
            ctx.diagnostics.push(mkError(KEYMA090, `@Default value ${JSON.stringify(v)} is not compatible with field type "${fieldType.kind}"`, getLocation(arg, ctx.sourceFile)));
            return null;
        }
        return { kind: "literal", value: v };
    }

    // Arrows/functions/calls are not supported as defaults yet.
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg) || ts.isCallExpression(arg)) {
        ctx.diagnostics.push(mkError(
            KEYMA091,
            "@Default() must be a literal value or a named generator (Now, Uuid)",
            getLocation(arg, ctx.sourceFile),
        ));
        return null;
    }

    const r = evalLiteralValue(arg, ctx);
    if (!r.ok) return null;
    const value = r.value as string | number | boolean | null | unknown[];

    if (!literalMatchesType(value, fieldType)) {
        ctx.diagnostics.push(mkError(
            KEYMA090,
            `@Default value ${JSON.stringify(value)} is not compatible with field type "${fieldType.kind}"`,
            getLocation(arg, ctx.sourceFile),
        ));
        return null;
    }

    return { kind: "literal", value };
}

/** Resolve a DSL default generator identifier (`Now`/`Uuid`) to its IR name. */
function resolveDefaultGenerator(ident: ts.Identifier, ctx: LowerContext): "now" | "uuid" | undefined {
    const sym = ctx.checker.getSymbolAtLocation(ident);
    if (sym === undefined || !isFromModule(sym, ctx.checker, ctx.dslModuleName)) return undefined;
    const name = resolveAlias(sym, ctx.checker).getName();
    if (name === "Now") return "now";
    if (name === "Uuid") return "uuid";
    return undefined;
}

/** A light compatibility check between a literal default and the field's type. */
function literalMatchesType(value: unknown, type: IRType): boolean {
    switch (type.kind) {
        case "json":
            return true; // any JSON value
        case "string": case "id": case "decimal": case "date": case "dateTime": case "time": case "regexp":
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
