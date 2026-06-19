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
    | { kind: "nullable"; of: FieldType }
    | { kind: "array"; of: FieldType }
    | { kind: "reference"; schema: string }
    | { kind: "embedded"; schema: string };

export type ValidatorSpec = { name: string } & Record<string, unknown>;
export type FormatterSpec = { name: string } & Record<string, unknown>;

export type FormatterEntry = {
    phase: string;
    spec: FormatterSpec;
};

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

export type FieldMetadata = {
    name: string;
    type: FieldType;
    visibility?: "public" | "private";
    readonly?: boolean;
    required?: boolean;
    validators?: ValidatorSpec[];
    formatters?: FormatterEntry[];
    indexes?: FieldIndex[];
    computed?: true;
    ephemeral?: boolean;
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
