import type { IRExpression } from "@keyma/ir";

/** Lower an IRExpression to a JavaScript source string. */
export function exprToJs(expr: IRExpression): string {
    switch (expr.kind) {
        case "literal":
            return JSON.stringify(expr.value);

        case "field":
            return `this.${expr.name}`;

        case "member":
            return `${wrapIfComplex(expr.object)}.${expr.member}`;

        case "template":
            return templateToJs(expr.parts);

        case "unary":
            return `${expr.op}${wrapIfComplex(expr.operand)}`;

        case "binary":
            return `${wrapIfBinaryChild(expr.left)} ${expr.op} ${wrapIfBinaryChild(expr.right)}`;

        case "conditional":
            return (
                `${wrapIfComplex(expr.condition)} ? ` +
                `${wrapIfComplex(expr.whenTrue)} : ` +
                `${exprToJs(expr.whenFalse)}`
            );

        case "identifier":
            return expr.name;

        case "call": {
            const callee = wrapIfComplex(expr.callee);
            const args = expr.args.map(exprToJs).join(", ");
            return `${callee}(${args})`;
        }

        case "typeof":
            return `typeof (${exprToJs(expr.operand)})`;

        case "object": {
            const props = expr.properties
                .map((p) => `${JSON.stringify(p.key)}: ${exprToJs(p.value)}`)
                .join(", ");
            return `{ ${props} }`;
        }

        case "regexp":
            return `/${expr.pattern}/${expr.flags}`;

        case "arrow": {
            // Parenthesize an object-literal body so it isn't parsed as a block.
            const body = expr.body.kind === "object" ? `(${exprToJs(expr.body)})` : exprToJs(expr.body);
            return `(${expr.params.join(", ")}) => ${body}`;
        }

        case "new": {
            const callee = wrapIfComplex(expr.callee);
            const args = expr.args.map(exprToJs).join(", ");
            return `new ${callee}(${args})`;
        }
    }
}

/** Wrap in parens if this is a complex expression that needs grouping in certain positions. */
function wrapIfComplex(expr: IRExpression): string {
    const s = exprToJs(expr);
    if (expr.kind === "binary" || expr.kind === "conditional" || expr.kind === "typeof" || expr.kind === "new" || expr.kind === "arrow") {
        return `(${s})`;
    }
    return s;
}

/** Wrap binary children in parens to ensure correct associativity. */
function wrapIfBinaryChild(expr: IRExpression): string {
    const s = exprToJs(expr);
    if (expr.kind === "binary" || expr.kind === "conditional") {
        return `(${s})`;
    }
    return s;
}

function templateToJs(parts: IRExpression[]): string {
    const body = parts.map((p) => {
        if (p.kind === "literal") {
            return escapeTemplatePart(String(p.value === null ? "null" : p.value));
        }
        return `\${${exprToJs(p)}}`;
    }).join("");
    return `\`${body}\``;
}

function escapeTemplatePart(s: string): string {
    return s
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\$\{/g, "\\${");
}
