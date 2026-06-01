import ts from "typescript";
import type {
    IRValidatorDeclaration,
    IRFormatterDeclaration,
    IRFunctionBody,
    IRParam,
    IRStatement,
    IRExpression,
    IRDiagnostic,
} from "@keyma/ir";
import { mkError, KEYMA081, KEYMA082, KEYMA083 } from "./diagnostics.js";
import { getLocation } from "./util.js";
import type { DiscoveredValidator, DiscoveredFormatter } from "./discover-validators.js";

type LowerCtx = {
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
};

// ─── Public entry points ─────────────────────────────────────────────────────

export function lowerValidatorDeclaration(
    discovered: DiscoveredValidator,
    extraDiagnostics: IRDiagnostic[],
): IRValidatorDeclaration {
    const ctx: LowerCtx = { diagnostics: extraDiagnostics, sourceFile: discovered.sourceFile };
    const { factoryParams, body } = lowerFactory(discovered.funcNode, ctx);
    return { name: discovered.validatorName, factoryParams, body, source: discovered.source };
}

export function lowerFormatterDeclaration(
    discovered: DiscoveredFormatter,
    extraDiagnostics: IRDiagnostic[],
): IRFormatterDeclaration {
    const ctx: LowerCtx = { diagnostics: extraDiagnostics, sourceFile: discovered.sourceFile };
    const { factoryParams, body } = lowerFactory(discovered.funcNode, ctx);
    return { name: discovered.formatterName, factoryParams, body, source: discovered.source };
}

// ─── Factory lowering ─────────────────────────────────────────────────────────

type LoweredFactory = {
    factoryParams: { name: string }[];
    body: IRFunctionBody;
};

function lowerFactory(func: ts.ArrowFunction | ts.FunctionExpression, ctx: LowerCtx): LoweredFactory {
    const factoryParams: { name: string }[] = func.parameters.map((p) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : "_",
    }));

    let innerFn: ts.Expression;

    if (ts.isArrowFunction(func) && !ts.isBlock(func.body)) {
        // Concise arrow: (factoryParams) => innerFn
        innerFn = func.body;
    } else {
        const body = func.body as ts.Block;
        if (body.statements.length !== 1) {
            ctx.diagnostics.push(mkError(
                KEYMA081,
                "Validator/formatter factory body must contain a single return statement returning an inner function",
                getLocation(body, ctx.sourceFile),
            ));
            return { factoryParams, body: emptyBody() };
        }

        const stmt = body.statements[0];
        if (!stmt || !ts.isReturnStatement(stmt) || !stmt.expression) {
            ctx.diagnostics.push(mkError(KEYMA081, "Factory body must be a single return statement", getLocation(body, ctx.sourceFile)));
            return { factoryParams, body: emptyBody() };
        }

        innerFn = stmt.expression;
    }

    if (!ts.isArrowFunction(innerFn) && !ts.isFunctionExpression(innerFn)) {
        ctx.diagnostics.push(mkError(KEYMA081, "Factory must return an arrow function or function expression", getLocation(innerFn, ctx.sourceFile)));
        return { factoryParams, body: emptyBody() };
    }

    // Inner params by position: 0=value, 1=field, 2=context
    const innerParams = innerFn.parameters;
    if (innerParams.length < 1 || innerParams.length > 3) {
        ctx.diagnostics.push(mkError(
            KEYMA083,
            `Inner function must have 1–3 parameters (value[, fieldKey[, context]]), got ${innerParams.length}`,
            getLocation(innerFn, ctx.sourceFile),
        ));
        return { factoryParams, body: emptyBody() };
    }

    const roles: Array<"value" | "field" | "context"> = ["value", "field", "context"];
    const irParams: IRParam[] = innerParams.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `_p${i}`,
        role: roles[i] ?? "context",
    }));

    const irStatements: IRStatement[] = [];

    if (ts.isArrowFunction(innerFn) && !ts.isBlock(innerFn.body)) {
        // Concise arrow: (params) => expression
        const expr = lowerExpr(innerFn.body, ctx);
        if (expr !== null) irStatements.push({ kind: "return", value: expr });
    } else {
        const blockBody = innerFn.body as ts.Block;
        for (const s of blockBody.statements) {
            const irStmt = lowerStatement(s, ctx);
            if (irStmt !== null) irStatements.push(irStmt);
        }
    }

    return { factoryParams, body: { params: irParams, statements: irStatements } };
}

// ─── Statement lowering ───────────────────────────────────────────────────────

