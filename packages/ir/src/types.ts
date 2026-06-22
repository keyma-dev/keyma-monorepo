export type IRSourceLocation = {
    file: string;
    line: number;
    column: number;
};

export type IRDiagnostic = {
    code: string;
    severity: "error" | "warning" | "info";
    message: string;
    source?: IRSourceLocation;
};

export type IRType =
    | { kind: "string" }
    | { kind: "number" }
    | { kind: "integer" }
    | { kind: "bigint" }
    | { kind: "decimal" }
    | { kind: "boolean" }
    | { kind: "bytes" }
    | { kind: "json" }
    | { kind: "date" }
    | { kind: "dateTime" }
    | { kind: "time" }
    | { kind: "id" }
    | { kind: "regexp" }
    /** A string enum. `name` is set when it resolves to a named (reusable) enum
     *  declaration; absent for an inline string-literal union. */
    | { kind: "enum"; values: string[]; name?: string }
    | { kind: "array"; of: IRType; elementNullable?: boolean }
    /** Foreign key — stores only the referenced document's id. `schema` is the
     *  target schema's `name` (the canonical identity used everywhere downstream
     *  — registries, RPC, serialization, DB naming), never its `sourceName`.
     *  `idType` is the resolved type of the target's `id` field, filled in by the
     *  frontend. */
    | { kind: "reference"; schema: string; idType?: IRType }
    /** Inline nested document. `schema` is the target schema's `name` (see
     *  `reference` above), never its `sourceName`. */
    | { kind: "embedded"; schema: string };

/** Generic validator reference — identified by name, optionally parameterized. */
export type IRValidator = {
    name: string;
    params?: Record<string, unknown>;
};

/** Generic formatter spec — identified by name, optionally parameterized. */
export type IRFormatterSpec = {
    name: string;
    params?: Record<string, unknown>;
};

export type IRFormatter = {
    phase: "change" | "blur" | "submit" | "save";
    spec: IRFormatterSpec;
};

export type IRFieldIndex = {
    unique?: boolean;
    sparse?: boolean;
    direction?: 1 | -1 | "text";
    key?: string;
};

export type IRIndex = {
    fields: { name: string; direction: 1 | -1 | "text" }[];
    unique?: boolean;
    sparse?: boolean;
    name?: string;
};

export type IRExpression =
    | { kind: "literal"; value: string | number | boolean | null }
    | { kind: "field"; name: string }
    | { kind: "identifier"; name: string }
    | { kind: "member"; object: IRExpression; member: string }
    | { kind: "call"; callee: IRExpression; args: IRExpression[] }
    | { kind: "typeof"; operand: IRExpression }
    | { kind: "template"; parts: IRExpression[] }
    | { kind: "binary"; op: "+" | "-" | "*" | "/" | "%" | "&&" | "||" | "??" | "==" | "!=" | "<" | "<=" | ">" | ">="; left: IRExpression; right: IRExpression }
    | { kind: "unary"; op: "!" | "-" | "+"; operand: IRExpression }
    | { kind: "conditional"; condition: IRExpression; whenTrue: IRExpression; whenFalse: IRExpression }
    | { kind: "object"; properties: Array<{ key: string; value: IRExpression }> }
    | { kind: "regexp"; pattern: string; flags: string }
    | { kind: "arrow"; params: string[]; body: IRExpression }
    | { kind: "new"; callee: IRExpression; args: IRExpression[] }
    /**
     * A canonical, language-neutral operation that each backend translates to an
     * idiomatic form (string/array methods, `typeof`, `instanceof`). `op` is an id
     * from the intrinsic registry (see `intrinsics.ts`), e.g. `"string.includes"`,
     * `"array.length"`, `"type-is"`, `"instance-of"`. `receiver` is the value the op
     * acts on (null for free-standing ops). For `type-is`/`instance-of` the target
     * type/constructor name rides in `args[0]` as a string `literal`.
     */
    | { kind: "intrinsic"; op: string; receiver: IRExpression | null; args: IRExpression[] };

// ─── Statement IR (for validator / formatter function bodies) ─────────────────

export type IRReturnStmt  = { kind: "return"; value: IRExpression | null };
export type IRIfStmt      = { kind: "if"; condition: IRExpression; consequent: IRStatement[]; alternate?: IRStatement[] };
export type IRConstDecl   = { kind: "const"; name: string; init: IRExpression };
export type IRExprStmt    = { kind: "expression"; expr: IRExpression };
/**
 * A simple assignment, `target = value`. `target` is typically a `{kind:"field"}`
 * (e.g. `this.x`) or a `member` expression. Emitted only inside method/setter
 * behavior bodies — validator/formatter bodies do not permit mutation.
 */
export type IRAssignStmt  = { kind: "assign"; target: IRExpression; value: IRExpression };
export type IRStatement   = IRReturnStmt | IRIfStmt | IRConstDecl | IRExprStmt | IRAssignStmt;

