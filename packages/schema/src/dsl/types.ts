// Validator / formatter authoring and contract types — the function shapes a schema
// author's `@Validate`/`@Format` factories type-check against. These are schema-domain
// types (they pair with the schema decorators in this same surface); the domain-neutral
// semantic types (`ID`, `DateTime`, `Reference`, …) live in `@keyma/core/dsl` and are
// re-exported alongside these by `@keyma/schema/dsl` (see index.ts).

/** Error shape returned by validator implementations. */
export type ValidationError = { field: string; code: string; message: string };

/** Context passed to validator implementations (carries the whole record). */
export type ValidatorContext = { object: Record<string, unknown> };

/** Context passed to formatter implementations (carries the whole record). */
export type FormatterContext = { object: Record<string, unknown> };

/**
 * A validator: inspects a single field `value` and returns a {@link ValidationError}
 * or `null`. Authored as a plain factory function returning this signature, e.g.
 *
 * ```ts
 * export function minLength(m: number): ValidatorFn<string> {
 *     return (value, field) => value.length < m
 *         ? { field, code: "minLength", message: `${field} must be at least ${m} characters` }
 *         : null;
 * }
 * ```
 *
 * The Keyma compiler reads the factory's parameter list and the returned function's
 * body from the AST, lowers them to IR, and re-emits the implementation directly
 * into the generated schema (no runtime registry). The `<T>` type argument is the
 * value type the field carries; backends emit a runtime guard from it. The body must
 * use the portable expression subset (see the DSL README).
 */
export type ValidatorFn<T = unknown> = (value: T, field: string, ctx: ValidatorContext) => ValidationError | null;

/**
 * A formatter: transforms a single field `value`, returning the new value. Authored
 * as a plain factory function returning this signature, e.g.
 *
 * ```ts
 * export function trim(): FormatterFn<string> {
 *     return (value) => value.trim();
 * }
 * ```
 */
export type FormatterFn<T = unknown> = (value: T, ctx: FormatterContext) => T;
