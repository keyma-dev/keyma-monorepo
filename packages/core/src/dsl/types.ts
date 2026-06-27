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
 * Signed integer. `Bits` ∈ 8 | 16 | 32 | 64 (default 64).
 * Maps to IR type `{ kind: "integer", bits }` (`bits` omitted when 64).
 * Width is honored in C++ (`std::int8_t`…`int64_t`); JS sees `number`, Python `int`.
 * A literal default (`q: Integer = 0`) needs `declare`/a cast, like other branded types.
 */
export type Integer<Bits extends 8 | 16 | 32 | 64 = 64> = Brand<number, `Integer${Bits}`>;

/**
 * Unsigned integer. `Bits` ∈ 8 | 16 | 32 | 64 (default 64).
 * Maps to IR type `{ kind: "integer", bits, unsigned: true }` (`bits` omitted when 64).
 * Width is honored in C++ (`std::uint8_t`…`uint64_t`); JS sees `number`, Python `int`.
 */
export type Unsigned<Bits extends 8 | 16 | 32 | 64 = 64> = Brand<number, `Unsigned${Bits}`>;

/**
 * Floating point. `Bits` ∈ 32 | 64 (default 64).
 * Maps to IR type `{ kind: "number", bits }` (`bits` omitted when 64).
 * Width is honored in C++ (`float` / `double`); JS sees `number`, Python `float`.
 */
export type Float<Bits extends 32 | 64 = 64> = Brand<number, `Float${Bits}`>;

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
 * Explicit foreign reference
 * Identical to using a bare class type; prefer this when the intent should be obvious.
 * Maps to IR type `{ kind: "reference", target }`.
 */
export type Reference<T> = T;

/**
 * Inline sub-document — stored embedded in the parent document.
 * Maps to IR type `{ kind: "embedded", target }`.
 */
export type Embedded<T> = T;
