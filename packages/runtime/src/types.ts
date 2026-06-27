// Runtime schema metadata types — match the shape emitted by @keyma/compiler/backend-js

export type FieldType =
    | { kind: "string" }
    | { kind: "number"; bits?: 32 | 64 }
    | { kind: "integer"; bits?: 8 | 16 | 32 | 64; unsigned?: boolean }
    | { kind: "bigint" }
    | { kind: "boolean" }
    | { kind: "decimal" }
    | { kind: "bytes" }
    | { kind: "json" }
    | { kind: "date" }
    | { kind: "dateTime" }
    | { kind: "time" }
    | { kind: "id" }
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
) => ValidationError | null;

/** A field formatter: transforms the value, returning the new value. Synchronous — async
 *  formatters are rejected at the frontend (KEYMA026). */
export type FormatterFn = (
    value: unknown,
    context: FormatterContext,
) => unknown;

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
    ephemeral?: boolean;
    /** Default value applied on create when the key is absent. */
    default?: FieldDefault;
    /** Presentational metadata for form generation. */
    form?: FormFieldMeta;
    /** Deprecation marker — `true`, or a reason string. */
    deprecated?: boolean | string;
    /** Stable wire tag for binary serialization (from the committed tag manifest).
     *  Absent ⇒ the binary codec falls back to the field's 1-based declaration index. */
    tag?: number;
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
    /** OWN fields only (real inheritance). Inherited fields live on `base`; the full
     *  set is assembled by walking the base chain — see {@link allFields}. */
    fields: FieldMetadata[];
    /** Parent schema's metadata when this schema `extends` another (real inheritance).
     *  A live reference to `Parent.schema`; absent for a root schema. The full field
     *  set (own + inherited) is gathered base-first via {@link allFields}. */
    base?: SchemaMetadata;
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
// A generated service class carries its slim contract as a static `service`. The host reads it
// off each registered instance's constructor purely to RESOLVE and VISIBILITY-GATE a call (name
// + per-method visibility) — it never inspects argument or return types. All marshalling lives
// in the generated `dispatch` (server) and the generated client methods, so the metadata stays
// minimal and type-agnostic.

export type ServiceMethodMetadata = {
    name: string;
    /** Omitted ≡ "public". Private methods are emitted only into server bundles and are
     *  uncallable by non-system callers (the host treats them as not found). */
    visibility?: "public" | "private";
};

export type ServiceMetadata = {
    name: string;
    /** Omitted ≡ "public". Private services are emitted only into server bundles. */
    visibility?: "public" | "private";
    methods: ServiceMethodMetadata[];
};

/** A generated service class carrying its contract as a static `service`. */
export interface ServiceClass {
    readonly service: ServiceMetadata;
}

/** A constructed service instance. Its class carries the contract as a `static service` (read
 *  off `instance.constructor` at registration) and a generated `dispatch` method (decodes args,
 *  calls the impl, encodes the result). Typed loosely because TypeScript types an instance's
 *  `.constructor` as plain `Function`; the real guarantee comes from extending the generated
 *  abstract service base. */
export type ServiceInstance = object;

/** What the application registers with `new ServiceHost({ services })`: an instance or a
 *  zero-arg factory producing one. */
export type ServiceProvider = ServiceInstance | (() => ServiceInstance);

// ── Request context ─────────────────────────────────────────────────────────
//
// Ambient per-request context, injected as the LAST argument into every service-method impl.
// Free-form; `identity` is the conventional auth slot and `identity.isSystem` drives the
// probe-resistant visibility gate (private services/methods are "not found" unless system).

export type RequestContext = {
    identity?: {
        id?: string;
        roles?: readonly string[];
        isSystem?: boolean;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};

// ── RPC wire envelope + transport ────────────────────────────────────────────
//
// The single-call protocol. A generated client builds a `CallRequest` (encoding its args per the
// transport's `encoding`), hands it to `Transport.invoke`, and unwraps the `CallResult`. Both
// ends agree on the encoding statically — there is no negotiation.

/** Wire encoding of a call's args/result payloads. Transport configuration, fixed at both ends. */
export type WireEncoding = "json" | "binary";

/** A single remote call. `args` is the encoded argument payload — a plain object in `json` mode,
 *  or the positional binary blob (a `Uint8Array`) in `binary` mode. `service`/`method` are
 *  always plaintext (the host resolves them as a string header). */
export type CallRequest = {
    service: string;
    method: string;
    args: unknown;
};

/** The slim result envelope. `data` is the encoded return payload (object or bytes). On failure,
 *  `details` carries an optional code-specific structured payload (e.g. a `VALIDATION_ERROR`'s
 *  `ValidationError[]`) the host copied off the thrown `KeymaError`; domain-neutral, passed through
 *  opaquely and re-thrown on the client. */
export type CallResult =
    | { ok: true; data: unknown }
    | { ok: false; code: string; message: string; details?: unknown };

/** Reserved streaming capabilities. Streaming is NOT built this pass — the descriptor only keeps
 *  the interface from a breaking reshape when it lands. */
export type TransportCapabilities = {
    serverStream?: boolean;
    clientStream?: boolean;
    bidi?: boolean;
};

/** The capability-flagged transport. Required unary `invoke`; `encoding` tells a bound client how
 *  to marshal. A streaming seam (`capabilities`) is reserved but unused this pass. */
export interface Transport {
    readonly encoding: WireEncoding;
    readonly capabilities?: TransportCapabilities;
    invoke(request: CallRequest): Promise<CallResult>;
}