function lowerStatement(stmt: ts.Statement, ctx: LowerCtx): IRStatement | null {
    if (ts.isReturnStatement(stmt)) {
        if (!stmt.expression) return { kind: "return", value: null };
        const val = lowerExpr(stmt.expression, ctx);
        if (val === null) return null;
        return { kind: "return", value: val };
    }

    if (ts.isIfStatement(stmt)) {
        const condition = lowerExpr(stmt.expression, ctx);
        if (condition === null) return null;
        const consequent = lowerBlock(stmt.thenStatement, ctx);
        const out: IRStatement = { kind: "if", condition, consequent };
        if (stmt.elseStatement) {
            out.alternate = lowerBlock(stmt.elseStatement, ctx);
        }
        return out;
    }

    if (ts.isVariableStatement(stmt)) {
        const decls = stmt.declarationList.declarations;
        if (decls.length !== 1) {
            ctx.diagnostics.push(mkError(KEYMA082, "Only single-variable const declarations are supported", getLocation(stmt, ctx.sourceFile)));
            return null;
        }
        const decl = decls[0];
        if (!decl || !ts.isIdentifier(decl.name) || !decl.initializer) {
            ctx.diagnostics.push(mkError(KEYMA082, "Variable declaration must have an initializer and a simple name", getLocation(stmt, ctx.sourceFile)));
            return null;
        }
        const init = lowerExpr(decl.initializer, ctx);
        if (init === null) return null;
        return { kind: "const", name: decl.name.text, init };
    }

    if (ts.isExpressionStatement(stmt)) {
        const expr = lowerExpr(stmt.expression, ctx);
        if (expr === null) return null;
        return { kind: "expression", expr };
    }

    ctx.diagnostics.push(mkError(KEYMA082, `Unsupported statement kind: ${ts.SyntaxKind[stmt.kind]}`, getLocation(stmt, ctx.sourceFile)));
    return null;
}

function lowerBlock(node: ts.Statement, ctx: LowerCtx): IRStatement[] {
    if (ts.isBlock(node)) {
        const stmts: IRStatement[] = [];
        for (const s of node.statements) {
            const irS = lowerStatement(s, ctx);
            if (irS !== null) stmts.push(irS);
        }
        return stmts;
    }
    const irS = lowerStatement(node, ctx);
    return irS !== null ? [irS] : [];
}

// ─── Expression lowering ──────────────────────────────────────────────────────

function lowerExpr(node: ts.Expression, ctx: LowerCtx): IRExpression | null {
    if (ts.isParenthesizedExpression(node)) return lowerExpr(node.expression, ctx);

    if (ts.isStringLiteral(node)) return { kind: "literal", value: node.text };
    if (ts.isNumericLiteral(node)) return { kind: "literal", value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "literal", value: null };
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) return { kind: "identifier", name: "undefined" };

    if (ts.isIdentifier(node)) return { kind: "identifier", name: node.text };

    if (ts.isTypeOfExpression(node)) {
        const operand = lowerExpr(node.expression, ctx);
        if (operand === null) return null;
        return { kind: "typeof", operand };
    }

    if (ts.isPropertyAccessExpression(node)) {
        const obj = lowerExpr(node.expression, ctx);
        if (obj === null) return null;
        return { kind: "member", object: obj, member: node.name.text };
    }

    if (ts.isCallExpression(node)) {
        const callee = lowerExpr(node.expression, ctx);
        if (callee === null) return null;
        const args: IRExpression[] = [];
        for (const arg of node.arguments) {
            const a = lowerExpr(arg as ts.Expression, ctx);
            if (a === null) return null;
            args.push(a);
        }
        return { kind: "call", callee, args };
    }

    if (ts.isNewExpression(node)) {
        const callee = lowerExpr(node.expression, ctx);
        if (callee === null) return null;
        const args: IRExpression[] = [];
        for (const arg of node.arguments ?? []) {
            const a = lowerExpr(arg as ts.Expression, ctx);
            if (a === null) return null;
            args.push(a);
        }
        return { kind: "new", callee, args };
    }

    if (ts.isTemplateExpression(node)) return lowerTemplate(node, ctx);
    if (ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "literal", value: node.text };

    if (ts.isRegularExpressionLiteral(node)) {
        const match = /^\/(.*)\/([gimsuy]*)$/.exec(node.text);
        if (match && match[1] !== undefined) {
            return { kind: "regexp", pattern: match[1], flags: match[2] ?? "" };
        }
        ctx.diagnostics.push(mkError(KEYMA082, `Malformed regular expression literal: ${node.text}`, getLocation(node, ctx.sourceFile)));
        return null;
    }

    if (ts.isArrowFunction(node)) {
        if (ts.isBlock(node.body)) {
            ctx.diagnostics.push(mkError(KEYMA082, "Arrow functions in validator/formatter bodies must have a concise expression body (no block)", getLocation(node, ctx.sourceFile)));
            return null;
        }
        const params = node.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : "_"));
        const body = lowerExpr(node.body, ctx);
        if (body === null) return null;
        return { kind: "arrow", params, body };
    }

    if (ts.isBinaryExpression(node)) return lowerBinary(node, ctx);
    if (ts.isPrefixUnaryExpression(node)) return lowerUnary(node, ctx);

    if (ts.isConditionalExpression(node)) {
        const cond = lowerExpr(node.condition, ctx);
        if (cond === null) return null;
        const whenTrue = lowerExpr(node.whenTrue, ctx);
        if (whenTrue === null) return null;
        const whenFalse = lowerExpr(node.whenFalse, ctx);
        if (whenFalse === null) return null;
        return { kind: "conditional", condition: cond, whenTrue, whenFalse };
    }

    if (ts.isObjectLiteralExpression(node)) return lowerObjectLiteral(node, ctx);

    ctx.diagnostics.push(mkError(
        KEYMA082,
        `Unsupported expression kind in validator/formatter body: ${ts.SyntaxKind[node.kind]}`,
        getLocation(node, ctx.sourceFile),
    ));
    return null;
}

