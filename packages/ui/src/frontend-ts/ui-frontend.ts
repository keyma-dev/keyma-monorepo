import ts from "typescript";
import { isFromModule } from "@keyma/compiler/frontend-ts";
import type { FrontendDomain, DomainContext } from "@keyma/compiler/frontend-ts";
import { UI_DOMAIN, UI_DSL_MODULE, type UiExtension, type UiView, type UiWidget } from "../extension.js";

const VIEW_DECORATOR = "UiView";
const WIDGET_DECORATOR = "Widget";

/**
 * The UI frontend domain in the inverted control flow: a declarative descriptor whose artifact is
 * a program-wide scan, not per-class IR enrichment. It registers NO IR-mutating decorators — a
 * `@UiView` class is lowered by the compiler as an ordinary data class (so the schema IR sections
 * are byte-identical with or without this domain) — and contributes a single document-level slice
 * via `documentExtension`: the catalog of `@UiView` classes (and their `@Widget` fields) imported
 * from `@keyma/ui/dsl`, written to `ir.extensions['ui']`. It depends only on
 * `@keyma/compiler/frontend-ts` (the neutral recognition helper `isFromModule`) and `@keyma/core`,
 * never on `@keyma/schema`, so it composes with the schema domain without interference: a class
 * without `@UiView` is invisible to it, and the schema domain is equally blind to `@UiView`.
 */
export const uiFrontendDomain: FrontendDomain = {
    name: UI_DOMAIN,
    dslModule: UI_DSL_MODULE,
    decorators: [],
    documentExtension(program: ts.Program, ctx: DomainContext): UiExtension | undefined {
        const { checker } = ctx;
        const dslModule = ctx.dslModuleName ?? UI_DSL_MODULE;
        const views: UiView[] = [];

        for (const sf of program.getSourceFiles()) {
            if (sf.isDeclarationFile) continue;
            ts.forEachChild(sf, (node) => {
                if (!ts.isClassDeclaration(node) || node.name === undefined) return;
                if (findDecorator(node, checker, dslModule, VIEW_DECORATOR) === undefined) return;

                const { title, route } = readViewOptions(node, checker, dslModule);
                const widgets: UiWidget[] = [];
                for (const member of node.members) {
                    if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
                    const widget = findDecorator(member, checker, dslModule, WIDGET_DECORATOR);
                    if (widget === undefined) continue;
                    widgets.push({ field: member.name.text, kind: readWidgetKind(widget) });
                }

                views.push({ name: node.name.text, title, route, widgets });
            });
        }

        // Returning undefined contributes nothing (the driver omits the `ui` extension key).
        return views.length > 0 ? { views } : undefined;
    },
};

/**
 * Find a `@Name(...)`/`@Name` decorator on a class or property whose identifier resolves to an
 * import from `dslModule`. The specifier gate (via `isFromModule`) is what keeps a UI domain
 * from claiming an identically-named decorator from some other package.
 */
function findDecorator(
    node: ts.HasDecorators,
    checker: ts.TypeChecker,
    dslModule: string,
    name: string,
): ts.Decorator | undefined {
    for (const decorator of ts.getDecorators(node) ?? []) {
        const expr = decorator.expression;
        const ident = ts.isCallExpression(expr) ? expr.expression : expr;
        if (!ts.isIdentifier(ident) || ident.text !== name) continue;
        const symbol = checker.getSymbolAtLocation(ident);
        if (symbol !== undefined && isFromModule(symbol, checker, dslModule)) return decorator;
    }
    return undefined;
}

/** Read `{ title, route }` string options off the `@UiView(...)` decorator; "" when absent. */
function readViewOptions(
    node: ts.ClassDeclaration,
    checker: ts.TypeChecker,
    dslModule: string,
): { title: string; route: string } {
    let title = "";
    let route = "";
    const view = findDecorator(node, checker, dslModule, VIEW_DECORATOR);
    const expr = view?.expression;
    if (expr !== undefined && ts.isCallExpression(expr) && expr.arguments.length > 0) {
        const arg = expr.arguments[0];
        if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
                if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
                if (!ts.isStringLiteralLike(prop.initializer)) continue;
                if (prop.name.text === "title") title = prop.initializer.text;
                else if (prop.name.text === "route") route = prop.initializer.text;
            }
        }
    }
    return { title, route };
}

/** Read the first string-literal argument of `@Widget(kind)`; "" when absent. */
function readWidgetKind(decorator: ts.Decorator): string {
    const expr = decorator.expression;
    if (ts.isCallExpression(expr) && expr.arguments.length > 0) {
        const arg = expr.arguments[0];
        if (arg !== undefined && ts.isStringLiteralLike(arg)) return arg.text;
    }
    return "";
}
