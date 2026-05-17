declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

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
