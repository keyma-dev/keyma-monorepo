import type { IRExpression } from "@keyma/ir";

/** Lower an IRExpression to a Python source string. */
export function exprToPython(expr: IRExpression): string {
    switch (expr.kind) {
        case "literal":
            if (expr.value === true) return "True";
            if (expr.value === false) return "False";
            if (expr.value === null) return "None";
            return JSON.stringify(expr.value);

        case "field":
            return `self.${expr.name}`;

        case "member":
            return `${wrapIfComplex(expr.object)}.${expr.member}`;

        case "template":
            return templateToPython(expr.parts);

        case "unary": {
            const op = expr.op === "!" ? "not " : expr.op;
            return `${op}${wrapIfComplex(expr.operand)}`;
        }

        case "binary": {
            if (expr.op === "&&") return `${wrapIfBinaryChild(expr.left)} and ${wrapIfBinaryChild(expr.right)}`;
            if (expr.op === "||") return `${wrapIfBinaryChild(expr.left)} or ${wrapIfBinaryChild(expr.right)}`;
            if (expr.op === "??") return `(${exprToPython(expr.left)} if ${exprToPython(expr.left)} is not None else ${exprToPython(expr.right)})`;
            return `${wrapIfBinaryChild(expr.left)} ${expr.op} ${wrapIfBinaryChild(expr.right)}`;
        }

        case "conditional":
            return (
                `${wrapIfComplex(expr.whenTrue)} if ` +
                `${wrapIfComplex(expr.condition)} else ` +
                `${exprToPython(expr.whenFalse)}`
            );

        case "identifier":
            return expr.name === "undefined" ? "None" : expr.name;

        case "call": {
            const callee = wrapIfComplex(expr.callee);
            const args = expr.args.map(exprToPython).join(", ");
            return `${callee}(${args})`;
        }

        case "typeof":
            return `type(${exprToPython(expr.operand)})`;

        case "object": {
            const props = expr.properties
                .map((p) => `${JSON.stringify(p.key)}: ${exprToPython(p.value)}`)
                .join(", ");
            return `{ ${props} }`;
        }

        case "regexp":
            return regexpLiteralToPython(expr.pattern, expr.flags); // Requires import re

        case "arrow": {
            const body = exprToPython(expr.body);
            return `lambda ${expr.params.join(", ")}: ${body}`;
        }

        case "new": {
            // `new RegExp(pattern[, flags])` → re.compile(...) (Requires import re)
            if (expr.callee.kind === "identifier" && expr.callee.name === "RegExp") {
                return regexpNewToPython(expr.args);
            }
            const callee = wrapIfComplex(expr.callee);
            const args = expr.args.map(exprToPython).join(", ");
            return `${callee}(${args})`;
        }

        case "intrinsic":
            return intrinsicToPython(expr);
    }
}

/**
 * Translate a canonical intrinsic op to idiomatic Python. This table is the Python
 * backend's implementation of the shared intrinsic registry (see
 * packages/ir/intrinsics.md). Every `required` op must be handled here.
 */
