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
    /** Floating point. `bits` omitted => 64 (double); 32 => single (float). */
    | { kind: "number"; bits?: 32 | 64 }
    /** Integer. `bits` omitted => 64, `unsigned` omitted => signed. */
    | { kind: "integer"; bits?: 8 | 16 | 32 | 64; unsigned?: boolean }
    | { kind: "bigint" }
    | { kind: "decimal" }
    | { kind: "boolean" }
    | { kind: "bytes" }
    | { kind: "json" }
    | { kind: "date" }
    | { kind: "dateTime" }
    | { kind: "time" }
    | { kind: "id" }
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
    | { kind: "embedded"; schema: string }
    /** A live value of a class `T` — an *instance*, distinct from the ownership
     *  types `reference` (non-owning id handle) and `embedded` (owning inline
     *  value). `name` is the target class's canonical `name`. Appears only in
     *  param/return positions (function/method signatures, HOF types), never as a
     *  stored field, so the runtime wire codec is untouched. */
    | { kind: "instance"; name: string }
    /** A higher-order-function type — `(params) => returns`. `params` are typed;
     *  `returns` absent ⇒ a `void`-returning function (mirrors the absent-return
     *  convention on methods). Used wherever a value is itself a function (HOF
     *  param/return positions); never a stored field. */
    | { kind: "function"; params: IRFunctionParam[]; returns?: IRType };

/**
 * An arrow-function parameter. The bare-string form (just the name) is the common
 * inline case and the only form the frontend emits today. The object form
 * additionally carries an optional declared `type` and an `optional?` flag (the
 * param has a `?` or a default) — the vocabulary later slices use to give arrows
 * typed parameters. Backends that only render the name read either form via the
 * name.
 */
export type IRArrowParam = string | { name: string; type?: IRType; optional?: boolean };

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
    /**
     * An arrow function. Exactly ONE of `body` (a concise expression arrow — the common
     * inline case) or `statements` (a multi-statement block arrow) is present. `returnType`
     * is the inferred return type when the frontend could determine it (best-effort; may be
     * absent). A block whose sole statement is `return e` is normalized by the frontend down
     * to `body: e` so the inline path is preserved.
     */
    | { kind: "arrow"; params: IRArrowParam[]; body?: IRExpression; statements?: IRStatement[]; returnType?: IRType }
    | { kind: "new"; callee: IRExpression; args: IRExpression[] }
    /** Awaits an async operand — `await operand`. Emitted only inside an `async`
     *  function/method body (see `IRFunctionDeclaration.async` / `IRMethod.async`). */
    | { kind: "await"; operand: IRExpression }
    /**
     * A canonical, language-neutral operation that each backend translates to an
     * idiomatic form (string/array methods, `typeof`, `instanceof`). `op` is an id
     * from the intrinsic registry (see `intrinsics.ts`), e.g. `"string.includes"`,
     * `"array.length"`, `"type-is"`, `"instance-of"`. `receiver` is the value the op
     * acts on (null for free-standing ops). For `type-is`/`instance-of` the target
     * type/constructor name rides in `args[0]` as a string `literal`.
     */
    | { kind: "intrinsic"; op: string; receiver: IRExpression | null; args: IRExpression[] };

// ─── Statement IR (portable function / method / behavior bodies) ──────────────

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
/** `for (const <name> of <iterable>) { <body> }`. The loop variable `name` is a
 *  fresh binding; backends infer its type (`auto` / dynamic). */
export type IRForOfStmt   = { kind: "forOf"; name: string; iterable: IRExpression; body: IRStatement[] };
export type IRWhileStmt   = { kind: "while"; condition: IRExpression; body: IRStatement[] };
export type IRBreakStmt   = { kind: "break" };
export type IRContinueStmt= { kind: "continue" };
/**
 * One arm of a `switch`. `test` is the case-label expression, or `null` for the
 * `default` arm. A `break` in `body` terminates the arm; its absence is
 * source-faithful fallthrough into the next arm.
 */
