// The UI-domain authoring surface. Unlike `@keyma/schema/dsl` (which re-exports the neutral
// `@keyma/core/dsl`), the UI smoke ships only its own two decorators — a UI author imports
// schema decorators from `@keyma/schema/dsl` and UI decorators from `@keyma/ui/dsl`.
export { UiView, Widget } from "./decorators.js";
export type { UiViewOptions, WidgetOptions, WidgetKind } from "./decorators.js";