export type IRParam = { name: string; role: "value" | "field" | "spec" | "context" };
export type IRFunctionBody = { params: IRParam[]; statements: IRStatement[] };

// ─── Validator / formatter declarations ───────────────────────────────────────

export type IRValidatorDeclaration = {
    name: string;
    /**
     * Outer factory function's parameters; names become spec keys at code-gen time.
     * `optional` (the param has a `?` or a default) lets typed backends emit a default so
     * a call site may omit it — e.g. `pattern(value, flags?)` → C++ `auto flags = ...`,
     * Python `flags=None`. JS ignores it (missing args are natively `undefined`).
     */
    factoryParams: { name: string; optional?: boolean }[];
    /** Declared type of the inner function's `value` parameter; backends emit a runtime guard from it. */
    inputType: IRType;
    body: IRFunctionBody;
    source: IRSourceLocation;
};

export type IRFormatterDeclaration = {
    name: string;
    /**
     * Outer factory function's parameters; names become spec keys at code-gen time.
     * `optional` (the param has a `?` or a default) lets typed backends emit a default so
     * a call site may omit it — e.g. `pattern(value, flags?)` → C++ `auto flags = ...`,
     * Python `flags=None`. JS ignores it (missing args are natively `undefined`).
     */
    factoryParams: { name: string; optional?: boolean }[];
    /** Declared type of the inner function's `value` parameter; backends emit a runtime guard from it. */
    inputType: IRType;
    body: IRFunctionBody;
    source: IRSourceLocation;
};

// ─── Compiled utility functions ───────────────────────────────────────────────

/** A typed parameter of a compiled project-local utility function. */
export type IRFunctionParam = { name: string; type: IRType };

/**
 * A project-local utility function referenced from a validator/formatter body and
 * lowered into the IR so backends can re-emit it. Body uses the same portable
 * statement/expression subset as validator/formatter bodies.
 */
export type IRFunctionDeclaration = {
    name: string;
    params: IRFunctionParam[];
    returnType: IRType;
    statements: IRStatement[];
    source: IRSourceLocation;
};

/** Presentational metadata for form generation (from `@FormField`). */
export type IRFormField = {
    title?: string;
    hint?: string;
    placeholder?: string;
    group?: string;
    order?: number;
};

/**
 * A field's default value, lowered from a TypeScript property initializer and
 * applied on create when the key is absent.
 * - `literal`: a constant value (`= "active"`, `= 0`, `= Role.Member`, `= [..]`).
 * - `expression`: a portable expression (`= (() => new Date())()`, `= myFn()`)
 *   re-emitted by the backend and evaluated per-record at create time.
 */
export type IRDefault =
    | { kind: "literal"; value: string | number | boolean | null | unknown[] }
    | { kind: "expression"; expression: IRExpression };

export type IRComputed = {
    expression: IRExpression;
    /**
     * Names of other fields in the same schema this computed field reads. Derived
     * from the expression by the frontend; lets backends materialize computed
     * fields in dependency order. A computed→computed cycle is rejected (KEYMA018).
     */
    dependsOn?: string[];
};

/**
 * A portable behavior emitted onto the generated model class: an instance method
 * or a setter. Unlike computed fields, behaviors are NOT part of the stored record
 * — they are re-emittable code, lowered to the same portable statement/expression
 * subset as validator/formatter bodies (plus `assign` statements). `this.<field>`
 * reads/writes the record's fields; parameters and locals are plain identifiers.
 */
export type IRMethod = {
    name: string;
    /**
     * `"method"` → `name(params): returnType { ... }`.
     * `"setter"` → `set name(value) { ... }` (exactly one param, no return).
     */
    kind: "method" | "setter";
    /** Typed parameters. A setter has exactly one (the incoming value). */
    params: IRFunctionParam[];
    /** Method return type. Absent for setters and for `void`-returning methods. */
    returnType?: IRType;
    statements: IRStatement[];
    visibility: "public" | "private";
    source: IRSourceLocation;
};

export type IRField = {
    name: string;
    type: IRType;
    visibility: "public" | "private";
    readonly: boolean;
    /**
     * Whether the key may be ABSENT from the object (presence axis). `optional ≡
     * !required`. Authored with `?` or `T | undefined`. Orthogonal to `nullable`.
     */
    required: boolean;
    /**
     * Whether the value may be `null` (value axis). Authored with `Nullable<T>`
     * or `T | null`. Orthogonal to `required`; the two compose freely. Absent =
     * not nullable.
     */
    nullable?: boolean;
    validators: IRValidator[];
    formatters: IRFormatter[];
    indexes: IRFieldIndex[];
    computed?: IRComputed;
    ephemeral?: boolean;
    /** Default value applied on create when the key is absent (from the field's
     *  TypeScript property initializer). */
    default?: IRDefault;
    /** Presentational metadata for form generation (from `@FormField`). */
    form?: IRFormField;
    /** Deprecation marker — `true`, or a reason string (from `@Deprecated`). */
    deprecated?: boolean | string;
    source: IRSourceLocation;
};

