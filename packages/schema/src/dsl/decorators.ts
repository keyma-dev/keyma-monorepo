// Schema-domain DSL decorators. The domain-neutral decorators (@Validate, @Format,
// @FormField, @Deprecated, @Service) and all semantic/authoring types live in
// `@keyma/core/dsl`; `@keyma/schema/dsl` (see index.ts) re-exports those alongside
// these so a schema author imports the whole surface from one specifier.
//
// No-op at runtime — every decorator implementation does nothing. Decorators are
// compile-time annotations only; the Keyma compiler reads them via the TS API and
// never executes or emits them.

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

/**
 * Pins a field's **stable binary wire tag** explicitly, overriding the
 * compiler-auto-assigned tag from the committed manifest (`keyma.tags.json`). The
 * escape hatch for full manual control: `@Tag(7) name: string`. `n` must be a
 * positive integer literal in range (1 .. 2^31-1). The tag allocator routes around
 * pinned tags. Used only when binary serialization is enabled.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Tag(_n: number): PropertyDecorator {
    return () => undefined;
}

/**
 * Carries a field's **stable binary wire tag across a rename**: `@RenamedFrom("oldName")
 * newName: string` moves the tag committed to `oldName` in the manifest onto `newName`
 * (no tombstone, no drift error). The primary, reviewable mechanism for evolving a
 * schema whose records are stored durably in binary. `oldName` must exist in the
 * committed manifest for this schema. Used only when binary serialization is enabled.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function RenamedFrom(_oldName: string): PropertyDecorator {
    return () => undefined;
}