export type IRSwitchCase  = { test: IRExpression | null; body: IRStatement[] };
export type IRSwitchStmt  = { kind: "switch"; discriminant: IRExpression; cases: IRSwitchCase[] };
export type IRStatement   =
    | IRReturnStmt | IRIfStmt | IRConstDecl | IRExprStmt | IRAssignStmt
    | IRForOfStmt | IRWhileStmt | IRBreakStmt | IRContinueStmt | IRSwitchStmt;

// ─── Compiled functions (utilities + validator/formatter factories) ───────────

/**
 * A typed parameter of a compiled function. `optional` (the param had a `?` or a
 * default in source) lets typed backends emit a default so a call site may omit it —
 * e.g. a validator factory's `pattern(value, flags?)` → C++ `auto flags = …`,
 * Python `flags=None`. JS ignores it (missing args are natively `undefined`).
 */
export type IRFunctionParam = { name: string; type: IRType; optional?: boolean };

/**
 * A project-local function lowered into the IR so backends can re-emit it. This is the
 * general home for every authored function — plain utility helpers AND the higher-order
 * validator/formatter factories (`function f(spec) { return (value) => … }`), which are
 * ordinary functions whose body returns a typed arrow. The body uses the portable
 * statement/expression subset.
 */
export type IRFunctionDeclaration = {
    name: string;
    params: IRFunctionParam[];
    returnType: IRType;
    /**
     * Async marker. When `true` the body may use `await` (`{ kind: "await" }`) and
     * `returnType` holds the UNWRAPPED `T` — the awaitable wrapper is implied,
     * consistent with the frontend's `Promise<…>` peeling.
     */
    async?: boolean;
    statements: IRStatement[];
    source: IRSourceLocation;
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


/**
 * A portable behavior emitted onto the generated model class: an instance method,
 * a setter, or a getter accessor. Behaviors are NOT part of the stored record —
 * they are re-emittable code, lowered to the same portable statement/expression
 * subset as validator/formatter bodies (plus `assign` statements). `this.<field>`
 * reads/writes the record's fields; parameters and locals are plain identifiers.
 *
 * Note: a getter is a behavior, not a stored/indexed/materialized field. Field-like
 * computed semantics (`@Computed`/`@Indexed` on a getter) are deferred to a future
 * release; the frontend warns (KEYMA098) and emits the getter as a plain accessor.
 */
export type IRMethod = {
    name: string;
    /**
     * `"method"` → `name(params): returnType { ... }`.
     * `"setter"` → `set name(value) { ... }` (exactly one param, no return).
     * `"getter"` → `get name(): returnType { ... }` (no params; body is the portable
     *   statement subset — `const`/`if`/`return` — reaching a `return`; `returnType` present).
     * `"constructor"` → `constructor(params) { ... }` (no return type).
     * `"destructor"` → a finalizer with no params and no return (`~T()` in C++,
     *   `__del__` in Python, a plain `destructor()` method in JS).
     */
    kind: "method" | "setter" | "getter" | "constructor" | "destructor";
    /** Typed parameters. A setter has exactly one (the incoming value); a getter has none. */
    params: IRFunctionParam[];
    /** Method/getter return type. Absent for setters and for `void`-returning methods. */
    returnType?: IRType;
    /**
     * Async marker. When `true` the body may use `await` (`{ kind: "await" }`) and
     * `returnType` holds the UNWRAPPED `T` — the awaitable wrapper (`Promise<T>` /
     * `Task<T>`) is implied, consistent with the frontend's `Promise<…>` peeling.
     */
    async?: boolean;
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
    /** Default value applied on create when the key is absent (from the field's
     *  TypeScript property initializer). */
    default?: IRDefault;
    /** Deprecation marker — `true`, or a reason string (from `@Deprecated`). */
    deprecated?: boolean | string;
    /**
     * Stable binary-wire tag assigned by the compiler's `assignTags` pass from the
     * committed manifest (`keyma.tags.json`). Present only when binary serialization is
     * enabled for the project; absent ⇒ JSON-only pipelines and the runtime codec falls
     * back to the field's 1-based declaration index. A positive integer, unique within
     * the (post-flatten) schema. See `TagManifest`.
     */
    tag?: number;
    /**
     * Domain-namespaced extension data, keyed by domain id (`extensions['schema']`,
     * `extensions['ui']`, …). A reserved seam for domain frontends to attach their own
     * per-field metadata without growing the core field shape. The core pipeline neither
     * sets nor reads it; the schema domain stores its index/ephemeral metadata under
     * `extensions['schema']` (see `@keyma/schema/ir`).
     */
    extensions?: Record<string, unknown>;
    source: IRSourceLocation;
};

export type IRClassDeclaration = {
    /** Canonical identity. Used everywhere downstream — reference/embedded/edge
     *  targets, runtime registries, RPC, serialization, DB naming. Unique across
     *  the project (KEYMA001) and carries the optional `schemaPrefix`. */
    name: string;
    /** The authored TS class name. EMIT-SYMBOL ONLY: backends use it as the
     *  generated class/module identifier. Never a lookup key and never sent over
     *  the wire — use `name` for any cross-reference. */
    sourceName: string;
    visibility: "public" | "private";
    description?: string;
    fields: IRField[];
    /**
     * Portable behaviors (instance methods, setters) emitted onto the generated
     * model class. Not part of the stored record — pure re-emitted code. Holds only
     * this class's OWN behaviors; inherited ones come through real inheritance in the
     * generated output. Absent when there are none.
     */
    methods?: IRMethod[];
    /**
     * The parent class this schema extends — its `sourceName` (the emit symbol), NOT
     * the canonical `name`. Survives to the IR emitted to backends: inheritance is REAL
     * (`fields`/`methods` hold own members only; `extends` drives the emitted base class).
     * Backends resolve it through their sourceName→module map, like an import target.
     */
    extends?: string;
    /** @deprecated Legacy provenance from the removed flatten pass; no longer produced. */
    extendsSource?: string;
    /**
     * Domain-namespaced extension data, keyed by domain id (`extensions['schema']`,
     * `extensions['ui']`, …). A reserved seam for domain frontends to attach their own
     * per-schema metadata without growing the core schema shape. The core pipeline neither
     * sets nor reads it; the schema domain stores its edge/index/ephemeral metadata under
     * `extensions['schema']` (see `@keyma/schema/ir`).
     */
    extensions?: Record<string, unknown>;
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

/**
 * The committed binary-tag manifest (`keyma.tags.json`) — the durable record of each
 * field's stable wire identity, diffed on every compile so at-rest binary records survive
 * schema evolution. Pure JSON. Keyed by canonical schema `name` (post-prefix). Owned and
 * read/written exclusively by the CLI (the only real-fs writer); it threads through the
 * compiler as data only. Per-schema tag spaces keep two devs editing different schemas
 * conflict-free; `nextTag` is a monotonic high-water mark (allocation is always `nextTag++`,
 * never gap-filling or reusing a tombstone). See the frontend's `assignTags` pass.
 */
export type TagManifestSchema = {
    /** Monotonic high-water mark — the next tag to allocate. Only ever increases. */
    nextTag: number;
    /** Surviving field name → its committed stable tag. */
    fields: Record<string, number>;
    /** Tags of removed fields, retired so they are never reused (decode-skip safety). */
    tombstones: number[];
};

export type TagManifest = {
    manifestVersion: string;
    schemas: Record<string, TagManifestSchema>;
};

export type KeymaIR = {
    irVersion: string;
    compilerVersion: string;
    sourceRoot?: string;
    classes: IRClassDeclaration[];
    /** Named enum declarations referenced by schema fields. */
    enums?: IREnumDeclaration[];
    /**
     * Project-local functions: plain utility helpers AND the higher-order
     * validator/formatter factories (now ordinary functions). Domains attach which
     * function validates/formats which field via `field.extensions`.
     */
    functionDeclarations?: IRFunctionDeclaration[];
    /** Remotely-callable service contracts authored with `@Service(...)`. */
    services?: IRService[];
    /**
     * Document-level, domain-namespaced extension data keyed by domain id
     * (`extensions['ui']`, …). A frontend domain attaches its own slice here through the
     * `FrontendContribution.extensions` seam, and that domain's backend emitter packs are
     * the only readers. The core pipeline neither sets nor reads it, and it is absent
     * whenever no domain contributes one — so a schema-only document is byte-identical to
     * before this field existed. Pure JSON.
     */
    extensions?: Record<string, unknown>;
    diagnostics: IRDiagnostic[];
};
