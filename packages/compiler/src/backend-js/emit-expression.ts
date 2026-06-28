import type { IRExpression, IRStatement } from "@keyma/core/ir";
import { intrinsicByOp } from "@keyma/core/ir";

export type ExprEmitOptions = {
    /**
     * How a `{ kind: "field" }` reference is rendered. Defaults to `this.<name>`
     * (getter/method body context). The `applyDefaults` emitter passes `value.<name>`
     * so it can fill defaults on a plain record without a fragile post-hoc rewrite.
     */
    fieldAccess?: (name: string) => string;
};

/** Lower an IRExpression to a JavaScript source string. */
export function exprToJs(expr: IRExpression, opts: ExprEmitOptions = {}): string {
    const fieldAccess = opts.fieldAccess ?? ((name: string) => `this.${name}`);

    const emit = (e: IRExpression): string => {
        switch (e.kind) {
            case "literal":
                return JSON.stringify(e.value);

            case "field":
                return fieldAccess(e.name);

            case "member":
                return `${wrapIfComplex(e.object)}.${e.member}`;

            case "template":
                return templateToJs(e.parts);

            case "unary":
                return `${e.op}${wrapIfComplex(e.operand)}`;

            case "binary":
                return `${wrapIfBinaryChild(e.left)} ${e.op} ${wrapIfBinaryChild(e.right)}`;

            case "conditional":
                return (
                    `${wrapIfComplex(e.condition)} ? ` +
                    `${wrapIfComplex(e.whenTrue)} : ` +
                    `${emit(e.whenFalse)}`
                );

            case "identifier":
                return e.name;

            case "call": {
                const callee = wrapIfComplex(e.callee);
                const args = e.args.map(emit).join(", ");
                return `${callee}(${args})`;
            }

            case "typeof":
                return `typeof (${emit(e.operand)})`;

            case "object": {
                const props = e.properties
                    .map((p) => `${JSON.stringify(p.key)}: ${emit(p.value)}`)
                    .join(", ");
                return `{ ${props} }`;
            }

            case "array":
                return `[${e.elements.map(emit).join(", ")}]`;

            case "record": {
                // A typed record erases to a plain object in JS (the `type` is ignored).
                const props = e.properties
                    .map((p) => `${JSON.stringify(p.key)}: ${emit(p.value)}`)
                    .join(", ");
                return `{ ${props} }`;
            }

            case "regexp":
                return `/${e.pattern}/${e.flags}`;

            case "arrow": {
                // Block-body arrow (multi-statement): a native block lambda.
                if (e.statements !== undefined) {
                    const stmts = e.statements.map((s) => stmtToJs(s, "", opts)).join(" ");
                    return `(${e.params.join(", ")}) => { ${stmts} }`;
                }
                // Concise body. Parenthesize an object-literal body so it isn't parsed as a block.
                const body = e.body!.kind === "object" ? `(${emit(e.body!)})` : emit(e.body!);
                return `(${e.params.join(", ")}) => ${body}`;
            }

            case "new": {
                const callee = wrapIfComplex(e.callee);
                const args = e.args.map(emit).join(", ");
                return `new ${callee}(${args})`;
            }

            case "await":
                // `async` implies the awaitable wrapper; the operand is parenthesized when
                // complex so e.g. `await (a + b)` / `(await foo).bar` stay correct.
                return `await ${wrapIfComplex(e.operand)}`;

            case "intrinsic":
                return intrinsicToJs(e);
            default:
                // Additive IR vocabulary whose JS emission lands in a later slice.
                throw new Error(`exprToJs: unsupported IR expression kind "${(e as { kind: string }).kind}"`);
        }
    };

    /** Wrap in parens if this is a complex expression that needs grouping. */
    const wrapIfComplex = (e: IRExpression): string => {
        const s = emit(e);
        if (e.kind === "binary" || e.kind === "conditional" || e.kind === "typeof" || e.kind === "new" || e.kind === "arrow" || e.kind === "await") {
            return `(${s})`;
        }
        return s;
    };

    /** Wrap binary children in parens to ensure correct associativity. */
    const wrapIfBinaryChild = (e: IRExpression): string => {
        const s = emit(e);
        if (e.kind === "binary" || e.kind === "conditional") {
            return `(${s})`;
        }
        return s;
    };

    const templateToJs = (parts: IRExpression[]): string => {
        const body = parts.map((p) => {
            if (p.kind === "literal") {
                return escapeTemplatePart(String(p.value === null ? "null" : p.value));
            }
            return `\${${emit(p)}}`;
        }).join("");
        return `\`${body}\``;
    };

    /** Translate a canonical intrinsic op to JavaScript (mostly near-identity). */
    const intrinsicToJs = (e: Extract<IRExpression, { kind: "intrinsic" }>): string => {
        const recv = e.receiver !== null ? wrapIfComplex(e.receiver) : "";
        const args = e.args.map(emit);

        switch (e.op) {
            case "string.length":
            case "array.length":
                return `${recv}.length`;
            case "type-is":
                // args[0] is a string literal, e.g. "string" → typeof recv === "string"
                return `typeof ${recv} === ${args[0]}`;
            case "instance-of":
                return `${recv} instanceof ${literalText(e.args[0])}`;
            case "date.now":
                // Static `Date.now()` — no instance receiver.
                return `Date.now()`;
            case "self":
                // The whole record under a synthesized instance method.
                return `this`;
            case "to-string":
                return `String(${args[0]})`;
            case "to-number":
                return `Number(${args[0]})`;
            default: {
                // Free-standing `Math.<fn>(...)` — near-identity in JS.
                if (e.op.startsWith("math.")) return `Math.${e.op.slice(5)}(${args.join(", ")})`;
                const method = JS_METHOD[e.op];
                if (method !== undefined) return `${recv}.${method}(${args.join(", ")})`;
                // Domain-contributed op with a registry-provided native snippet (decision 11).
                const custom = intrinsicByOp(e.op)?.emit?.js;
                if (custom !== undefined) return custom(e.receiver !== null ? recv : null, args);
                return `__keyma_unsupported_intrinsic__(${JSON.stringify(e.op)})`;
            }
        }
    };

    return emit(expr);
}

