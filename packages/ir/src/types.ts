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
    | { kind: "new"; callee: IRExpression; args: IRExpression[] };

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
    body: IRFunctionBody;
    source: IRSourceLocation;
};

export type IRFormatterDeclaration = {
    name: string;
    /** Names of the outer factory function's parameters; become spec keys at code-gen time. */
    factoryParams: { name: string }[];
    body: IRFunctionBody;
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
 * Present iff the user authored the class with `@Edge({ from, to, ... })`.
 * Non-graph backends ignore this; graph-aware backends use it to plan
 * traversals.
 */
export type IREdge = {
    /** Source node schema's sourceName (TS class name). */
    from: string;
    /** Field on the edge schema that holds the source ID. Default: "from". */
    fromField: string;
    /** Target node schema's sourceName (TS class name). */
    to: string;
    /** Field on the edge schema that holds the target ID. Default: "to". */
    toField: string;
    /** Traversal label (defaults to the edge schema's `name`). */
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
    schemas: IRSchema[];
    validatorDeclarations?: IRValidatorDeclaration[];
    formatterDeclarations?: IRFormatterDeclaration[];
    diagnostics: IRDiagnostic[];
};
