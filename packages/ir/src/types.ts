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
    | { kind: "enum"; values: string[] }
    | { kind: "nullable"; of: IRType }
    | { kind: "array"; of: IRType }
    | { kind: "reference"; schema: string }
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
export type IRStatement   = IRReturnStmt | IRIfStmt | IRConstDecl | IRExprStmt;

export type IRParam = { name: string; role: "value" | "field" | "spec" | "context" };
export type IRFunctionBody = { params: IRParam[]; statements: IRStatement[] };

// ─── Validator / formatter declarations ───────────────────────────────────────

export type IRValidatorDeclaration = {
    name: string;
    /** Names of the outer factory function's parameters; become spec keys at code-gen time. */
    factoryParams: { name: string }[];
    /** Declared type of the inner function's `value` parameter; backends emit a runtime guard from it. */
    inputType: IRType;
    body: IRFunctionBody;
    source: IRSourceLocation;
};

export type IRFormatterDeclaration = {
    name: string;
    /** Names of the outer factory function's parameters; become spec keys at code-gen time. */
    factoryParams: { name: string }[];
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

export type IRComputed = {
    expression: IRExpression;
};

export type IRField = {
    name: string;
    type: IRType;
    visibility: "public" | "private";
    readonly: boolean;
    required: boolean;
    validators: IRValidator[];
    formatters: IRFormatter[];
    indexes: IRFieldIndex[];
    computed?: IRComputed;
    ephemeral?: boolean;
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
    /** Source node schema's sourceName — the `@From()` field's node type. */
    from: string;
    /** Name of the `@From()`-decorated field holding the source endpoint. */
    fromField: string;
    /** Target node schema's sourceName — the `@To()` field's node type. */
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
    name: string;
    sourceName: string;
    visibility: "public" | "private";
    /** When true, this schema is never persisted to the database. */
    ephemeral?: boolean;
    description?: string;
    fields: IRField[];
    indexes: IRIndex[];
    extends?: string;
    /** Present iff the class was decorated with `@Edge(...)`. */
    edge?: IREdge;
    source: IRSourceLocation;
};

export type KeymaIR = {
    irVersion: string;
    compilerVersion: string;
    sourceRoot?: string;
    schemas: IRSchema[];
    validatorDeclarations?: IRValidatorDeclaration[];
    formatterDeclarations?: IRFormatterDeclaration[];
    /** Project-local utility functions referenced (transitively) from validator/formatter bodies. */
    functionDeclarations?: IRFunctionDeclaration[];
    diagnostics: IRDiagnostic[];
};
