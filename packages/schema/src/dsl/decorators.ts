// Schema-domain DSL decorators, including the field-level @Validate/@Format and the
// validator/formatter authoring types they consume (see ./types.ts). The remaining
// domain-neutral decorators (@FormField, @Deprecated, @Service, and the binary-wire-tag
// field decorators @Tag/@RenamedFrom) and the semantic types (`ID`, `DateTime`, …) live
// in `@keyma/core/dsl`; `@keyma/schema/dsl` (see index.ts) re-exports those alongside
// these so a schema author imports the whole surface from one specifier.
//
// No-op at runtime — every decorator implementation does nothing. Decorators are
// compile-time annotations only; the Keyma compiler reads them via the TS API and
// never executes or emits them.

import type { ValidatorFn, FormatterFn } from "./types.js";

/**
 * Attaches validators to a field. Each argument is a {@link ValidatorFn} produced
 * by calling a validator factory, e.g. `@Validate(minLength(2), isEmail())`. The
 * compiler resolves each factory to its declaration, lowers its body to IR, and
 * re-emits the implementation directly into the generated schema.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Validate(..._validators: ValidatorFn<any>[]): PropertyDecorator {
    return () => undefined;
}

/**
 * Named lifecycle phases for `@Format`. Use these constants for autocomplete and
 * typo safety — `@Format(Phase.Save, ...)` is identical to `@Format("save", ...)`.
 *
 * - `Change` — on every keystroke (e.g. trim, lowercase)
 * - `Blur`   — when the field loses focus (e.g. normalize)
 * - `Submit` — before form submission validation
 * - `Save`   — before persisting to the database
 */
export const Phase = {
    Change: "change",
    Blur: "blur",
    Submit: "submit",
    Save: "save",
} as const;

/** A `@Format` lifecycle phase — a value of {@link Phase} (or the bare string literal). */
export type FormatPhase = (typeof Phase)[keyof typeof Phase];

/**
 * Attaches formatters to a field for a specific input lifecycle phase.
 * A field may carry multiple @Format decorators for different phases. Pass a
 * {@link Phase} constant or the equivalent string literal.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Format(
    _phase: FormatPhase,
    ..._formatters: FormatterFn<any>[]
): PropertyDecorator {
    return () => undefined;
}

export type SchemaOptions = {
    /** Database/canonical collection name. Defaults to the class name (lowercased). */
    name?: string;
    /** When true, this schema is excluded from client-side bundles. */
    private?: boolean;
    /** When true, this schema is never persisted to the database. Used for
     *  wire payloads and function-call inputs/outputs. */
    ephemeral?: boolean;
    /** Human-readable description of this schema. */
    description?: string;
};

export type EdgeOptions = SchemaOptions & {
    /** Defaults to true. Undirected edges are traversable both ways. */
    directed?: boolean;
};

export type IndexOptions = {
    /** Enforce uniqueness across the indexed field(s). */
    unique?: boolean;
    /** Only index documents where the field exists. */
    sparse?: boolean;
    /** Index direction: 1 (ascending), -1 (descending), or "text" (full-text search). */
    direction?: 1 | -1 | "text";
    /** Composite index key. Fields sharing the same key form one compound index. */
    key?: string;
};

/**
 * Marks a class as a Keyma schema. The compiler discovers classes carrying this
 * decorator and extracts their fields, validators, and formatters into IR.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Schema(_options?: SchemaOptions): ClassDecorator {
    return () => undefined;
}

/**
 * Creates a single-field index. Options control uniqueness, sparseness, and text indexing.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Indexed(_options?: IndexOptions): PropertyDecorator {
    return () => undefined;
}

/**
 * Marks a field as ephemeral — it is never persisted to the database.
 * Ephemeral fields exist only in memory (e.g. CSRF tokens, derived UI state).
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Ephemeral(): PropertyDecorator {
    return () => undefined;
}

/**
 * Marks a getter's intent to become a stored/indexed **computed field**. That
 * capability (persistence, indexing, materialization) is **deferred to a future
 * release**: today every getter — decorated or not — is emitted as a plain class
 * accessor (a behavior), never as a schema field, and `@Computed()`/`@Indexed()`
 * on a getter are reported with a warning (`KEYMA098`) and otherwise ignored.
 * Applying `@Computed()` to a non-getter is an error (`KEYMA019`).
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Computed(): PropertyDecorator {
    return () => undefined;
}

/**
 * Marks a class as an edge schema connecting two node schemas. The compiler
 * records `from`, `to`, and the traversal label (the schema `name`) in IR;
 * backends with graph capabilities (or graph emulation) use this to plan
 * traversals.
 *
 * Edge classes are treated as schemas — they have fields, validators, indexes,
 * and visibility — but they additionally carry a `from`/`to` pair, identified
 * by the `@From()` and `@To()` field decorators. Each endpoint field's target
 * node schema is its declared type (bare class `T` or `Reference<T>`); the
 * endpoint fields are indexed automatically.
 *
 * The compiler-generated edge class carries a structural `__edge` type marker
 * (derived from the `@From()`/`@To()` field types) so `Keyma.traverse(...)` can
 * type-check step chains. The authored DSL class itself is not marked.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Edge(_options?: EdgeOptions): ClassDecorator {
    return () => undefined;
}

/**
 * Marks the source-endpoint field of an `@Edge` schema. The field's declared
 * type (a bare node class `T` or `Reference<T>`) names the source node schema.
 * Auto-indexed by the compiler. Exactly one `@From()` is required per edge.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function From(): PropertyDecorator {
    return () => undefined;
}

/**
 * Marks the target-endpoint field of an `@Edge` schema. The field's declared
 * type (a bare node class `T` or `Reference<T>`) names the target node schema.
 * Auto-indexed by the compiler. Exactly one `@To()` is required per edge.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function To(): PropertyDecorator {
    return () => undefined;
}