function intrinsicToPython(expr: Extract<IRExpression, { kind: "intrinsic" }>): string {
    const recv = expr.receiver !== null ? wrapIfComplex(expr.receiver) : "";
    const args = expr.args.map(exprToPython);
    const arg0 = args[0];

    switch (expr.op) {
        case "string.includes":
        case "array.includes":
            return `(${arg0} in ${recv})`;
        case "string.startsWith":
            return `${recv}.startswith(${arg0})`;
        case "string.endsWith":
            return `${recv}.endswith(${arg0})`;
        case "string.toLowerCase":
            return `${recv}.lower()`;
        case "string.toUpperCase":
            return `${recv}.upper()`;
        case "string.trim":
            return `${recv}.strip()`;
        case "string.length":
        case "array.length":
            return `len(${recv})`;
        case "string.indexOf":
            return `${recv}.find(${arg0})`;
        case "array.indexOf":
            return `(${recv}.index(${arg0}) if ${arg0} in ${recv} else -1)`;
        case "string.slice":
            return args.length >= 2
                ? `${recv}[${arg0}:${args[1]}]`
                : `${recv}[${arg0}:]`;
        case "string.charAt":
            return `${recv}[${arg0}:${arg0} + 1]`;
        case "array.join": {
            const sep = arg0 ?? '","';
            return `${sep}.join(${recv})`;
        }
        case "array.filter":
            return arrayFilterToPython(recv, expr.args[0]);
        case "string.replace":
            return stringReplaceToPython(recv, expr.args[0], expr.args[1]);
        case "regexp.test":
            return `(${recv}.search(${arg0}) is not None)`;
        case "type-is":
            return typeIsToPython(recv, literalText(expr.args[0]));
        case "instance-of":
            return instanceOfToPython(recv, literalText(expr.args[0]));
        default:
            // Unknown op — emit a clearly-invalid marker so it surfaces in review/runtime
            // rather than silently producing wrong behavior.
            return `__keyma_unsupported_intrinsic__(${JSON.stringify(expr.op)})`;
    }
}

/** `arr.filter(pred)` → list comprehension. */
function arrayFilterToPython(recv: string, pred: IRExpression | undefined): string {
    if (pred === undefined || pred.kind !== "arrow") {
        return `[__x for __x in ${recv} if ${pred !== undefined ? exprToPython(pred) : "True"}]`;
    }
    const item = pred.params[0] ?? "__x";
    const idx = pred.params[1];
    const body = exprToPython(pred.body);
    return idx !== undefined
        ? `[${item} for ${idx}, ${item} in enumerate(${recv}) if ${body}]`
        : `[${item} for ${item} in ${recv} if ${body}]`;
}

/** `s.replace(pat, repl)` → str.replace (string pattern) or re.sub (regex pattern). */
function stringReplaceToPython(recv: string, pat: IRExpression | undefined, repl: IRExpression | undefined): string {
    if (pat !== undefined && isRegexExpr(pat)) {
        const patPy = exprToPython(pat);
        const replPy = repl !== undefined && repl.kind === "arrow"
            ? `lambda __m: (${exprToPython(repl)})(__m.group(0))` // JS callback receives the matched substring
            : repl !== undefined ? exprToPython(repl) : '""';
        // A regex without the `g` flag replaces only the first match; re.sub defaults to all.
        const count = pat.kind === "regexp" && !pat.flags.includes("g") ? ", count=1" : "";
        return `re.sub(${patPy}, ${replPy}, ${recv}${count})`;
    }
    const a0 = pat !== undefined ? exprToPython(pat) : '""';
    const a1 = repl !== undefined ? exprToPython(repl) : '""';
    return `${recv}.replace(${a0}, ${a1})`;
}

/** Whether an expression is a regular expression (literal or `new RegExp(...)`). */
function isRegexExpr(expr: IRExpression): boolean {
    if (expr.kind === "regexp") return true;
    return expr.kind === "new" && expr.callee.kind === "identifier" && expr.callee.name === "RegExp";
}

/** Render a regex literal as `re.compile(<raw-string>[, <flags>])`. */
function regexpLiteralToPython(pattern: string, flags: string): string {
    const f = pyRegexFlags(flags);
    return f === "" ? `re.compile(${pyRegexPattern(pattern)})` : `re.compile(${pyRegexPattern(pattern)}, ${f})`;
}

/** `new RegExp(pattern[, flags])` → re.compile(...), mapping the (possibly dynamic) flags string. */
function regexpNewToPython(args: IRExpression[]): string {
    const pat = args[0] !== undefined ? exprToPython(args[0]) : '""';
    const flagsArg = args[1];
    if (flagsArg === undefined) return `re.compile(${pat})`;
    const f = exprToPython(flagsArg);
    const flagsExpr =
        `((re.IGNORECASE if "i" in (${f} or "") else 0)` +
        ` | (re.MULTILINE if "m" in (${f} or "") else 0)` +
        ` | (re.DOTALL if "s" in (${f} or "") else 0))`;
    return `re.compile(${pat}, ${flagsExpr})`;
}

