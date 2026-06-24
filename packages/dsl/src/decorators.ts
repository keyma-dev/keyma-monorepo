import type { ValidatorFn, FormatterFn } from "./types.js";

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

export type FormFieldOptions = {
    /** Human-readable label for the field in generated forms. */
    title?: string;
    /** Helper/hint text shown alongside the input. */
    hint?: string;
    /** Placeholder text for the input. */
    placeholder?: string;
    /** Logical group/section the field belongs to. */
    group?: string;
    /** Sort order within its group. */
    order?: number;
};

/**
 * Attaches presentational metadata used to generate forms (label, hint,
 * placeholder, grouping, ordering). Carried into the IR and emitted as field
 * metadata + `.d.ts` JSDoc; never affects persistence or validation.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function FormField(_options?: FormFieldOptions): PropertyDecorator {
    return () => undefined;
}

/**
 * Marks a field as deprecated, optionally with a reason. Surfaces as an
 * `@deprecated` JSDoc tag in generated `.d.ts` and as field metadata.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Deprecated(_reason?: string): PropertyDecorator {
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

export type ServiceOptions = {
    /** Service name used on the wire and as the generated class name. Defaults to the class name. */
    name?: string;
    /** When true, this service is excluded from client-side bundles and is uncallable by non-system callers. */
    private?: boolean;
    /** Human-readable description of this service. */
    description?: string;
};

/**
 * Marks an `abstract class` as a Keyma service — a group of remotely-callable
 * functions. The compiler extracts each abstract method's signature (name, typed
 * parameters, return type, visibility) into IR; bodies are never compiled. The
 * server implements the service by extending the generated abstract base class;
 * the client invokes methods type-safely via `Keyma.call(Service, "method", args)`.
 *
 * Service inputs/outputs are typically `@Schema({ ephemeral: true })` classes so
 * arguments are validated and results hydrated, but primitives are allowed too.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Service(_options?: ServiceOptions): ClassDecorator {
    return () => undefined;
}
