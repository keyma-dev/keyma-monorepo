import ts from "typescript";
import type { IRType, IRDiagnostic } from "@keyma/core/ir";
import { mkError, KEYMA010, KEYMA024, KEYMA025, KEYMA050, KEYMA071, KEYMA099 } from "./diagnostics.js";
import { getLocation, isFromModule, entityNameText } from "./util.js";
import type { EnumInfo } from "./discover-enums.js";

/**
 * The canonical module that declares the core DSL semantic types (`ID`, `Json`,
 * `Reference`, `Embedded`, `Integer`, …). They are core-owned and re-exported by a
 * domain's DSL surface (e.g. `@keyma/schema/dsl`), so a symbol may carry either
 * specifier: user schemas import from the domain re-export, while the built-in
 * validator/formatter libraries import directly from `@keyma/core/dsl`. Both are
 * accepted (see `fromDsl` below). Naming the core module here is correct layering —
 * the compiler already owns the scalar type *names* in `DSL_SCALAR_TYPES` and depends
 * on `@keyma/core`; this is not a `@keyma/schema` symbol.
 */
const CORE_DSL_MODULE = "@keyma/core/dsl";

/**
 * DSL type alias names that map to scalar IR types.
 * These must be imported from the configured DSL module (or `@keyma/core/dsl`).
 */
const DSL_SCALAR_TYPES: ReadonlyMap<string, IRType> = new Map([
    ["ID", { kind: "id" }],
    ["DateOnly", { kind: "date" }],
    ["DateTime", { kind: "dateTime" }],
    ["TimeOfDay", { kind: "time" }],
    ["Decimal", { kind: "decimal" }],
    ["Json", { kind: "json" }],
    ["Bytes", { kind: "bytes" }],
]);

/** Global (non-DSL) type names that map to IR types. */
const GLOBAL_SCALAR_TYPES: ReadonlyMap<string, IRType> = new Map([
    ["Date", { kind: "dateTime" }],
    ["Uint8Array", { kind: "bytes" }],
]);

type TypeMapContext = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    /** Class names of all discovered @Schema classes. */
    schemaClassNames: ReadonlySet<string>;
    /** Named TS enum declarations, keyed by name (optional — field paths supply it). */
    enums?: ReadonlyMap<string, EnumInfo>;
    /**
     * When true, a bare `@Schema` class is a value-of-class-T position
     * (function/method/validator param or return) and lowers to an `instance` —
     * "a live value of class T," distinct from the ownership types. Schema FIELD
     * paths leave this false so bare classes are rejected (KEYMA071) in favour of
     * explicit `Reference<T>` (foreign key) / `Embedded<T>` (inline copy).
     */
    bareClassInstance?: boolean;
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
};

/**
 * A mapped type plus the two orthogonal shape axes discovered while mapping:
 * `nullable` (the value may be `null`, from `Nullable<T>`/`T | null`) and
 * `optional` (the key may be absent, from `T | undefined`). Callers that only
 * want the core type ignore the flags.
 */
export type MapTypeResult = { type: IRType; nullable?: boolean; optional?: boolean } | { diag: IRDiagnostic };

/** Attach the nullable/optional axes to a mapped core type. */
function withFlags(type: IRType, nullable: boolean, optional: boolean): MapTypeResult {
    return {
        type,
        ...(nullable ? { nullable: true } : {}),
        ...(optional ? { optional: true } : {}),
    };
}

/** Build an array type, lifting the element's nullability onto `elementNullable`. */
function makeArray(inner: { type: IRType; nullable?: boolean }): IRType {
    return inner.nullable
        ? { kind: "array", of: inner.type, elementNullable: true }
        : { kind: "array", of: inner.type };
}

