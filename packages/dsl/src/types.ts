declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ─── Validator / formatter reference types ───────────────────────────────────

/**
 * Opaque reference to a named validator, optionally carrying compile-time params.
 * The name is a type parameter so it survives into emitted `.d.ts` files — the
 * compiler reads it off the call expression's type, which is how it resolves
 * validators imported from compiled packages (e.g. `@keyma/validators`).
 */
export type ValidatorRef<N extends string = string> = { readonly __validatorName: N; readonly params?: Record<string, unknown> };

/** Opaque reference to a named formatter, optionally carrying compile-time params. */
export type FormatterRef<N extends string = string> = { readonly __formatterName: N; readonly params?: Record<string, unknown> };

/** Error shape returned by validator implementations. */
export type ValidationError = { field: string; code: string; message: string };

/** Context object passed to validator/formatter implementations. */
export type ValidatorContext = { object: Record<string, unknown> };

/** Context object passed to formatter implementations. */
export type FormatterContext = { object: Record<string, unknown> };

/** Required function signature for user-defined validator implementations. */
export type UserValidatorFn = (value: unknown, spec: Record<string, unknown>, ctx: ValidatorContext) => ValidationError | null;

/** Required function signature for user-defined formatter implementations. */
export type UserFormatterFn = (value: unknown, spec: Record<string, unknown>, ctx: FormatterContext) => unknown;

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
 * Instant with timezone (ISO 8601). Equivalent to the native `Date` type.
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
 * Arbitrary JSON value (settings, metadata).
 * Maps to IR type `{ kind: "json" }`.
 */
export type Json = unknown;

/**
 * Binary blob (base64 on the wire).
 * Maps to IR type `{ kind: "bytes" }`.
 */
export type Bytes = Uint8Array;

/**
 * Regular expression pattern.
 * Maps to IR type `{ kind: "regexp" }`.
 */
export type Regexp = RegExp;

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
