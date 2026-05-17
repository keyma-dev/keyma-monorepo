import ts from "typescript";
import type { IRExpression, IRDiagnostic } from "@keyma/ir";
import { mkError, KEYMA014 } from "./diagnostics.js";
import { getLocation } from "./util.js";

type ExprContext = {
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
};

export type LowerExprResult = { expr: IRExpression } | { diag: IRDiagnostic };

/** Lower a getter body to an IRExpression. */
export function lowerGetterBody(
    getter: ts.GetAccessorDeclaration,
    ctx: ExprContext
): LowerExprResult {
    const body = getter.body;
    if (!body) {
        return fail(getter, ctx, "computed getter must have a body");
    }

    // Single return statement (or expression body via a block with one statement)
    const stmts = body.statements;
    if (stmts.length !== 1) {
        return fail(body, ctx, "computed getter body must contain a single return statement");
    }

    const stmt = stmts[0];
    if (!stmt || !ts.isReturnStatement(stmt) || !stmt.expression) {
        return fail(body, ctx, "computed getter body must contain a single return statement");
    }

    return lowerExpression(stmt.expression, ctx);
}

function lowerExpression(node: ts.Expression, ctx: ExprContext): LowerExprResult {
    // Literals
    if (ts.isStringLiteral(node)) return { expr: { kind: "literal", value: node.text } };
    if (ts.isNumericLiteral(node)) return { expr: { kind: "literal", value: Number(node.text) } };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { expr: { kind: "literal", value: true } };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { expr: { kind: "literal", value: false } };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { expr: { kind: "literal", value: null } };

    // Parenthesized
    if (ts.isParenthesizedExpression(node)) return lowerExpression(node.expression, ctx);

    // `this.fieldName` → field
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        return { expr: { kind: "field", name: node.name.text } };
    }

    // Bare identifier (uncommon in getter bodies but handle it)
    if (ts.isIdentifier(node)) {
        return { expr: { kind: "field", name: node.text } };
    }

    // `this.obj.member` → member(field(obj), member)
    if (ts.isPropertyAccessExpression(node)) {
        const objResult = lowerExpression(node.expression, ctx);
        if ("diag" in objResult) return objResult;
        return { expr: { kind: "member", object: objResult.expr, member: node.name.text } };
    }

    // Template literal: `${this.a} ${this.b}`
    if (ts.isTemplateExpression(node)) {
        return lowerTemplate(node, ctx);
    }

    // NoSubstitutionTemplateLiteral: `hello`
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
        return { expr: { kind: "literal", value: node.text } };
    }

    // Binary expressions
    if (ts.isBinaryExpression(node)) {
        return lowerBinary(node, ctx);
    }

    // Prefix unary: !, -, +
    if (ts.isPrefixUnaryExpression(node)) {
        return lowerUnary(node, ctx);
    }

    // Conditional: a ? b : c
    if (ts.isConditionalExpression(node)) {
        const cond = lowerExpression(node.condition, ctx);
        if ("diag" in cond) return cond;
        const whenTrue = lowerExpression(node.whenTrue, ctx);
        if ("diag" in whenTrue) return whenTrue;
        const whenFalse = lowerExpression(node.whenFalse, ctx);
        if ("diag" in whenFalse) return whenFalse;
        return { expr: { kind: "conditional", condition: cond.expr, whenTrue: whenTrue.expr, whenFalse: whenFalse.expr } };
    }

    return fail(node, ctx, `expression kind ${ts.SyntaxKind[node.kind]} is not supported in computed getters`);
}

function lowerTemplate(node: ts.TemplateExpression, ctx: ExprContext): LowerExprResult {
    const parts: IRExpression[] = [];

    if (node.head.text !== "") {
        parts.push({ kind: "literal", value: node.head.text });
    }

    for (const span of node.templateSpans) {
        const exprResult = lowerExpression(span.expression, ctx);
        if ("diag" in exprResult) return exprResult;
        parts.push(exprResult.expr);
        if (span.literal.text !== "") {
            parts.push({ kind: "literal", value: span.literal.text });
        }
    }

    if (parts.length === 1) {
        const part = parts[0];
        if (part !== undefined) return { expr: part };
    }

    return { expr: { kind: "template", parts } };
}

type BinaryOp = "+" | "-" | "*" | "/" | "%" | "&&" | "||" | "??" | "==" | "!=" | "<" | "<=" | ">" | ">=";

const BINARY_OP_MAP = new Map<ts.SyntaxKind, BinaryOp>([
    [ts.SyntaxKind.PlusToken, "+"],
    [ts.SyntaxKind.MinusToken, "-"],
    [ts.SyntaxKind.AsteriskToken, "*"],
    [ts.SyntaxKind.SlashToken, "/"],
    [ts.SyntaxKind.PercentToken, "%"],
    [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
    [ts.SyntaxKind.BarBarToken, "||"],
    [ts.SyntaxKind.QuestionQuestionToken, "??"],
    [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
    [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="],
    [ts.SyntaxKind.EqualsEqualsToken, "=="],
    [ts.SyntaxKind.ExclamationEqualsToken, "!="],
    [ts.SyntaxKind.LessThanToken, "<"],
    [ts.SyntaxKind.LessThanEqualsToken, "<="],
    [ts.SyntaxKind.GreaterThanToken, ">"],
    [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
]);

function lowerBinary(node: ts.BinaryExpression, ctx: ExprContext): LowerExprResult {
    const op = BINARY_OP_MAP.get(node.operatorToken.kind) as BinaryOp | undefined;
    if (op === undefined) {
        return fail(node, ctx, `binary operator ${ts.SyntaxKind[node.operatorToken.kind]} is not supported`);
    }
    const left = lowerExpression(node.left, ctx);
    if ("diag" in left) return left;
    const right = lowerExpression(node.right, ctx);
    if ("diag" in right) return right;
    return { expr: { kind: "binary", op, left: left.expr, right: right.expr } };
}

function lowerUnary(node: ts.PrefixUnaryExpression, ctx: ExprContext): LowerExprResult {
    const opMap = new Map<ts.SyntaxKind, "!" | "-" | "+">([
        [ts.SyntaxKind.ExclamationToken, "!"],
        [ts.SyntaxKind.MinusToken, "-"],
        [ts.SyntaxKind.PlusToken, "+"],
    ]);
    const op = opMap.get(node.operator);
    if (op === undefined) {
        return fail(node, ctx, `unary operator ${ts.SyntaxKind[node.operator]} is not supported`);
    }
    const operand = lowerExpression(node.operand, ctx);
    if ("diag" in operand) return operand;
    return { expr: { kind: "unary", op, operand: operand.expr } };
}

function fail(node: ts.Node, ctx: ExprContext, detail: string): { diag: IRDiagnostic } {
    const diag = mkError(KEYMA014, `Unsupported computed getter expression: ${detail}`, getLocation(node, ctx.sourceFile));
    return { diag };
}