/**
 * Best-effort lowering of a resolved `ts.Type` to an `IRType`. Used to infer an arrow's
 * return type for the IR (and reusable for any future inference need). Handles the portable
 * primitives (`string`/`number`/`boolean`/`bigint`), string-literal unions (→ `enum`), and
 * arrays of any of those. Returns `undefined` for anything else — inference is optional
 * ("when possible"), never an error.
 */
export function inferIRTypeFromType(t: ts.Type, checker: ts.TypeChecker): IRType | undefined {
    if (t.isUnion()) {
        const members = t.types;
        if (members.length > 0 && members.every((x) => (x.flags & ts.TypeFlags.StringLiteral) !== 0)) {
            return { kind: "enum", values: members.map((x) => String((x as ts.StringLiteralType).value)) };
        }
        if (members.length > 0 && members.every((x) => (x.flags & ts.TypeFlags.BooleanLike) !== 0)) {
            return { kind: "boolean" };
        }
        return undefined;
    }
    if ((t.flags & ts.TypeFlags.StringLike) !== 0) return { kind: "string" };
    if ((t.flags & ts.TypeFlags.NumberLike) !== 0) return { kind: "number" };
    if ((t.flags & ts.TypeFlags.BooleanLike) !== 0) return { kind: "boolean" };
    if ((t.flags & ts.TypeFlags.BigIntLike) !== 0) return { kind: "bigint" };
    if (checker.isArrayType(t)) {
        const elem = checker.getTypeArguments(t as ts.TypeReference)[0];
        const inner = elem !== undefined ? inferIRTypeFromType(elem, checker) : undefined;
        return inner !== undefined ? { kind: "array", of: inner } : undefined;
    }
    return undefined;
}

export function mapTypeNode(
    typeNode: ts.TypeNode,
    ctx: TypeMapContext
): MapTypeResult {
    // Primitive keywords
    switch (typeNode.kind) {
        case ts.SyntaxKind.StringKeyword:
            return { type: { kind: "string" } };
        case ts.SyntaxKind.NumberKeyword:
            return { type: { kind: "number" } };
        case ts.SyntaxKind.BooleanKeyword:
            return { type: { kind: "boolean" } };
        case ts.SyntaxKind.BigIntKeyword:
            return { type: { kind: "bigint" } };
    }

    if (ts.isUnionTypeNode(typeNode)) {
        return mapUnionType(typeNode, ctx);
    }

    if (ts.isArrayTypeNode(typeNode)) {
        const inner = mapTypeNode(typeNode.elementType, ctx);
        if ("diag" in inner) return inner;
        return { type: makeArray(inner) };
    }

    if (ts.isTypeReferenceNode(typeNode)) {
        return mapTypeReference(typeNode, ctx);
    }

    // Parenthesized: (T) → unwrap
    if (ts.isParenthesizedTypeNode(typeNode)) {
        return mapTypeNode(typeNode.type, ctx);
    }

    return fail(typeNode, ctx, "unsupported type annotation");
}

/** `null` in type position (a LiteralTypeNode wrapping NullKeyword in TS 5.x). */
function isNullTypeNode(t: ts.TypeNode): boolean {
    if (t.kind === ts.SyntaxKind.NullKeyword) return true;
    return ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;
}

/** `undefined` in type position — drives optionality, NOT nullability. */
function isUndefinedTypeNode(t: ts.TypeNode): boolean {
    return t.kind === ts.SyntaxKind.UndefinedKeyword;
}

