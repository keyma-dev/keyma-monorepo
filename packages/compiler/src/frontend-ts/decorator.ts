import ts from "typescript";
import { isFromModule } from "./util.js";

/**
 * Options parsed from a Keyma class-level decorator call (`@Service` or a domain's class
 * decorator). The union of keys every class decorator may carry; each caller reads only the
 * keys it cares about (a service ignores `ephemeral`, a data-model class ignores nothing,
 * etc.). Kept neutral so the same parser serves every domain's class decorators and the base
 * service pass.
 */
export type DecoratorOptions = {
    name?: string;
    private?: boolean;
    ephemeral?: boolean;
    description?: string;
};

/**
 * Find a named class-level decorator (e.g. "Service", or a domain's own class decorator)
 * imported from `dslModuleName`. Matches by the literal import specifier (via {@link
 * isFromModule}); a domain passes its own DSL module. To match a decorator by its ORIGINAL
 * `@keyma/core/dsl` identity regardless of the umbrella it was imported through, resolve the
 * symbol with {@link isCoreDslSymbol} instead.
 */
export function findKeymaClassDecorator(
    node: ts.ClassDeclaration,
    checker: ts.TypeChecker,
    dslModuleName: string,
    decoratorName: string,
): ts.Decorator | undefined {
    const modifiers = ts.getDecorators(node) ?? node.modifiers;
    if (!modifiers) return undefined;

    for (const modifier of modifiers) {
        if (!ts.isDecorator(modifier)) continue;
        const expr = modifier.expression;
        const ident = ts.isCallExpression(expr) ? expr.expression : expr;
        if (!ts.isIdentifier(ident) || ident.text !== decoratorName) continue;

        const symbol = checker.getSymbolAtLocation(ident);
        if (!symbol) continue;
        if (isFromModule(symbol, checker, dslModuleName)) return modifier;
    }
    return undefined;
}

/**
 * Parse the object-literal options of a Keyma class decorator (`@Service` or a domain's class
 * decorator). Reads `name`/`private`/`ephemeral`/`description`; ignores any other property.
 * Returns an empty object when the decorator carries no argument (or a non-object-literal one).
 */
export function extractDecoratorOptions(decorator: ts.Decorator): DecoratorOptions {
    const expr = decorator.expression;
    if (!ts.isCallExpression(expr) || expr.arguments.length === 0) return {};

    const arg = expr.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return {};

    const opts: DecoratorOptions = {};
    for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const key = prop.name.text;
        const val = prop.initializer;

        if (key === "name" && ts.isStringLiteral(val)) {
            opts.name = val.text;
        } else if (key === "private") {
            if (val.kind === ts.SyntaxKind.TrueKeyword) opts.private = true;
            if (val.kind === ts.SyntaxKind.FalseKeyword) opts.private = false;
        } else if (key === "ephemeral") {
            if (val.kind === ts.SyntaxKind.TrueKeyword) opts.ephemeral = true;
            if (val.kind === ts.SyntaxKind.FalseKeyword) opts.ephemeral = false;
        } else if (key === "description" && ts.isStringLiteral(val)) {
            opts.description = val.text;
        }
    }
    return opts;
}
