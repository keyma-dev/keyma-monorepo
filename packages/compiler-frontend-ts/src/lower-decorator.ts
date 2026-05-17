import ts from "typescript";
import type { IRValidator, IRFormatter, IRFormatterSpec, IRFieldIndex, IRDiagnostic } from "@keyma/ir";
import {
    mkError,
    KEYMA011, KEYMA012, KEYMA013, KEYMA016, KEYMA020, KEYMA021, KEYMA022, KEYMA023,
} from "./diagnostics.js";
import { getLocation, numericLiteralValue, stringLiteralValue, booleanLiteralValue } from "./util.js";

/**
 * Parameterless validator identifiers → IR validator kinds.
 * The compiler recognises these by the identifier name in the AST.
 */
const PARAMETERLESS_VALIDATORS: ReadonlyMap<string, IRValidator> = new Map([
    ["isRequired", { kind: "required" }],
    ["isPositive", { kind: "positive" }],
    ["isNonNegative", { kind: "nonNegative" }],
    ["isNegative", { kind: "negative" }],
    ["isNonPositive", { kind: "nonPositive" }],
    ["isInteger", { kind: "integer" }],
    ["uniqueItems", { kind: "uniqueItems" }],
    ["isEmailAddress", { kind: "emailAddress" }],
    ["isUuid", { kind: "pattern", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", flags: "i" }],
]);

/**
 * Parameterless formatter identifiers → IR formatter spec kinds.
 */
const PARAMETERLESS_FORMATTERS: ReadonlyMap<string, IRFormatterSpec> = new Map([
    ["trim", { kind: "trim" }],
    ["normalizeWhitespace", { kind: "normalizeWhitespace" }],
    ["lowercase", { kind: "lowercase" }],
    ["uppercase", { kind: "uppercase" }],
    ["titleCase", { kind: "titleCase" }],
    ["capitalize", { kind: "capitalize" }],
    ["stripNonDigits", { kind: "stripNonDigits" }],
    ["normalizeEmail", { kind: "normalizeEmail" }],
    ["normalizeUrl", { kind: "normalizeUrl" }],
    ["slugify", { kind: "slugify" }],
]);

type LowerContext = {
    customValidators: ReadonlySet<string>;
    customFormatters: ReadonlySet<string>;
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
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
    // Identifier: isRequired, isEmailAddress, etc.
    if (ts.isIdentifier(expr)) {
        const known = PARAMETERLESS_VALIDATORS.get(expr.text);
        if (known !== undefined) return known;
        ctx.diagnostics.push(
            mkError(KEYMA020, `Unknown validator "${expr.text}"`, getLocation(expr, ctx.sourceFile))
        );
        return null;
    }

    // CallExpression: minLength(2), isPhoneNumber({ region: "US" }), etc.
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
        const name = expr.expression.text;
        return lowerValidatorCall(name, expr.arguments, expr, ctx);
    }

    ctx.diagnostics.push(
        mkError(KEYMA011, "Validator argument must be an identifier or a call expression with literal arguments", getLocation(expr, ctx.sourceFile))
    );
    return null;
}

function lowerValidatorCall(
    name: string,
    args: ts.NodeArray<ts.Expression>,
    callExpr: ts.CallExpression,
    ctx: LowerContext
): IRValidator | null {
    const loc = getLocation(callExpr, ctx.sourceFile);

    switch (name) {
        case "minLength": return numArg(args, name, (value) => ({ kind: "minLength", value }), ctx);
        case "maxLength": return numArg(args, name, (value) => ({ kind: "maxLength", value }), ctx);
        case "length": return numArg(args, name, (value) => ({ kind: "length", value }), ctx);
        case "min": return numArg(args, name, (value) => ({ kind: "min", value }), ctx);
        case "max": return numArg(args, name, (value) => ({ kind: "max", value }), ctx);
        case "multipleOf": return numArg(args, name, (value) => ({ kind: "multipleOf", value }), ctx);
        case "minDate": return strArg(args, name, (value) => ({ kind: "minDate", value }), ctx);
        case "maxDate": return strArg(args, name, (value) => ({ kind: "maxDate", value }), ctx);
        case "minItems": return numArg(args, name, (value) => ({ kind: "minItems", value }), ctx);
        case "maxItems": return numArg(args, name, (value) => ({ kind: "maxItems", value }), ctx);

        case "pattern": {
            const arg = args[0];
            if (!arg) return missingArg("pattern", ctx, loc);
            // Accepts a string literal or a RegExp literal (e.g. /^\d+$/)
            if (ts.isStringLiteral(arg)) return { kind: "pattern", pattern: arg.text };
            if (ts.isRegularExpressionLiteral(arg)) {
                const match = /^\/(.*)\/([gimsuy]*)$/.exec(arg.text);
                if (match) {
                    const [, pat, flags] = match;
                    if (pat !== undefined) {
                        return flags ? { kind: "pattern", pattern: pat, flags } : { kind: "pattern", pattern: pat };
                    }
                }
            }
            ctx.diagnostics.push(mkError(KEYMA011, "pattern() requires a string or regex literal", getLocation(arg, ctx.sourceFile)));
            return null;
        }

        case "isUrl": {
            const opts = readObjectLiteralArg(args[0], ctx);
            if (opts === null) return null; // error already pushed
            if (opts === undefined) return { kind: "url" }; // no argument
            const protocolsNode = opts.get("protocols");
            if (protocolsNode !== undefined) {
                const protocols = readStringArray(protocolsNode, ctx);
                if (protocols === null) return null;
                return { kind: "url", protocols };
            }
            return { kind: "url" };
        }

        case "isPhoneNumber": {
            const opts = readObjectLiteralArg(args[0], ctx);
            if (opts === null) return null;
            if (opts === undefined) return { kind: "phoneNumber" };
            const region = opts.get("region");
            if (region !== undefined) {
                const r = stringLiteralValue(region);
                if (r === undefined) { ctx.diagnostics.push(mkError(KEYMA011, "region must be a string literal", getLocation(region, ctx.sourceFile))); return null; }
                return { kind: "phoneNumber", region: r };
            }
            return { kind: "phoneNumber" };
        }

        case "isIpAddress": {
            const opts = readObjectLiteralArg(args[0], ctx);
            if (opts === null) return null;
            if (opts === undefined) return { kind: "ipAddress" };
            const version = opts.get("version");
            if (version !== undefined) {
                const v = stringLiteralValue(version);
                if (v !== "v4" && v !== "v6") { ctx.diagnostics.push(mkError(KEYMA011, 'version must be "v4" or "v6"', getLocation(version, ctx.sourceFile))); return null; }
                return { kind: "ipAddress", version: v };
            }
            return { kind: "ipAddress" };
        }

        case "oneOf": {
            const arg = args[0];
            if (!arg || !ts.isArrayLiteralExpression(arg)) {
                ctx.diagnostics.push(mkError(KEYMA013, "oneOf() requires an array literal argument", loc));
                return null;
            }
            const values: (string | number)[] = [];
            for (const el of arg.elements) {
                const s = stringLiteralValue(el);
                if (s !== undefined) { values.push(s); continue; }
                const n = numericLiteralValue(el);
                if (n !== undefined) { values.push(n); continue; }
                ctx.diagnostics.push(mkError(KEYMA011, "oneOf() values must be string or numeric literals", getLocation(el, ctx.sourceFile)));
                return null;
            }
            return { kind: "oneOf", values };
        }

        case "customValidator": {
            const arg = args[0];
            if (!arg) return missingArg("customValidator", ctx, loc);
            const vName = stringLiteralValue(arg);
            if (vName === undefined) { ctx.diagnostics.push(mkError(KEYMA011, "customValidator() requires a string literal name", getLocation(arg, ctx.sourceFile))); return null; }
            if (!ctx.customValidators.has(vName)) {
                ctx.diagnostics.push(mkError(KEYMA022, `Custom validator "${vName}" is not registered`, loc));
                return null;
            }
            return { kind: "custom", name: vName };
        }

        default:
            ctx.diagnostics.push(mkError(KEYMA020, `Unknown validator "${name}"`, loc));
            return null;
    }
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
    if (ts.isIdentifier(expr)) {
        const known = PARAMETERLESS_FORMATTERS.get(expr.text);
        if (known !== undefined) return known;
        ctx.diagnostics.push(mkError(KEYMA021, `Unknown formatter "${expr.text}"`, getLocation(expr, ctx.sourceFile)));
        return null;
    }

    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
        const name = expr.expression.text;
        return lowerFormatterCall(name, expr.arguments, expr, ctx);
    }

    ctx.diagnostics.push(mkError(KEYMA011, "Formatter argument must be an identifier or a call expression with literal arguments", getLocation(expr, ctx.sourceFile)));
    return null;
}