function mapUnionType(node: ts.UnionTypeNode, ctx: TypeMapContext): MapTypeResult {
    const hasNull = node.types.some(isNullTypeNode);
    const hasUndefined = node.types.some(isUndefinedTypeNode);
    const valueMembers = node.types.filter((t) => !isNullTypeNode(t) && !isUndefinedTypeNode(t));

    // All value members are string literals → enum (possibly nullable/optional)
    if (
        valueMembers.length > 0 &&
        valueMembers.every((m) => ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal))
    ) {
        const values = valueMembers.map((m) =>
            (m as ts.LiteralTypeNode & { literal: ts.StringLiteral }).literal.text
        );
        if (values.length === 0) {
            const diag = mkError(KEYMA024, "Enum must have at least one value", getLocation(node, ctx.sourceFile));
            return { diag };
        }
        return withFlags({ kind: "enum", values }, hasNull, hasUndefined);
    }

    // Single value member with null/undefined → that type with the axes set
    if (valueMembers.length === 1) {
        const member = valueMembers[0];
        if (!member) return fail(node, ctx, "empty union type");
        const inner = mapTypeNode(member, ctx);
        if ("diag" in inner) return inner;
        return withFlags(inner.type, hasNull || inner.nullable === true, hasUndefined || inner.optional === true);
    }

    return fail(node, ctx, "union types must be string literals or T | null | undefined");
}

function mapTypeReference(node: ts.TypeReferenceNode, ctx: TypeMapContext): MapTypeResult {
    const name = entityNameText(node.typeName);
    const typeArgs = node.typeArguments;

    // Global type: Array<T>
    if (name === "Array") {
        if (!typeArgs || typeArgs.length !== 1) {
            const diag = mkError(KEYMA050, "Array<T> requires exactly one type argument", getLocation(node, ctx.sourceFile));
            return { diag };
        }
        const arg = typeArgs[0];
        if (!arg) return fail(node, ctx, "missing Array type argument");
        const inner = mapTypeNode(arg, ctx);
        if ("diag" in inner) return inner;
        return { type: makeArray(inner) };
    }

    // Global scalars (Date, Uint8Array) — check name first, no DSL check needed
    const globalType = GLOBAL_SCALAR_TYPES.get(name);
    if (globalType !== undefined) {
        // Verify it's actually the global (no type args expected)
        if (typeArgs && typeArgs.length > 0) {
            return fail(node, ctx, `${name} does not accept type arguments`);
        }
        return { type: globalType };
    }

    // Resolve the symbol to check where it comes from
    const symbol = ctx.checker.getSymbolAtLocation(node.typeName);
    if (!symbol) return fail(node, ctx, `cannot resolve type "${name}"`);

    // Accept core DSL types via the configured domain re-export (e.g. `@keyma/schema/dsl`)
    // OR the canonical `@keyma/core/dsl` specifier (used by the validator/formatter libs).
    const fromDsl =
        isFromModule(symbol, ctx.checker, ctx.dslModuleName) ||
        isFromModule(symbol, ctx.checker, CORE_DSL_MODULE);

    if (fromDsl) {
        // DSL scalar types
        const dslType = DSL_SCALAR_TYPES.get(name);
        if (dslType !== undefined) {
            return { type: dslType };
        }

        // DSL generic types
        if (name === "Nullable") {
            const arg = typeArgs?.[0];
            if (!arg) {
                return fail(node, ctx, "Nullable<T> requires a type argument");
            }
            const inner = mapTypeNode(arg, ctx);
            if ("diag" in inner) return inner;
            return withFlags(inner.type, true, inner.optional === true);
        }

        if (name === "Reference") {
            const arg = typeArgs?.[0];
            if (!arg) return fail(node, ctx, "Reference<T> requires a type argument");
            return mapSchemaReference(arg, "reference", ctx);
        }

        if (name === "Embedded") {
            const arg = typeArgs?.[0];
            if (!arg) return fail(node, ctx, "Embedded<T> requires a type argument");
            return mapSchemaReference(arg, "embedded", ctx);
        }

        // Width-templated numerics: Integer<Bits>/Unsigned<Bits> → integer,
        // Float<Bits> → number. `bits` is omitted when it equals the default (64),
        // keeping pre-width IR documents valid.
        if (name === "Integer" || name === "Unsigned") {
            const bits = readWidthArg(node, typeArgs, name, [8, 16, 32, 64] as const, 64, ctx);
            if (typeof bits !== "number") return bits;
            return {
                type: {
                    kind: "integer",
                    ...(bits !== 64 ? { bits } : {}),
                    ...(name === "Unsigned" ? { unsigned: true } : {}),
                },
            };
        }

        if (name === "Float") {
            const bits = readWidthArg(node, typeArgs, name, [32, 64] as const, 64, ctx);
            if (typeof bits !== "number") return bits;
            return { type: { kind: "number", ...(bits !== 64 ? { bits } : {}) } };
        }

        return fail(node, ctx, `unknown DSL type "${name}"`);
    }

    // Named TS enum referenced by name.
    const enumInfo = ctx.enums?.get(name);
    if (enumInfo !== undefined) {
        if (enumInfo.members === null) {
            return {
                diag: mkError(
                    KEYMA025,
                    `Enum "${name}" is not portable — every member must have a string initializer (e.g. \`Active = "active"\`)`,
                    getLocation(node, ctx.sourceFile),
                ),
            };
        }
        return { type: { kind: "enum", name, values: enumInfo.members.map((m) => m.value) } };
    }

    // A bare @Schema class in a FIELD is no longer an implicit reference —
    // relationship intent must be explicit. In value positions (param/return,
    // `bareClassInstance`) it lowers to a live `instance` of the class.
    if (ctx.schemaClassNames.has(name)) {
        if (ctx.bareClassInstance === true) {
            return { type: { kind: "instance", name } };
        }
        const diag = mkError(
            KEYMA071,
            `Field of @Schema type "${name}" must state its relationship explicitly — use Reference<${name}> (foreign key) or Embedded<${name}> (inline copy)`,
            getLocation(node, ctx.sourceFile),
        );
        return { diag };
    }

    return fail(node, ctx, `unknown type "${name}" — use a primitive, DSL type, Reference<T>, or Embedded<T>`);
}

