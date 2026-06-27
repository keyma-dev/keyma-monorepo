// Domain-neutral DSL decorators. The schema-domain field decorators @Validate/@Format
// (and the validator/formatter contract types they consume) live in `@keyma/schema/dsl`.
//
// No-op at runtime — every decorator implementation does nothing. Decorators are
// compile-time annotations only; the Keyma compiler reads them via the TS API.

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
