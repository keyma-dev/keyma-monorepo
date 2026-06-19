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
            return expr.name;

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
            return `re.compile(r${JSON.stringify(expr.pattern)})`; // Requires import re

        case "arrow": {
            const body = exprToPython(expr.body);
            return `lambda ${expr.params.join(", ")}: ${body}`;
        }

        case "new": {
            const callee = wrapIfComplex(expr.callee);
            const args = expr.args.map(exprToPython).join(", ");
            return `${callee}(${args})`;
        }
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

function templateToPython(parts: IRExpression[]): string {
    const body = parts.map((p) => {
        if (p.kind === "literal") {
            return escapeTemplatePart(String(p.value === null ? "None" : p.value));
        }
        return `{${exprToPython(p)}}`;
    }).join("");
    return `f"${body}"`;
}

function escapeTemplatePart(s: string): string {
    return s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/{/g, "{{")
        .replace(/}/g, "}}");
}
