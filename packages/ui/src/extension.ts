// The UI domain's IR contract: the shape written into `ir.extensions['ui']` by the frontend
// domain and read back by the per-language emitter packs. Kept in the package root (`src/`)
// so the frontend and all three backends share one definition. All leaf values are strings,
// so the JSON serialization (see `viewsJson`) is valid in JS, Python, and as a C++ raw string.

/** The domain id the UI domain namespaces its IR + emitted artifacts under. */
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

/** One UI view, extracted from a `@UiView`-decorated class. */
export type UiView = {
    /** The decorated class name. */
    name: string;
    /** Human-readable title (`@UiView({ title })`); "" when omitted. */
    title: string;
    /** Route the view mounts at (`@UiView({ route })`); "" when omitted. */
    route: string;
    /** The `@Widget`-decorated fields of the class, in declaration order. */
    widgets: UiWidget[];
};

/** The document-level UI slice carried at `ir.extensions['ui']`. */
export type UiExtension = {
    views: UiView[];
};

/**
 * Read the UI domain's slice out of an IR document, or `undefined` when the document carries
 * none (a build with no `@UiView` classes, or no UI domain at all). The single place the
 * `ir.extensions['ui']` key + cast is centralized, shared by all three backend packs.
 */
export function readUiExtension(ir: { extensions?: Record<string, unknown> }): UiExtension | undefined {
    const ext = ir.extensions?.[UI_DOMAIN];
    if (ext === undefined) return undefined;
    return ext as UiExtension;
}

/** Serialize a UI extension's views to the JSON embedded in every emitted views module. */
export function viewsJson(ext: UiExtension): string {
    return JSON.stringify(ext.views, null, 2);
}
