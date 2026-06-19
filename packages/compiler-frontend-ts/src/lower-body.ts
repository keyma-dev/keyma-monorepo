import ts from "typescript";
import type { IRExpression, IRStatement, IRDiagnostic } from "@keyma/ir";
import { intrinsicByMember } from "@keyma/ir";
import { mkError, KEYMA082, KEYMA085, KEYMA087 } from "./diagnostics.js";
import { getLocation } from "./util.js";

/**
 * How a call to a bare identifier should be treated when lowering a body:
 * - `compile`: the identifier resolves to a project-local utility function that
 *   has been enqueued for compilation; emit an identifier call to its canonical
 *   `name` (resolved across import aliases so it matches the emitted declaration).
 * - `passthrough`: a local binding (factory param, inner param, local const) —
 *   emit a plain identifier call, nothing to compile.
 * - `reject`: the function cannot be compiled (external/untyped); a diagnostic was
 *   already pushed, so abort lowering this expression.
 */
export type FnRefVerdict =
    | { kind: "compile"; name: string }
    | { kind: "passthrough" }
    | { kind: "reject" };

/** Shared context for lowering validator/formatter/utility-function bodies. */
export type BodyLowerCtx = {
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
    /**
     * Classify (and enqueue, if compilable) a call target identifier. When absent,
     * identifier calls are emitted verbatim. Wired up by the utility-function
     * collector in compile.ts.
     */
    classifyFunction?: (ident: ts.Identifier) => FnRefVerdict;
};

/** Portable global constructors usable on the right of `instanceof`. */
const SUPPORTED_INSTANCEOF = new Set(["Date", "RegExp", "Uint8Array", "Array"]);

// ─── Statement lowering ───────────────────────────────────────────────────────

