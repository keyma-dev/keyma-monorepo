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
 *  `to` are their node-schema `name`s; `label` is the edge schema's `name`. On
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
    /** Canonical identity — the registry / wire / reference key. */
    name: string;
    /** Authored TS class name. Emit-symbol/informational only; never a lookup key
     *  (references and the registry use `name`). */
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

// ── Service metadata ────────────────────────────────────────────────────────
//
// Generated service classes carry their contract as a static `service` property
// (the analog of a model's static `schema`). The server reads it off each
// registered instance's constructor to discover callable methods; the client
// reads it (plus `refs`) to marshal calls and hydrate results.

export type ServiceParamMetadata = {
    name: string;
    /** Schema `name` when the param type is a schema reference — used for
     *  argument validation on the server and (via `refs`) nothing on the client.
     *  Absent for primitive params. */
    schema?: string;
};

export type ServiceMethodMetadata = {
    name: string;
    /** Omitted ≡ "public". Private methods are emitted only into server bundles
     *  and are uncallable by non-system callers. */
    visibility?: "public" | "private";
    params: ServiceParamMetadata[];
    /** Schema `name` of the return value when it is a schema (drives client
     *  hydration). Absent for primitive returns. */
    returnSchema?: string;
    /** Whether the return value is an array of `returnSchema` (element-wise hydration). */
    returnArray?: boolean;
};

export type ServiceMetadata = {
    name: string;
    /** Omitted ≡ "public". Private services are emitted only into server bundles. */
    visibility?: "public" | "private";
    methods: ServiceMethodMetadata[];
    /** Schema name → generated model class, for hydrating schema-typed returns.
     *  Present on client bundles. */
    refs?: ReadonlyMap<string, SchemaClass>;
};

/** A generated service class carrying its contract as a static `service`. */
export interface ServiceClass {
    readonly service: ServiceMetadata;
}

/** A constructed service instance. Its class carries the contract as a `static
 *  service` (read off `instance.constructor` at registration). Typed loosely
 *  because TypeScript types an instance's `.constructor` as plain `Function`;
 *  the real contract guarantee comes from extending the generated abstract class. */
export type ServiceInstance = object;

/** What the application registers with `KeymaServer({ services })`: an instance
 *  or a zero-arg factory producing one. */
export type ServiceProvider = ServiceInstance | (() => ServiceInstance);

// ── Request context ─────────────────────────────────────────────────────────
//
// Ambient per-request context threaded through server operations, plugin hooks,
// and service-method calls. Free-form; `identity` is the conventional auth slot.

export type RequestContext = {
    identity?: {
        id?: string;
        roles?: readonly string[];
        isSystem?: boolean;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};
