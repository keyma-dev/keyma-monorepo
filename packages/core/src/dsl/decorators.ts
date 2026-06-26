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