/**
 * Lower an IR statement to a JavaScript source string. Shared by validator/formatter
 * registries, compiled utility functions, and method/setter behavior bodies. `opts`
 * is threaded to `exprToJs` so callers can control field-access rendering.
 */
export function stmtToJs(stmt: IRStatement, indent: string, opts: ExprEmitOptions = {}): string {
    switch (stmt.kind) {
        case "return":
            return stmt.value === null
                ? `${indent}return;`
                : `${indent}return ${exprToJs(stmt.value, opts)};`;

        case "if": {
            const cond = exprToJs(stmt.condition, opts);
            const then = stmt.consequent.map((s) => stmtToJs(s, indent + "    ", opts)).join("\n");
            let out = `${indent}if (${cond}) {\n${then}\n${indent}}`;
            if (stmt.alternate && stmt.alternate.length > 0) {
                const alt = stmt.alternate.map((s) => stmtToJs(s, indent + "    ", opts)).join("\n");
                out += ` else {\n${alt}\n${indent}}`;
            }
            return out;
        }

        case "const":
            return `${indent}const ${stmt.name} = ${exprToJs(stmt.init, opts)};`;

        case "expression":
            return `${indent}${exprToJs(stmt.expr, opts)};`;

        case "assign":
            return `${indent}${exprToJs(stmt.target, opts)} = ${exprToJs(stmt.value, opts)};`;

        case "forOf": {
            const iterable = exprToJs(stmt.iterable, opts);
            const body = stmt.body.map((s) => stmtToJs(s, indent + "    ", opts)).join("\n");
            return `${indent}for (const ${stmt.name} of ${iterable}) {\n${body}\n${indent}}`;
        }

        case "while": {
            const cond = exprToJs(stmt.condition, opts);
            const body = stmt.body.map((s) => stmtToJs(s, indent + "    ", opts)).join("\n");
            return `${indent}while (${cond}) {\n${body}\n${indent}}`;
        }

        case "break":
            return `${indent}break;`;

        case "continue":
            return `${indent}continue;`;

        case "switch": {
            // Native, source-faithful `switch` — case bodies are emitted verbatim, so a case
            // without a trailing `break` falls through exactly as authored. `test: null` ⇒ default.
            const disc = exprToJs(stmt.discriminant, opts);
            const lines: string[] = [];
            for (const c of stmt.cases) {
                lines.push(
                    c.test === null
                        ? `${indent}    default:`
                        : `${indent}    case ${exprToJs(c.test, opts)}:`,
                );
                for (const s of c.body) lines.push(stmtToJs(s, indent + "        ", opts));
            }
            return `${indent}switch (${disc}) {\n${lines.join("\n")}\n${indent}}`;
        }
        default:
            // Exhaustiveness guard: every IRStatement kind is handled above.
            throw new Error(`stmtToJs: unsupported IR statement kind "${(stmt as { kind: string }).kind}"`);
    }
}

/** Canonical op id → JS method name (for the method-form intrinsics). */
const JS_METHOD: Record<string, string> = {
    "string.includes": "includes",
    "array.includes": "includes",
    "string.startsWith": "startsWith",
    "string.endsWith": "endsWith",
    "string.toLowerCase": "toLowerCase",
    "string.toUpperCase": "toUpperCase",
    "string.trim": "trim",
    "string.indexOf": "indexOf",
    "array.indexOf": "indexOf",
    "string.slice": "slice",
    "string.charAt": "charAt",
    "string.replace": "replace",
    "array.join": "join",
    "array.filter": "filter",
    "array.map": "map",
    "array.some": "some",
    "array.every": "every",
    "regexp.test": "test",
    "date.getTime": "getTime",
    "date.getFullYear": "getFullYear",
    "date.getMonth": "getMonth",
    "date.getDate": "getDate",
    "date.getDay": "getDay",
    "date.getHours": "getHours",
    "date.getMinutes": "getMinutes",
    "date.getSeconds": "getSeconds",
    "date.getMilliseconds": "getMilliseconds",
    "date.toISOString": "toISOString",
};

/** Read a string-literal arg's raw value (constructor name), or "" if not a literal. */
function literalText(expr: IRExpression | undefined): string {
    return expr !== undefined && expr.kind === "literal" && typeof expr.value === "string" ? expr.value : "";
}

function escapeTemplatePart(s: string): string {
    return s
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\$\{/g, "\\${");
}
