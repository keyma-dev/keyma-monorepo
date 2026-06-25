declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ─── Validator / formatter authoring types ───────────────────────────────────

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
 * use the portable expression subset (see the "@keyma/dsl" README).
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

/**
 * Opaque database identifier. Covers string IDs, integer IDs, ObjectId, UUID-based IDs, etc.
 * Maps to IR type `{ kind: "id" }`.
 */
export type ID = Brand<string, "ID">;

/**
 * Calendar date with no time component (YYYY-MM-DD).
 * Maps to IR type `{ kind: "date" }`.
 */
export type DateOnly = Brand<string, "DateOnly">;

/**
 * An absolute instant (equivalent to the native `Date` type). On the wire it serializes as
 * epoch-milliseconds (`int64`), the canonical cross-runtime format shared by the JS, Python,
 * and C++ runtimes.
 * Maps to IR type `{ kind: "dateTime" }`.
 */
export type DateTime = Date;

/**
 * Time of day with no date (HH:MM:SS).
 * Maps to IR type `{ kind: "time" }`.
 */
export type TimeOfDay = Brand<string, "TimeOfDay">;

/**
 * Arbitrary-precision decimal, represented as a string on the wire.
 * Maps to IR type `{ kind: "decimal" }`.
 */
export type Decimal = Brand<string, "Decimal">;

/**
 * Arbitrary JSON value (array, object, number, boolean, string).
 * Maps to IR type `{ kind: "json" }`.
 */
export type Json = unknown;

/**
 * Binary blob (base64 on the wire).
 * Maps to IR type `{ kind: "bytes" }`.
 */
export type Bytes = Uint8Array;

/**
 * Makes a type nullable (T | null).
 * Maps to IR type `{ kind: "nullable", of: T }`.
 */
export type Nullable<T> = T | null;

/**
 * Explicit foreign reference — stores only the referenced document's ID.
 * Identical to using a bare class type; prefer this when the intent should be obvious.
 * Maps to IR type `{ kind: "reference", schema }`.
 */
export type Reference<T> = T;

/**
 * Inline sub-document — stored embedded in the parent document.
 * Maps to IR type `{ kind: "embedded", schema }`.
 */
export type Embedded<T> = T;
