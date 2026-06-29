// The UI domain's authoring vocabulary + the per-class shapes its frontend stashes while it
// walks the `@UiView`/`@Widget` decorators. The domain is now FRONTEND-ONLY: it synthesizes a
// per-class `view` static (a `json` blob the compiler emits blindly) instead of writing a
// document-level catalog to `ir.extensions['ui']` — so there is no IR-extension contract or
// per-language emitter pack to share. All leaf values are strings, so the synthesized blob is a
// valid JSON object in JS, Python, and as a C++ raw string.

/** The domain id (its `KeymaDomain.name` + `FrontendDomain.name`). */
export const UI_DOMAIN = "ui";

/** Module specifier the UI authoring decorators are imported from. */
export const UI_DSL_MODULE = "@keyma/ui/dsl";

/** One UI widget bound to a field of a view. */
export type UiWidget = {
    /** Source field name the widget renders. */
    field: string;
    /** Widget kind (the `@Widget(kind)` argument), e.g. "text" | "toggle". */
    kind: string;
};

/** One UI view, synthesized from a `@UiView`-decorated class into its `view` static. */
export type UiView = {
    /** The decorated class's `sourceName` (the emit symbol / authored class name). */
    name: string;
    /** Human-readable title (`@UiView({ title })`); "" when omitted. */
    title: string;
    /** Route the view mounts at (`@UiView({ route })`); "" when omitted. */
    route: string;
    /** The `@Widget`-decorated fields of the class, in declaration order. */
    widgets: UiWidget[];
};