export function lowerStatement(stmt: ts.Statement, ctx: BodyLowerCtx): IRStatement | null {
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

export function lowerBlock(node: ts.Statement, ctx: BodyLowerCtx): IRStatement[] {
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

export function lowerExpr(node: ts.Expression, ctx: BodyLowerCtx): IRExpression | null {
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
        return lowerPropertyAccess(node, ctx);
    }

    if (ts.isCallExpression(node)) {
        return lowerCall(node, ctx);
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

// ─── Intrinsic recognition ────────────────────────────────────────────────────

/** Classify a receiver's static type for intrinsic lookup. */
function classifyReceiver(checker: ts.TypeChecker, t: ts.Type): "string" | "array" | "regexp" | undefined {
    if ((t.flags & ts.TypeFlags.StringLike) !== 0) return "string";
    if (t.isUnion() && t.types.length > 0 && t.types.every((x) => (x.flags & ts.TypeFlags.StringLike) !== 0)) {
        return "string";
    }
    const sym = t.getSymbol();
    const name = sym?.getName();
    if (name === "Array" || name === "ReadonlyArray") return "array";
    if (name === "RegExp") return "regexp";
    return undefined;
}

/** Lower `a.b` — recognizing property intrinsics like `.length` on a string/array. */
function lowerPropertyAccess(node: ts.PropertyAccessExpression, ctx: BodyLowerCtx): IRExpression | null {
    const recvKind = classifyReceiver(ctx.checker, ctx.checker.getTypeAtLocation(node.expression));
    if (recvKind !== undefined) {
        const intr = intrinsicByMember(recvKind, node.name.text);
        if (intr !== undefined && intr.form === "property") {
            const receiver = lowerExpr(node.expression, ctx);
            if (receiver === null) return null;
            return { kind: "intrinsic", op: intr.op, receiver, args: [] };
        }
    }
    const obj = lowerExpr(node.expression, ctx);
    if (obj === null) return null;
    return { kind: "member", object: obj, member: node.name.text };
}

/** Lower a call — recognizing method intrinsics and classifying utility-function calls. */
function lowerCall(node: ts.CallExpression, ctx: BodyLowerCtx): IRExpression | null {
    // Method-call intrinsic? e.g. value.includes("x")
    if (ts.isPropertyAccessExpression(node.expression)) {
        const recv = node.expression.expression;
        const recvKind = classifyReceiver(ctx.checker, ctx.checker.getTypeAtLocation(recv));
        if (recvKind !== undefined) {
            const methodName = node.expression.name.text;
            const intr = intrinsicByMember(recvKind, methodName);
            if (intr === undefined || intr.form !== "method") {
                ctx.diagnostics.push(mkError(
                    KEYMA085,
                    `"${methodName}" is not a supported ${recvKind} method intrinsic — see packages/ir/intrinsics.md`,
                    getLocation(node, ctx.sourceFile),
                ));
                return null;
            }
            if (node.arguments.length < intr.minArgs || node.arguments.length > intr.maxArgs) {
                ctx.diagnostics.push(mkError(
                    KEYMA085,
                    `Intrinsic "${intr.op}" expects ${intr.minArgs}..${intr.maxArgs} args, got ${node.arguments.length}`,
                    getLocation(node, ctx.sourceFile),
                ));
                return null;
            }
            const receiver = lowerExpr(recv, ctx);
            if (receiver === null) return null;
            const args = lowerArgs(node.arguments, ctx);
            if (args === null) return null;
            return { kind: "intrinsic", op: intr.op, receiver, args };
        }
        // Non-string/array receiver: fall through to generic member call below.
    }

    // Bare identifier callee → maybe a project-local utility function.
    if (ts.isIdentifier(node.expression) && ctx.classifyFunction !== undefined) {
        const verdict = ctx.classifyFunction(node.expression);
        if (verdict.kind === "reject") return null;
        if (verdict.kind === "compile") {
            const args = lowerArgs(node.arguments, ctx);
            if (args === null) return null;
            return { kind: "call", callee: { kind: "identifier", name: verdict.name }, args };
        }
    }

    const callee = lowerExpr(node.expression, ctx);
    if (callee === null) return null;
    const args = lowerArgs(node.arguments, ctx);
    if (args === null) return null;
    return { kind: "call", callee, args };
}

function lowerArgs(argNodes: ts.NodeArray<ts.Expression>, ctx: BodyLowerCtx): IRExpression[] | null {
    const args: IRExpression[] = [];
    for (const arg of argNodes) {
        const a = lowerExpr(arg, ctx);
        if (a === null) return null;
        args.push(a);
    }
    return args;
}

// ─── Templates / operators / literals ─────────────────────────────────────────

function lowerTemplate(node: ts.TemplateExpression, ctx: BodyLowerCtx): IRExpression | null {
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

const EQUALITY_TOKENS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
]);

function isNegatedEquality(kind: ts.SyntaxKind): boolean {
    return kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken;
}

function lowerBinary(node: ts.BinaryExpression, ctx: BodyLowerCtx): IRExpression | null {
    const opKind = node.operatorToken.kind;

    // `x instanceof Ctor` → instance-of intrinsic
    if (opKind === ts.SyntaxKind.InstanceOfKeyword) {
        return lowerInstanceOf(node, ctx);
    }

    // `typeof x === "string"` → type-is intrinsic
    if (EQUALITY_TOKENS.has(opKind)) {
        const typeIs = tryLowerTypeIs(node, ctx);
        if (typeIs !== undefined) return typeIs;
    }

    const op = BINARY_OP_MAP.get(opKind);
    if (op === undefined) {
        ctx.diagnostics.push(mkError(KEYMA082, `Binary operator ${ts.SyntaxKind[opKind]} is not supported`, getLocation(node, ctx.sourceFile)));
        return null;
    }
    const left = lowerExpr(node.left, ctx);
    if (left === null) return null;
    const right = lowerExpr(node.right, ctx);
    if (right === null) return null;
    return { kind: "binary", op, left, right };
}

/** Recognize `typeof X === "literal"` (and negated). Returns undefined if not that shape. */
function tryLowerTypeIs(node: ts.BinaryExpression, ctx: BodyLowerCtx): IRExpression | null | undefined {
    let typeofExpr: ts.TypeOfExpression | undefined;
    let literal: ts.StringLiteral | undefined;
    if (ts.isTypeOfExpression(node.left) && ts.isStringLiteral(node.right)) {
        typeofExpr = node.left;
        literal = node.right;
    } else if (ts.isTypeOfExpression(node.right) && ts.isStringLiteral(node.left)) {
        typeofExpr = node.right;
        literal = node.left;
    }
    if (typeofExpr === undefined || literal === undefined) return undefined;

    const receiver = lowerExpr(typeofExpr.expression, ctx);
    if (receiver === null) return null;
    const intrinsic: IRExpression = {
        kind: "intrinsic",
        op: "type-is",
        receiver,
        args: [{ kind: "literal", value: literal.text }],
    };
    return isNegatedEquality(node.operatorToken.kind)
        ? { kind: "unary", op: "!", operand: intrinsic }
        : intrinsic;
}

function lowerInstanceOf(node: ts.BinaryExpression, ctx: BodyLowerCtx): IRExpression | null {
    if (!ts.isIdentifier(node.right) || !SUPPORTED_INSTANCEOF.has(node.right.text)) {
        const ctor = ts.isIdentifier(node.right) ? node.right.text : "<expression>";
        ctx.diagnostics.push(mkError(
            KEYMA087,
            `\`instanceof ${ctor}\` is not portable — only ${[...SUPPORTED_INSTANCEOF].join(", ")} are supported`,
            getLocation(node, ctx.sourceFile),
        ));
        return null;
    }
    const receiver = lowerExpr(node.left, ctx);
    if (receiver === null) return null;
    return {
        kind: "intrinsic",
        op: "instance-of",
        receiver,
        args: [{ kind: "literal", value: node.right.text }],
    };
}

function lowerUnary(node: ts.PrefixUnaryExpression, ctx: BodyLowerCtx): IRExpression | null {
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

function lowerObjectLiteral(node: ts.ObjectLiteralExpression, ctx: BodyLowerCtx): IRExpression | null {
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
