import type { ValidatorRef, FormatterRef, UserValidatorFn, UserFormatterFn, DateTime, ID } from "./types.js";

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

/**
 * Phantom brand carried on edge classes at the type level. Reads as
 * "this class represents an edge whose source is `From` and target is `To`."
 * Used by Keyma.traverse(...) to type-check step chains.
 */
declare const __edgeBrand: unique symbol;
export interface EdgeBrand<From, To> {
    readonly [__edgeBrand]: { from: From; to: To };
}

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
 * Declares a named validator factory. The Keyma compiler reads the factory
 * parameter list and the returned inner function body from the AST and lowers
 * them to IRValidatorDeclaration. At runtime the returned wrapper calls the
 * factory and produces a ValidatorRef used by @Validate().
 *
 * The name is inferred from the exported `const` binding (`Validator(fn)`), or
 * given explicitly when it must differ (`Validator("name", fn)`).
 *
 * @remarks
 * The factory and its inner function must use the portable expression subset —
 * the `value` parameter must be concretely typed, and only intrinsic method calls
 * are allowed. See the "@keyma/dsl" README → "Portable expression subset".
 *
 * @example
 * export const minLength = Validator((value: number) =>
 *     (raw: string, fieldKey: string, ctx: ValidatorContext): ValidationError | undefined => {
 *         if (raw.length < value)
 *             return { field: fieldKey, code: "MIN_LENGTH", message: `${fieldKey} must be at least ${value} characters` };
 *     }
 * );
 */
export function Validator<F extends Factory>(
    factory: F,
): (...args: Parameters<F>) => ValidatorRef<string>;
export function Validator<N extends string, F extends Factory>(
    name: N,
    factory: F,
): (...args: Parameters<F>) => ValidatorRef<N>;
export function Validator(
    nameOrFactory: string | Factory,
    _factory?: Factory,
): (...args: unknown[]) => ValidatorRef {
    const name = typeof nameOrFactory === "string" ? nameOrFactory : "";
    return () => ({ __validatorName: name });
}

/** A validator/formatter factory: outer args → an inner `(value, ...) => result` function. */
type Factory = (...factoryArgs: any[]) => ((...innerArgs: any[]) => any);

/**
 * Declares a named formatter factory. The Keyma compiler reads the factory
 * parameter list and the returned inner function body from the AST and lowers
 * them to IRFormatterDeclaration. At runtime the returned wrapper calls the
 * factory and produces a FormatterRef used by @Format().
 */
export function Formatter<F extends Factory>(
    factory: F,
): (...args: Parameters<F>) => FormatterRef<string>;
export function Formatter<N extends string, F extends Factory>(
    name: N,
    factory: F,
): (...args: Parameters<F>) => FormatterRef<N>;
export function Formatter(
    nameOrFactory: string | Factory,
    _factory?: Factory,
): (...args: unknown[]) => FormatterRef {
    const name = typeof nameOrFactory === "string" ? nameOrFactory : "";
    return () => ({ __formatterName: name });
}

/**
 * Attaches validators to a field. The compiler reads each argument from the AST
 * and lowers it to the corresponding IRValidator.
 *
 * Accepts ValidatorRef markers (from factory functions) or direct UserValidatorFn references.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Validate(..._validators: (ValidatorRef | UserValidatorFn)[]): PropertyDecorator {
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
 * Default-value generators recognized by `@Default(...)`. The compiler resolves
 * them by identity (name), lowering to a `{ kind: "generator" }` default that the
 * runtime evaluates at create time. Their runtime bodies are illustrative only.
 */
export const Now: () => DateTime = () => new Date();
export const Uuid: () => ID = () => "" as ID;

/**
 * Sets a field's default value, applied on create when the key is absent. Accepts
 * a literal (`@Default("active")`, `@Default(0)`) or a named generator
 * (`@Default(Now)`, `@Default(Uuid)`). A defaulted field is optional on create
 * input but always present in the stored record.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Default(_value: unknown): PropertyDecorator {
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
 * Marks a getter as a computed field. Only getters carrying `@Computed()` are
 * extracted as fields; the getter body is lowered to a portable expression and
 * re-emitted by backends (as a getter and a materializer). An undecorated getter
 * is ignored; applying `@Computed()` to a non-getter is an error.
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
    ..._formatters: (FormatterRef | UserFormatterFn)[]
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
 * The compiler-generated edge class is branded with `EdgeBrand<From, To>` at
 * the type level (derived from the `@From()`/`@To()` field types) so
 * `Keyma.traverse(...)` can type-check step chains. The authored DSL class
 * itself is not branded.
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