function mapSchemaReference(
    typeArg: ts.TypeNode,
    kind: "reference" | "embedded",
    ctx: TypeMapContext
): MapTypeResult {
    if (!ts.isTypeReferenceNode(typeArg)) {
        return fail(typeArg, ctx, `${kind === "reference" ? "Reference" : "Embedded"}<T> requires a schema class type argument`);
    }
    const schemaName = entityNameText(typeArg.typeName);
    if (!ctx.schemaClassNames.has(schemaName)) {
        return fail(
            typeArg,
            ctx,
            `"${schemaName}" is not a known @Schema class`
        );
    }
    return { type: { kind, schema: schemaName } };
}

/**
 * Read a numeric-width type argument (`Integer<8>`, `Float<32>`, …). Returns the
 * validated width as a literal, the default when no argument is supplied, or a
 * `KEYMA099` diagnostic when the argument isn't one of the allowed widths.
 */
function readWidthArg<W extends number>(
    node: ts.TypeReferenceNode,
    typeArgs: ts.NodeArray<ts.TypeNode> | undefined,
    name: string,
    allowed: readonly W[],
    dflt: W,
    ctx: TypeMapContext,
): W | { diag: IRDiagnostic } {
    if (!typeArgs || typeArgs.length === 0) return dflt;
    const arg = typeArgs[0];
    if (arg && ts.isLiteralTypeNode(arg) && ts.isNumericLiteral(arg.literal)) {
        const n = Number(arg.literal.text) as W;
        if (allowed.includes(n)) return n;
    }
    return {
        diag: mkError(
            KEYMA099,
            `${name}<Bits> width must be one of ${allowed.join(", ")}`,
            getLocation(node, ctx.sourceFile),
        ),
    };
}

function fail(node: ts.Node, ctx: TypeMapContext, detail: string): { diag: IRDiagnostic } {
    const diag = mkError(KEYMA010, `Unknown field type: ${detail}`, getLocation(node, ctx.sourceFile));
    return { diag };
}

export type { TypeMapContext };