/**
 * Metadata for a schema that represents an edge connecting two node schemas.
 * Present iff the user authored the class with `@Edge(...)`. The endpoints are
 * derived from the `@From()`/`@To()`-decorated fields: each field's name yields
 * `fromField`/`toField` and its declared node type yields `from`/`to`. Non-graph
 * backends ignore this; graph-aware backends use it to plan traversals.
 */
export type IREdge = {
    /** Source node schema's `name` — the `@From()` field's node type. */
    from: string;
    /** Name of the `@From()`-decorated field holding the source endpoint. */
    fromField: string;
    /** Target node schema's `name` — the `@To()` field's node type. */
    to: string;
    /** Name of the `@To()`-decorated field holding the target endpoint. */
    toField: string;
    /** Traversal label — the edge schema's `name`. */
    label: string;
    /** When false, the edge is undirected — adapters may treat both ends as equivalent. */
    directed: boolean;
};

export type IRSchema = {
    id: string;
    /** Canonical identity. Used everywhere downstream — reference/embedded/edge
     *  targets, runtime registries, RPC, serialization, DB naming. Unique across
     *  the project (KEYMA001) and carries the optional `schemaPrefix`. */
    name: string;
    /** The authored TS class name. EMIT-SYMBOL ONLY: backends use it as the
     *  generated class/module/materializer identifier. Never a lookup key and
     *  never sent over the wire — use `name` for any cross-reference. */
    sourceName: string;
    visibility: "public" | "private";
    /** When true, this schema is never persisted to the database. */
    ephemeral?: boolean;
    description?: string;
    fields: IRField[];
    indexes: IRIndex[];
    /**
     * Portable behaviors (instance methods, setters) emitted onto the generated
     * model class. Not part of the stored record — pure re-emitted code. Inherited
     * behaviors are flattened in alongside fields. Absent when there are none.
     */
    methods?: IRMethod[];
    /**
     * Pre-flatten only: the parent class name, present until inheritance is
     * flattened. After flattening (the IR emitted to backends) this is absent —
     * the field list is already complete and self-contained. Backends must NOT
     * re-apply inheritance.
     */
    extends?: string;
    /** Provenance: the parent class this schema's fields were flattened from. */
    extendsSource?: string;
    /** Present iff the class was decorated with `@Edge(...)`. */
    edge?: IREdge;
    source: IRSourceLocation;
};

/**
 * A single remotely-callable method of a service. Only the SIGNATURE is lowered
 * — there is no body (service implementations live in server runtime code, never
 * compiled). `params` are the declared data parameters; the injected request
 * context is not represented here. `returnType` is the value type (any
 * `Promise<...>` wrapper is peeled by the frontend); absent for `void` returns.
 */
export type IRServiceMethod = {
    name: string;
    params: IRFunctionParam[];
    returnType?: IRType;
    visibility: "public" | "private";
    source: IRSourceLocation;
};

/**
 * A service: a group of remotely-callable functions authored as an `abstract
 * class` decorated with `@Service(...)`. Each abstract method becomes an
 * `IRServiceMethod`. Backends generate a client stub (for `Keyma.call`) and a
 * server abstract base class the application extends to implement the methods.
 */
export type IRService = {
    id: string;
    /** Canonical identity — the RPC service id used over the wire. Carries the
     *  optional `schemaPrefix`. */
    name: string;
    /** The authored TS class name. EMIT-SYMBOL ONLY (generated client stub /
     *  server base class name); never a lookup key or wire id — use `name`. */
    sourceName: string;
    visibility: "public" | "private";
    description?: string;
    methods: IRServiceMethod[];
    source: IRSourceLocation;
};

/**
 * A named, reusable enum authored as a TypeScript `enum` and referenced across
 * schemas. Members carry both their identifier and string value.
 */
export type IREnumDeclaration = {
    name: string;
    members: { name: string; value: string }[];
    source: IRSourceLocation;
};

export type KeymaIR = {
    irVersion: string;
    compilerVersion: string;
    sourceRoot?: string;
    schemas: IRSchema[];
    /** Named enum declarations referenced by schema fields. */
    enums?: IREnumDeclaration[];
    validatorDeclarations?: IRValidatorDeclaration[];
    formatterDeclarations?: IRFormatterDeclaration[];
    /** Project-local utility functions referenced (transitively) from validator/formatter bodies. */
    functionDeclarations?: IRFunctionDeclaration[];
    /** Remotely-callable service contracts authored with `@Service(...)`. */
    services?: IRService[];
    diagnostics: IRDiagnostic[];
};
