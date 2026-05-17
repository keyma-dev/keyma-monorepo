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
    | { kind: "enum"; values: string[] }
    | { kind: "nullable"; of: IRType }
    | { kind: "array"; of: IRType }
    | { kind: "reference"; schema: string }
    | { kind: "embedded"; schema: string };

export type IRValidator =
    | { kind: "required" }
    | { kind: "minLength"; value: number }
    | { kind: "maxLength"; value: number }
    | { kind: "length"; value: number }
    | { kind: "min"; value: number }
    | { kind: "max"; value: number }
    | { kind: "multipleOf"; value: number }
    | { kind: "positive" }
    | { kind: "nonNegative" }
    | { kind: "negative" }
    | { kind: "nonPositive" }
    | { kind: "integer" }
    | { kind: "minDate"; value: string }
    | { kind: "maxDate"; value: string }
    | { kind: "minItems"; value: number }
    | { kind: "maxItems"; value: number }
    | { kind: "uniqueItems" }
    | { kind: "pattern"; pattern: string; flags?: string }
    | { kind: "emailAddress" }
    | { kind: "url"; protocols?: string[] }
    | { kind: "phoneNumber"; region?: string }
    | { kind: "ipAddress"; version?: "v4" | "v6" }
    | { kind: "oneOf"; values: (string | number)[] }
    | { kind: "custom"; name: string };

export type IRFormatterSpec =
    | { kind: "trim" }
    | { kind: "lowercase" }
    | { kind: "uppercase" }
    | { kind: "titleCase" }
    | { kind: "capitalize" }
    | { kind: "normalizeWhitespace" }
    | { kind: "stripNonDigits" }
    | { kind: "normalizeEmail" }
    | { kind: "normalizePhone"; region?: string }
    | { kind: "normalizeUrl" }
    | { kind: "slugify" }
    | { kind: "truncate"; maxLength: number }
    | { kind: "custom"; name: string };

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
    | { kind: "member"; object: IRExpression; member: string }
    | { kind: "template"; parts: IRExpression[] }
    | { kind: "binary"; op: "+" | "-" | "*" | "/" | "%" | "&&" | "||" | "??" | "==" | "!=" | "<" | "<=" | ">" | ">="; left: IRExpression; right: IRExpression }
    | { kind: "unary"; op: "!" | "-" | "+"; operand: IRExpression }
    | { kind: "conditional"; condition: IRExpression; whenTrue: IRExpression; whenFalse: IRExpression };

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
    diagnostics: IRDiagnostic[];
};