function lowerFormatterCall(
    name: string,
    args: ts.NodeArray<ts.Expression>,
    callExpr: ts.CallExpression,
    ctx: LowerContext
): IRFormatterSpec | null {
    const loc = getLocation(callExpr, ctx.sourceFile);

    switch (name) {
        case "normalizePhone": {
            const opts = readObjectLiteralArg(args[0], ctx);
            if (opts === null) return null;
            if (opts === undefined) return { kind: "normalizePhone" };
            const region = opts.get("region");
            if (region !== undefined) {
                const r = stringLiteralValue(region);
                if (r === undefined) { ctx.diagnostics.push(mkError(KEYMA011, "region must be a string literal", getLocation(region, ctx.sourceFile))); return null; }
                return { kind: "normalizePhone", region: r };
            }
            return { kind: "normalizePhone" };
        }

        case "truncate": {
            const arg = args[0];
            if (!arg) return missingArgSpec("truncate", ctx, loc);
            const n = numericLiteralValue(arg);
            if (n === undefined) { ctx.diagnostics.push(mkError(KEYMA013, "truncate() requires a numeric literal argument", getLocation(arg, ctx.sourceFile))); return null; }
            return { kind: "truncate", maxLength: n };
        }

        case "customFormatter": {
            const arg = args[0];
            if (!arg) return missingArgSpec("customFormatter", ctx, loc);
            const fName = stringLiteralValue(arg);
            if (fName === undefined) { ctx.diagnostics.push(mkError(KEYMA011, "customFormatter() requires a string literal name", getLocation(arg, ctx.sourceFile))); return null; }
            if (!ctx.customFormatters.has(fName)) {
                ctx.diagnostics.push(mkError(KEYMA023, `Custom formatter "${fName}" is not registered`, loc));
                return null;
            }
            return { kind: "custom", name: fName };
        }

        default:
            ctx.diagnostics.push(mkError(KEYMA021, `Unknown formatter "${name}"`, loc));
            return null;
    }
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read an optional ObjectLiteralExpression argument, returning a key→node map. */
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

function readStringArray(node: ts.Expression, ctx: LowerContext): string[] | null {
    if (!ts.isArrayLiteralExpression(node)) {
        ctx.diagnostics.push(mkError(KEYMA011, "Expected an array literal", getLocation(node, ctx.sourceFile)));
        return null;
    }
    const result: string[] = [];
    for (const el of node.elements) {
        const s = stringLiteralValue(el);
        if (s === undefined) {
            ctx.diagnostics.push(mkError(KEYMA011, "Array elements must be string literals", getLocation(el, ctx.sourceFile)));
            return null;
        }
        result.push(s);
    }
    return result;
}

function numArg<T extends IRValidator>(
    args: ts.NodeArray<ts.Expression>,
    name: string,
    build: (value: number) => T,
    ctx: LowerContext
): T | null {
    const arg = args[0];
    if (!arg) {
        ctx.diagnostics.push(mkError(KEYMA013, `${name}() requires a numeric argument`));
        return null;
    }
    const n = numericLiteralValue(arg);
    if (n === undefined) {
        ctx.diagnostics.push(mkError(KEYMA011, `${name}() argument must be a numeric literal`, getLocation(arg, ctx.sourceFile)));
        return null;
    }
    return build(n);
}

function strArg<T extends IRValidator>(
    args: ts.NodeArray<ts.Expression>,
    name: string,
    build: (value: string) => T,
    ctx: LowerContext
): T | null {
    const arg = args[0];
    if (!arg) {
        ctx.diagnostics.push(mkError(KEYMA013, `${name}() requires a string argument`));
        return null;
    }
    const s = stringLiteralValue(arg);
    if (s === undefined) {
        ctx.diagnostics.push(mkError(KEYMA011, `${name}() argument must be a string literal`, getLocation(arg, ctx.sourceFile)));
        return null;
    }
    return build(s);
}

function missingArg(name: string, ctx: LowerContext, loc: import("@keyma/ir").IRSourceLocation): IRValidator | null {
    ctx.diagnostics.push(mkError(KEYMA013, `${name}() requires an argument`, loc));
    return null;
}

function missingArgSpec(name: string, ctx: LowerContext, loc: import("@keyma/ir").IRSourceLocation): IRFormatterSpec | null {
    ctx.diagnostics.push(mkError(KEYMA013, `${name}() requires an argument`, loc));
    return null;
}

export type { LowerContext };
