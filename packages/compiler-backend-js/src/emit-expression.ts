import type { IRExpression, IRStatement } from "@keyma/ir";

export type ExprEmitOptions = {
    /**
     * How a `{ kind: "field" }` reference is rendered. Defaults to `this.<name>`
     * (computed-getter context). Materializers pass `value.<name>` so they can
     * assign computed values onto a plain record without a fragile post-hoc rewrite.
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

            case "regexp":
                return `/${e.pattern}/${e.flags}`;

            case "arrow": {
                // Parenthesize an object-literal body so it isn't parsed as a block.
                const body = e.body.kind === "object" ? `(${emit(e.body)})` : emit(e.body);
                return `(${e.params.join(", ")}) => ${body}`;
            }

            case "new": {
                const callee = wrapIfComplex(e.callee);
                const args = e.args.map(emit).join(", ");
                return `new ${callee}(${args})`;
            }

            case "intrinsic":
                return intrinsicToJs(e);
        }
    };

    /** Wrap in parens if this is a complex expression that needs grouping. */
    const wrapIfComplex = (e: IRExpression): string => {
        const s = emit(e);
        if (e.kind === "binary" || e.kind === "conditional" || e.kind === "typeof" || e.kind === "new" || e.kind === "arrow") {
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
            default: {
                const method = JS_METHOD[e.op];
                if (method !== undefined) return `${recv}.${method}(${args.join(", ")})`;
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
    "regexp.test": "test",
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
