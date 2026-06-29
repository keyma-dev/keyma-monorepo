import ts from "typescript";
import { staticMember, obj, arrayExpr, literal } from "@keyma/core/ir";
import type { IRClassDeclaration, IRMember, IRExpression } from "@keyma/core/ir";
import type {
    FrontendDomain, DomainBaseContext, DomainContext,
} from "@keyma/compiler/frontend-ts";
import { UI_DOMAIN, UI_DSL_MODULE, type UiWidget } from "../extension.js";

const VIEW_DECORATOR = "UiView";
const WIDGET_DECORATOR = "Widget";

/**
 * The per-class view data the UI frontend accumulates while it walks a class's decorators.
 * `isView` is set the moment the class's `@UiView` is dispatched; `widgets` accrues each
 * `@Widget`-decorated field in declaration order (a member handler may fire before or after the
 * class handler, so both use get-or-create). Synthesized into the `view` static in `afterNormalize`.
 */
type StashedView = {
    isView: boolean;
    title: string;
    route: string;
    widgets: UiWidget[];
};

/** The UI domain's per-compile state: the accumulated view data, keyed by the class IR node. */
type UiState = {
    views: WeakMap<IRClassDeclaration, StashedView>;
};

/**
 * The UI frontend domain — now FRONTEND-ONLY (no per-language backend pack). It owns the
 * `@UiView` (class) and `@Widget` (member) decorators: their handlers stash each view's
 * `{ title, route }` + ordered widget list into `ctx.state`, and `afterNormalize` synthesizes a
 * per-class `view` STATIC member (a `{kind:"json"}` object literal) that the compiler's generic
 * static-member emission renders blindly (JS/Python as a structured literal, C++ as a JSON string).
 *
 * It depends only on `@keyma/compiler/frontend-ts` + `@keyma/core`, never on `@keyma/schema`, so it
 * composes with the schema domain without interference: a class without `@UiView` gains no static
 * (so NON-`@UiView` output stays byte-identical with or without this domain), and the schema domain
 * is equally blind to `@UiView`. There is no longer a document-level `ir.extensions['ui']` slice.
 */
export const uiFrontendDomain: FrontendDomain = {
    name: UI_DOMAIN,
    dslModule: UI_DSL_MODULE,

    init(_ctx: DomainBaseContext): UiState {
        return { views: new WeakMap() };
    },

    decorators: [
        {
            // `@UiView({ title, route })` marks the class as a view and records its options.
            name: VIEW_DECORATOR,
            module: UI_DSL_MODULE,
            target: "class",
            handle(deco, ir, ctx) {
                const stash = stashOf(ctx.state as UiState, ir as IRClassDeclaration);
                stash.isView = true;
                const { title, route } = readViewOptions(deco);
                stash.title = title;
                stash.route = route;
            },
        },
        {
            // `@Widget(kind)` binds the field to a widget; appended to the owning view in order.
            name: WIDGET_DECORATOR,
            module: UI_DSL_MODULE,
            target: "member",
            handle(deco, ir, ctx) {
                const stash = stashOf(ctx.state as UiState, ctx.class);
                stash.widgets.push({ field: (ir as IRMember).name, kind: readWidgetKind(deco) });
            },
        },
    ],

    /**
     * Post-normalize: synthesize the `view` static on each `@UiView` class. The static's value is a
     * `json` object literal `{ name, title, route, widgets: [{ field, kind }, …] }` (the same shape
     * the legacy document catalog carried, with `name` = the class's `sourceName`). The `{kind:"json"}`
     * type makes the compiler render it as an introspective data blob. A class never marked `@UiView`
     * gets no static — leaving its output byte-identical to a UI-domain-free build.
     */
    afterNormalize(classes: readonly IRClassDeclaration[], _nameMap, ctx: DomainContext): void {
        const state = ctx.state as UiState;
        for (const cls of classes) {
            const stash = state.views.get(cls);
            if (stash === undefined || !stash.isView) continue;
            const value: IRExpression = obj({
                name: literal(cls.sourceName),
                title: literal(stash.title),
                route: literal(stash.route),
                widgets: arrayExpr(
                    stash.widgets.map((w) => obj({ field: literal(w.field), kind: literal(w.kind) })),
                ),
            });
            const view = staticMember({ name: "view", value, type: { kind: "json" } });
            cls.statics = [...(cls.statics ?? []), view];
        }
    },
};

/** Get-or-create the per-class view stash in the domain state. */
function stashOf(state: UiState, cls: IRClassDeclaration): StashedView {
    let stash = state.views.get(cls);
    if (stash === undefined) {
        stash = { isView: false, title: "", route: "", widgets: [] };
        state.views.set(cls, stash);
    }
    return stash;
}

/** Read `{ title, route }` string options off the `@UiView(...)` decorator node; "" when absent. */
function readViewOptions(deco: ts.Decorator): { title: string; route: string } {
    let title = "";
    let route = "";
    const expr = deco.expression;
    if (ts.isCallExpression(expr) && expr.arguments.length > 0) {
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
function readWidgetKind(deco: ts.Decorator): string {
    const expr = deco.expression;
    if (ts.isCallExpression(expr) && expr.arguments.length > 0) {
        const arg = expr.arguments[0];
        if (arg !== undefined && ts.isStringLiteralLike(arg)) return arg.text;
    }
    return "";
}
