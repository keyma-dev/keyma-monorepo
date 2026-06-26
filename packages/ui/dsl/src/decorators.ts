// The UI-domain authoring decorators. Like every Keyma decorator these are compile-time
// annotations only — no-ops at runtime; the compiler reads them via the TS API (the UI
// frontend domain recognizes them by their `@keyma/ui/dsl` import specifier) and never
// executes or emits them.

export type UiViewOptions = {
    /** Human-readable title for the view. */
    title?: string;
    /** Route/path the view is mounted at. */
    route?: string;
};

/** The widget kinds a `@Widget`-decorated field may declare. */
export type WidgetKind = "text" | "number" | "toggle" | "select" | "date";

export type WidgetOptions = {
    /** Optional override label; defaults to the field name. */
    label?: string;
};

/**
 * Marks a class as a UI view. The UI frontend domain discovers classes carrying this
 * decorator and records their `@Widget` fields under `ir.extensions['ui']`.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function UiView(_options?: UiViewOptions): ClassDecorator {
    return () => undefined;
}

/**
 * Binds a field to a UI widget of the given kind. Collected by the UI frontend domain into
 * the enclosing view's `widgets`.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Widget(_kind: WidgetKind, _options?: WidgetOptions): PropertyDecorator {
    return () => undefined;
}
