// Runtime schema metadata types — match the shape emitted by @keyma/compiler-backend-js

export type FieldType =
    | { kind: "string" }
    | { kind: "number" }
    | { kind: "integer" }
    | { kind: "bigint" }
    | { kind: "boolean" }
    | { kind: "decimal" }
    | { kind: "bytes" }
    | { kind: "json" }
    | { kind: "date" }
    | { kind: "dateTime" }
    | { kind: "time" }
    | { kind: "id" }
    | { kind: "regexp" }
    | { kind: "enum"; values: string[] }
    | { kind: "array"; of: FieldType; elementNullable?: boolean }
    | { kind: "reference"; schema: string; idType?: FieldType }
    | { kind: "embedded"; schema: string };

/** Context passed to validator/formatter implementations (carries the whole record). */
export type ValidatorContext = { object: Record<string, unknown> };
export type FormatterContext = { object: Record<string, unknown> };

/**
 * A field validator: inspects the value and returns an error or `null`. The
 * compiler re-emits the implementation directly into the generated schema metadata
 * (no name-keyed registry), so it is a callable, not a `{ name, params }` spec.
 */
export type ValidatorFn = (
    value: unknown,
    field: string,
    context: ValidatorContext,
) => ValidationError | null | Promise<ValidationError | null>;

/** A field formatter: transforms the value, returning the new value. */
export type FormatterFn = (
    value: unknown,
    context: FormatterContext,
) => unknown | Promise<unknown>;

/** A formatter bound to a lifecycle phase, attached to a field. */
export type FormatterEntry = {
    phase: string;
    fn: FormatterFn;
};

/** Per-schema initializer that fills a create payload's expression-kind defaults. */
export type SchemaDefaultsFn = (data: Record<string, unknown>) => void;

export type FieldIndex = {
    unique?: boolean;
    sparse?: boolean;
    direction?: 1 | -1 | "text";
    key?: string;
};

export type SchemaIndex = {
    fields: Array<{ name: string; direction: 1 | -1 | "text" }>;
    unique?: boolean;
    sparse?: boolean;
    name?: string;
};

export type FieldDefault =
    | { kind: "literal"; value: unknown }
    | { kind: "expression"; expression: unknown };

export type FormFieldMeta = {
    title?: string;
    hint?: string;
    placeholder?: string;
    group?: string;
    order?: number;
};

export type FieldMetadata = {
    name: string;
    type: FieldType;
    visibility?: "public" | "private";
    readonly?: boolean;
    required?: boolean;
    /** Whether the value may be `null` (orthogonal to `required`). */
    nullable?: boolean;
    validators?: ValidatorFn[];
    formatters?: FormatterEntry[];
    indexes?: FieldIndex[];
    computed?: true;
    ephemeral?: boolean;
    /** Default value applied on create when the key is absent. */
    default?: FieldDefault;
    /** Presentational metadata for form generation. */
    form?: FormFieldMeta;
    /** Deprecation marker — `true`, or a reason string. */
    deprecated?: boolean | string;
};

/** Edge metadata recorded by the compiler from `@Edge` + the `@From()`/`@To()`
 *  endpoint fields. `fromField`/`toField` are the endpoint field names; `from`/
 *  `to` are their node-schema sourceNames; `label` is the schema `name`. On
 *  create the endpoint fields carry node objects (`{ id }`); the server extracts
 *  the id. On read they are returned as `{ id }` objects (populated further when
 *  the projection asks for endpoint sub-fields). */
export type EdgeMetadata = {
    from: string;
    fromField: string;
    to: string;
    toField: string;
    label: string;
    directed: boolean;
};

export type SchemaMetadata = {
    name: string;
    sourceName: string;
    /** Omitted ≡ "public". Private schemas are emitted only into server bundles. */
    visibility?: "public" | "private";
    /** When true, this schema is never persisted to the database. It exists only
     *  for validation/serialization of wire payloads and function I/O, and cannot
     *  be queried through the server. */
    ephemeral?: boolean;
    fields: FieldMetadata[];
    indexes?: SchemaIndex[];
    refs?: ReadonlyMap<string, SchemaClass>;
    /** Present iff the schema is an edge (compiler-frontend recorded an `@Edge` decorator). */
    edge?: EdgeMetadata;
    /** Fills expression-kind field defaults on create. Emitted directly onto the
     *  frozen metadata (no defaults registry). Literal defaults ride in `field.default`. */
    applyDefaults?: SchemaDefaultsFn;
};

export type ValidationError = {
    field: string;
    code: string;
    message: string;
};

// ── Schema class brand ──────────────────────────────────────────────────────
//
// Generated model classes carry their SchemaMetadata as a static `schema`
// property. The record shape is recovered via `InstanceType`.

export interface SchemaClass<T = unknown> {
    new (value?: Partial<T>): T;
    readonly schema: SchemaMetadata;
}

export type RecordOf<C> = C extends new (value?: never) => infer T ? T : never;

// Used in tests (and as a fallback during the codegen transition) to brand a
// plain class with SchemaMetadata at runtime.
export function brandSchema<T>(
    cls: new (value?: Partial<T>) => T,
    schema: SchemaMetadata,
): SchemaClass<T> {
    Object.defineProperty(cls, "schema", {
        value: schema,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return cls as SchemaClass<T>;
}