function lowerTemplate(node: ts.TemplateExpression, ctx: LowerCtx): IRExpression | null {
    const parts: IRExpression[] = [];
    if (node.head.text !== "") parts.push({ kind: "literal", value: node.head.text });
    for (const span of node.templateSpans) {
        const exprResult = lowerExpr(span.expression, ctx);
        if (exprResult === null) return null;
        parts.push(exprResult);
        if (span.literal.text !== "") parts.push({ kind: "literal", value: span.literal.text });
    }
    if (parts.length === 1 && parts[0] !== undefined) return parts[0];
    return { kind: "template", parts };
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

function lowerBinary(node: ts.BinaryExpression, ctx: LowerCtx): IRExpression | null {
    const op = BINARY_OP_MAP.get(node.operatorToken.kind);
    if (op === undefined) {
        ctx.diagnostics.push(mkError(KEYMA082, `Binary operator ${ts.SyntaxKind[node.operatorToken.kind]} is not supported`, getLocation(node, ctx.sourceFile)));
        return null;
    }
    const left = lowerExpr(node.left, ctx);
    if (left === null) return null;
    const right = lowerExpr(node.right, ctx);
    if (right === null) return null;
    return { kind: "binary", op, left, right };
}

function lowerUnary(node: ts.PrefixUnaryExpression, ctx: LowerCtx): IRExpression | null {
    const opMap = new Map<ts.SyntaxKind, "!" | "-" | "+">([
        [ts.SyntaxKind.ExclamationToken, "!"],
        [ts.SyntaxKind.MinusToken, "-"],
        [ts.SyntaxKind.PlusToken, "+"],
    ]);
    const op = opMap.get(node.operator);
    if (op === undefined) {
        ctx.diagnostics.push(mkError(KEYMA082, `Unary operator ${ts.SyntaxKind[node.operator]} is not supported`, getLocation(node, ctx.sourceFile)));
        return null;
    }
    const operand = lowerExpr(node.operand, ctx);
    if (operand === null) return null;
    return { kind: "unary", op, operand };
}

function lowerObjectLiteral(node: ts.ObjectLiteralExpression, ctx: LowerCtx): IRExpression | null {
    const properties: Array<{ key: string; value: IRExpression }> = [];
    for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) {
            ctx.diagnostics.push(mkError(KEYMA082, "Object literal properties must be simple assignments in validator/formatter bodies", getLocation(prop, ctx.sourceFile)));
            return null;
        }
        const key = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name)
                ? prop.name.text
                : undefined;
        if (key === undefined) {
            ctx.diagnostics.push(mkError(KEYMA082, "Object literal property key must be an identifier or string", getLocation(prop.name, ctx.sourceFile)));
            return null;
        }
        const val = lowerExpr(prop.initializer, ctx);
        if (val === null) return null;
        properties.push({ key, value: val });
    }
    return { kind: "object", properties };
}

function emptyBody(): IRFunctionBody {
    return { params: [], statements: [] };
}
