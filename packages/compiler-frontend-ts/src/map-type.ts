import ts from "typescript";
import type { IRType, IRDiagnostic } from "@keyma/ir";
import { mkError, KEYMA010, KEYMA024, KEYMA050 } from "./diagnostics.js";
import { getLocation, isFromModule, entityNameText } from "./util.js";

/**
 * DSL type alias names that map to scalar IR types.
 * These must be imported from the configured DSL module.
 */
const DSL_SCALAR_TYPES: ReadonlyMap<string, IRType> = new Map([
    ["ID", { kind: "id" }],
    ["DateOnly", { kind: "date" }],
    ["DateTime", { kind: "dateTime" }],
    ["TimeOfDay", { kind: "time" }],
    ["Decimal", { kind: "decimal" }],
    ["Json", { kind: "json" }],
    ["Bytes", { kind: "bytes" }],
    ["Regexp", { kind: "regexp" }],
]);

/** Global (non-DSL) type names that map to IR types. */
const GLOBAL_SCALAR_TYPES: ReadonlyMap<string, IRType> = new Map([
    ["Date", { kind: "dateTime" }],
    ["Uint8Array", { kind: "bytes" }],
    ["RegExp", { kind: "regexp" }],
]);

type TypeMapContext = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    /** Class names of all discovered @Schema classes. */
    schemaClassNames: ReadonlySet<string>;
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
};

export type MapTypeResult = { type: IRType } | { diag: IRDiagnostic };

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
        return { type: { kind: "array", of: inner.type } };
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

function isNullishTypeNode(t: ts.TypeNode): boolean {
    if (t.kind === ts.SyntaxKind.UndefinedKeyword) return true;
    if (t.kind === ts.SyntaxKind.NullKeyword) return true;
    // In TypeScript 5.x, `null` in type position is a LiteralTypeNode wrapping NullKeyword
    return ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;

}

function mapUnionType(node: ts.UnionTypeNode, ctx: TypeMapContext): MapTypeResult {
    const nullishMembers = node.types.filter(isNullishTypeNode);
    const valueMembers = node.types.filter((t) => !isNullishTypeNode(t));

    // All members are string literals → enum
    if (
        nullishMembers.length === 0 &&
        valueMembers.every((m) => ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal))
    ) {
        const values = valueMembers.map((m) =>
            (m as ts.LiteralTypeNode & { literal: ts.StringLiteral }).literal.text
        );
        if (values.length === 0) {
            const diag = mkError(KEYMA024, "Enum must have at least one value", getLocation(node, ctx.sourceFile));
            return { diag };
        }
        return { type: { kind: "enum", values } };
    }

    // Nullable: T | null | undefined → nullable(T)
    if (valueMembers.length === 1 && nullishMembers.length > 0) {
        const member = valueMembers[0];
        if (!member) return fail(node, ctx, "empty union type");
        const inner = mapTypeNode(member, ctx);
        if ("diag" in inner) return inner;
        return { type: { kind: "nullable", of: inner.type } };
    }

    // Nullable enum: "a" | "b" | null → nullable(enum)
    if (
        nullishMembers.length > 0 &&
        valueMembers.length > 0 &&
        valueMembers.every((m) => ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal))
    ) {
        const values = valueMembers.map((m) =>
            (m as ts.LiteralTypeNode & { literal: ts.StringLiteral }).literal.text
        );
        return { type: { kind: "nullable", of: { kind: "enum", values } } };
    }

    return fail(node, ctx, "union types must be string literals or T | null");
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
        return { type: { kind: "array", of: inner.type } };
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

    const fromDsl = isFromModule(symbol, ctx.checker, ctx.dslModuleName);

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
            return { type: { kind: "nullable", of: inner.type } };
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

        return fail(node, ctx, `unknown DSL type "${name}"`);
    }

    // Schema class reference (bare class type → reference by default)
    if (ctx.schemaClassNames.has(name)) {
        return { type: { kind: "reference", schema: name } };
    }

    return fail(node, ctx, `unknown type "${name}" — use a primitive, DSL type, or a @Schema class`);
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

function fail(node: ts.Node, ctx: TypeMapContext, detail: string): { diag: IRDiagnostic } {
    const diag = mkError(KEYMA010, `Unknown field type: ${detail}`, getLocation(node, ctx.sourceFile));
    return { diag };
}

export type { TypeMapContext };
