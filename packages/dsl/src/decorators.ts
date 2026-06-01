import type { ValidatorRef, FormatterRef, UserValidatorFn, UserFormatterFn } from "./types.js";

export type SchemaOptions = {
    /** Database/canonical collection name. Defaults to the class name (lowercased). */
    name?: string;
    /** When true, this schema is excluded from client-side bundles. */
    private?: boolean;
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

export type EdgeOptions<From, To> = SchemaOptions & {
    /** Source node class. */
    from: new (...args: never[]) => From;
    /** Target node class. */
    to: new (...args: never[]) => To;
    /** Defaults to true. Undirected edges are traversable both ways. */
    directed?: boolean;
    /** Human-readable label (defaults to the class name). */
    label?: string;
    /** Names of the from/to fields on the edge class. Default: "from" and "to". */
    fromField?: string;
    toField?: string;
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
 * @example
 * export const minLength = Validator("minLength", (value: number) =>
 *     (raw: unknown, fieldKey: string, ctx: ValidatorContext): ValidationError | undefined => {
 *         if (typeof raw === "string" && raw.length < value)
 *             return { field: fieldKey, code: "MIN_LENGTH", message: `${fieldKey} must be at least ${value} characters` };
 *     }
 * );
 */
export function Validator<N extends string, F extends (...factoryArgs: any[]) => ((...innerArgs: any[]) => any)>(
    _name: N,
    _factory: F,
): (...args: Parameters<F>) => ValidatorRef<N> {
    return (..._args: Parameters<F>) => ({ __validatorName: _name });
}

/**
 * Declares a named formatter factory. The Keyma compiler reads the factory
 * parameter list and the returned inner function body from the AST and lowers
 * them to IRFormatterDeclaration. At runtime the returned wrapper calls the
 * factory and produces a FormatterRef used by @Format().
 */
export function Formatter<N extends string, F extends (...factoryArgs: any[]) => ((...innerArgs: any[]) => any)>(
    _name: N,
    _factory: F,
): (...args: Parameters<F>) => FormatterRef<N> {
    return (..._args: Parameters<F>) => (<FormatterRef<N>>{ __formatterName: _name });
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
 * Marks a field as ephemeral — it is never persisted to the database.
 * Ephemeral fields exist only in memory (e.g. CSRF tokens, derived UI state).
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Ephemeral(): PropertyDecorator {
    return () => undefined;
}

/**
 * Attaches formatters to a field for a specific input lifecycle phase.
 * A field may carry multiple @Format decorators for different phases.
 *
 * - `"change"` — on every keystroke (e.g. trim, lowercase)
 * - `"blur"`   — when the field loses focus (e.g. normalize)
 * - `"submit"` — before form submission validation
 * - `"save"`   — before persisting to the database
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Format(
    _phase: "change" | "blur" | "submit" | "save",
    ..._formatters: (FormatterRef | UserFormatterFn)[]
): PropertyDecorator {
    return () => undefined;
}

/**
 * Marks a class as an edge schema connecting two node schemas. The compiler
 * records `from`, `to`, and `label` in IR; backends with graph capabilities
 * (or graph emulation) use this to plan traversals.
 *
 * Edge classes are treated as schemas — they have fields, validators, indexes,
 * and visibility — but they additionally carry a `from`/`to` pair. The default
 * field names are `from` and `to` (both `Reference<NodeClass>` typed); pass
 * `fromField`/`toField` to override.
 *
 * Brands the decorated class with `EdgeBrand<From, To>` at the type level so
 * `Keyma.traverse(...)` can type-check step chains.
 *
 * No-op at runtime — the decorator implementation does nothing.
 */
export function Edge<From, To>(
    _options: EdgeOptions<From, To>,
): <C extends new (...args: never[]) => unknown>(cls: C) => C & EdgeBrand<From, To> {
    return ((cls: unknown) => cls) as never;
}