/** A Python raw string for a regex pattern, falling back to a normal escaped string when unsafe. */
function pyRegexPattern(pattern: string): string {
    if (!pattern.includes('"') && !pattern.endsWith("\\")) return `r"${pattern}"`;
    // JSON.stringify escapes backslashes, yielding a valid (non-raw) Python string literal.
    return JSON.stringify(pattern);
}

/** Translate JS regex flags to a Python `re.*` flag expression (ignores g/u/y). */
function pyRegexFlags(flags: string): string {
    const parts: string[] = [];
    if (flags.includes("i")) parts.push("re.IGNORECASE");
    if (flags.includes("m")) parts.push("re.MULTILINE");
    if (flags.includes("s")) parts.push("re.DOTALL");
    return parts.join(" | ");
}

/** Read a string-literal arg's value (type/constructor name), or "" if not a literal. */
function literalText(expr: IRExpression | undefined): string {
    return expr !== undefined && expr.kind === "literal" && typeof expr.value === "string" ? expr.value : "";
}

/** `typeof recv === "<name>"` → Python type check. */
function typeIsToPython(recv: string, typeName: string): string {
    switch (typeName) {
        case "string":    return `isinstance(${recv}, str)`;
        case "number":    return `(isinstance(${recv}, (int, float)) and not isinstance(${recv}, bool))`;
        case "boolean":   return `isinstance(${recv}, bool)`;
        case "bigint":    return `isinstance(${recv}, int)`;
        case "undefined": return `${recv} is None`;
        case "function":  return `callable(${recv})`;
        case "object":    return `isinstance(${recv}, dict)`; // approximate: JS `object` has no single Python analogue
        default:          return "False";
    }
}

/** `recv instanceof Ctor` → Python isinstance. */
function instanceOfToPython(recv: string, ctor: string): string {
    switch (ctor) {
        case "Date":       return `isinstance(${recv}, datetime)`; // Requires from datetime import datetime
        case "RegExp":     return `isinstance(${recv}, re.Pattern)`; // Requires import re
        case "Uint8Array": return `isinstance(${recv}, (bytes, bytearray))`;
        case "Array":      return `isinstance(${recv}, list)`;
        default:           return "False";
    }
}

/** Wrap in parens if this is a complex expression that needs grouping in certain positions. */
function wrapIfComplex(expr: IRExpression): string {
    const s = exprToPython(expr);
    if (expr.kind === "binary" || expr.kind === "conditional" || expr.kind === "typeof" || expr.kind === "arrow") {
        return `(${s})`;
    }
    return s;
}

/** Wrap binary children in parens to ensure correct associativity. */
function wrapIfBinaryChild(expr: IRExpression): string {
    const s = exprToPython(expr);
    if (expr.kind === "binary" || expr.kind === "conditional") {
        return `(${s})`;
    }
    return s;
}

/**
 * Render a template literal as Python string concatenation rather than an f-string.
 * Concatenation avoids f-string quoting pitfalls (an interpolated expression that
 * itself contains the delimiter quote, e.g. `", ".join(xs)`, is a syntax error in an
 * f-string on Python < 3.12) and works on all supported Python versions.
 */
function templateToPython(parts: IRExpression[]): string {
    if (parts.length === 0) return '""';
    const pieces = parts.map((p) => {
        if (p.kind === "literal") {
            return JSON.stringify(String(p.value === null ? "None" : p.value));
        }
        return `str(${exprToPython(p)})`;
    });
    return pieces.length === 1 ? pieces[0]! : `(${pieces.join(" + ")})`;
}
