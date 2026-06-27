import ts from "typescript";
import type { IRExpression, IRStatement, IRSwitchCase, IRType, IRDiagnostic } from "@keyma/core/ir";
import { intrinsicByMember, intrinsicByOp } from "@keyma/core/ir";
import { mkError, mkWarning, KEYMA082, KEYMA085, KEYMA087, KEYMA0201, KEYMA0202, KEYMA0203, KEYMA0204, KEYMA0205 } from "./diagnostics.js";
import { getLocation } from "./util.js";
import { inferIRTypeFromType } from "./map-type.js";

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

/**
 * Shared context for lowering the portable expression/statement subset. The same
 * core lowers two surfaces:
 * - portable function/utility-function bodies (`refMode: "params"` — the default):
 *   bare identifiers resolve to the inner function's params/locals.
 * - computed getter bodies (`refMode: "fields"`): bare identifiers and `this.x`
 *   resolve to class fields, and non-intrinsic calls are rejected.
 */
export type PortableExprCtx = {
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    checker: ts.TypeChecker;
    dslModuleName: string;
    classNames: ReadonlySet<string>;
    /**
     * Classify (and enqueue, if compilable) a call target identifier. When absent,
     * identifier calls are emitted verbatim (params mode) or rejected (fields mode).
     * Wired up by the utility-function collector in compile.ts.
     */
    classifyFunction?: (ident: ts.Identifier) => FnRefVerdict;
    /** How bare/`this` references resolve. Defaults to `"params"`. */
    refMode?: "fields" | "params";
    /**
     * Lexically-visible local bindings (getter `const`s, arrow params). Consulted
     * only in **field mode**: a bare identifier in this set lowers to a local
     * `{kind:"identifier"}` rather than a class `{kind:"field"}`. A no-op in params
     * mode, where every bare identifier is already an `identifier`.
     */
    locals?: ReadonlySet<string>;
    /** Diagnostic code for unsupported constructs. Defaults to KEYMA082. */
    unsupportedCode?: string;
    /**
     * Whether `target = value` assignment statements are permitted. Enabled for
     * method/setter behavior bodies; off (default) for validator/formatter bodies,
     * which must not mutate.
     */
    allowAssign?: boolean;
};

/** Body lowering is the historical name for params-mode portable lowering. */
export type BodyLowerCtx = PortableExprCtx;

/** Resolve the diagnostic code for an unsupported construct in this context. */
function unsupp(ctx: PortableExprCtx): string {
    return ctx.unsupportedCode ?? KEYMA082;
}

/** Whether bare/`this` references resolve to class fields (getter mode). */
function isFieldMode(ctx: PortableExprCtx): boolean {
    return ctx.refMode === "fields";
}

/** Portable global constructors usable on the right of `instanceof`. */
const SUPPORTED_INSTANCEOF = new Set(["Date", "RegExp", "Uint8Array", "Array"]);

// ─── Statement lowering ───────────────────────────────────────────────────────

export function lowerStatement(stmt: ts.Statement, ctx: PortableExprCtx): IRStatement | null {
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
            ctx.diagnostics.push(mkError(unsupp(ctx), "Only single-variable const declarations are supported", getLocation(stmt, ctx.sourceFile)));
            return null;
        }
        const decl = decls[0];
        if (!decl || !ts.isIdentifier(decl.name) || !decl.initializer) {
            ctx.diagnostics.push(mkError(unsupp(ctx), "Variable declaration must have an initializer and a simple name", getLocation(stmt, ctx.sourceFile)));
            return null;
        }
        const init = lowerExpr(decl.initializer, ctx);
        if (init === null) return null;
        return { kind: "const", name: decl.name.text, init };
    }

    if (ts.isExpressionStatement(stmt)) {
        const inner = stmt.expression;
        // `target = value` — permitted only in method/setter bodies.
        if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            if (ctx.allowAssign !== true) {
                ctx.diagnostics.push(mkError(unsupp(ctx), "Assignment is not allowed in this body", getLocation(stmt, ctx.sourceFile)));
                return null;
            }
            const target = lowerExpr(inner.left, ctx);
            if (target === null) return null;
            const value = lowerExpr(inner.right, ctx);
            if (value === null) return null;
            return { kind: "assign", target, value };
        }
        const expr = lowerExpr(inner, ctx);
        if (expr === null) return null;
        return { kind: "expression", expr };
    }

    // `for (const x of iterable) { … }` — a single `const` binding with a simple identifier.
    if (ts.isForOfStatement(stmt)) {
        if (stmt.awaitModifier !== undefined) {
            ctx.diagnostics.push(mkError(unsupp(ctx), "`for await … of` is not portable", getLocation(stmt, ctx.sourceFile)));
            return null;
        }
        const list = stmt.initializer;
        if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0 || list.declarations.length !== 1) {
            ctx.diagnostics.push(mkError(KEYMA0204, "`for…of` requires a single `const` binding (no `let`/`var`, no multiple bindings)", getLocation(stmt, ctx.sourceFile)));
            return null;
        }
        const decl = list.declarations[0];
        if (decl === undefined || !ts.isIdentifier(decl.name)) {
            ctx.diagnostics.push(mkError(KEYMA0204, "`for…of` binding must be a simple identifier (destructuring is not portable)", getLocation(stmt, ctx.sourceFile)));
            return null;
        }
        const iterable = lowerExpr(stmt.expression, ctx);
        if (iterable === null) return null;
        // In field mode the loop variable shadows any same-named class field inside the body.
        const bodyCtx: PortableExprCtx = isFieldMode(ctx)
            ? { ...ctx, locals: new Set([...(ctx.locals ?? []), decl.name.text]) }
            : ctx;
        const body = lowerBlock(stmt.statement, bodyCtx);
        return { kind: "forOf", name: decl.name.text, iterable, body };
    }

    if (ts.isWhileStatement(stmt)) {
        const condition = lowerExpr(stmt.expression, ctx);
        if (condition === null) return null;
        const body = lowerBlock(stmt.statement, ctx);
        return { kind: "while", condition, body };
    }

    if (ts.isBreakStatement(stmt)) {
        if (stmt.label !== undefined) {
            ctx.diagnostics.push(mkError(KEYMA0205, "Labeled `break` is not portable", getLocation(stmt, ctx.sourceFile)));
            return null;
        }
        return { kind: "break" };
    }

    if (ts.isContinueStatement(stmt)) {
        if (stmt.label !== undefined) {
            ctx.diagnostics.push(mkError(KEYMA0205, "Labeled `continue` is not portable", getLocation(stmt, ctx.sourceFile)));
            return null;
        }
        return { kind: "continue" };
    }

    // `for…in` is not portable — steer to `Object.keys`/`Object.entries` + `for…of`.
    if (ts.isForInStatement(stmt)) {
        ctx.diagnostics.push(mkError(
            KEYMA0203,
            "`for…in` is not portable — iterate `Object.keys(obj)` or `Object.entries(obj)` with a `for…of` loop instead",
            getLocation(stmt, ctx.sourceFile),
        ));
        return null;
    }

    if (ts.isSwitchStatement(stmt)) {
        const discriminant = lowerExpr(stmt.expression, ctx);
        if (discriminant === null) return null;
        const cases: IRSwitchCase[] = [];
        for (const clause of stmt.caseBlock.clauses) {
            // Source-faithful: lower each clause's statements as authored (a trailing
            // `break` lowers to `{kind:"break"}`; its absence is fallthrough).
            const body = lowerStatements(clause.statements, ctx);
            if (ts.isCaseClause(clause)) {
                const test = lowerExpr(clause.expression, ctx);
                if (test === null) return null;
                cases.push({ test, body });
            } else {
                cases.push({ test: null, body });
            }
        }
        return { kind: "switch", discriminant, cases };
    }

    ctx.diagnostics.push(mkError(unsupp(ctx), `Unsupported statement kind: ${ts.SyntaxKind[stmt.kind]}`, getLocation(stmt, ctx.sourceFile)));
    return null;
}

// ─── Multi-statement lowering (C-style `for` desugar) ─────────────────────────

/**
 * Lower one statement, appending the resulting IR statement(s) to `out`. Most
 * statements append exactly one node and defer to {@link lowerStatement}; a C-style
 * `for (init; cond; update)` is the one shape that desugars to several nodes — its
 * `init` becomes leading statement(s) and the loop becomes a `while` whose body ends
 * with the `update` step. Returns `false` (a diagnostic was pushed) on failure.
 */
function lowerStatementInto(out: IRStatement[], stmt: ts.Statement, ctx: PortableExprCtx): boolean {
    if (ts.isForStatement(stmt)) return lowerCStyleFor(out, stmt, ctx);
    const single = lowerStatement(stmt, ctx);
    if (single === null) return false;
    out.push(single);
    return true;
}

/**
 * Desugar a C-style `for (init; cond; update) body` to `init…; while (cond) { body; update }`,
 * emitting a KEYMA0201 warning. A `continue` anywhere in the body is a hard error (KEYMA0202):
 * the while-desugar cannot run the `update` step before continuing, so the loop semantics
 * would silently change.
 */
function lowerCStyleFor(out: IRStatement[], stmt: ts.ForStatement, ctx: PortableExprCtx): boolean {
    if (statementContainsContinue(stmt.statement)) {
        ctx.diagnostics.push(mkError(
            KEYMA0202,
            "`continue` inside a C-style `for` is not portable — it is desugared to a `while`, which cannot run the update step before continuing; rewrite as a `for…of` or `while` loop",
            getLocation(stmt, ctx.sourceFile),
        ));
        return false;
    }

    // init → leading statements
    const lead: IRStatement[] = [];
    const init = stmt.initializer;
    if (init !== undefined) {
        if (ts.isVariableDeclarationList(init)) {
            for (const decl of init.declarations) {
                if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) {
                    ctx.diagnostics.push(mkError(KEYMA0204, "C-style `for` initializer must declare simple, initialized identifier variables", getLocation(stmt, ctx.sourceFile)));
                    return false;
                }
                const value = lowerExpr(decl.initializer, ctx);
                if (value === null) return false;
                lead.push({ kind: "const", name: decl.name.text, init: value });
            }
        } else {
            const initStmts = lowerForSideEffect(init, ctx);
            if (initStmts === null) return false;
            lead.push(...initStmts);
        }
    }

    // condition (an omitted condition means an infinite loop → `true`)
    let condition: IRExpression;
    if (stmt.condition !== undefined) {
        const c = lowerExpr(stmt.condition, ctx);
        if (c === null) return false;
        condition = c;
    } else {
        condition = { kind: "literal", value: true };
    }

    // body, with the update step appended as trailing statement(s)
    const body = lowerBlock(stmt.statement, ctx);
    if (stmt.incrementor !== undefined) {
        const upd = lowerForSideEffect(stmt.incrementor, ctx);
        if (upd === null) return false;
        body.push(...upd);
    }

    ctx.diagnostics.push(mkWarning(
        KEYMA0201,
        "C-style `for (init; cond; update)` is desugared to a `while` loop; prefer `for…of` where possible",
        getLocation(stmt, ctx.sourceFile),
    ));

    out.push(...lead);
    out.push({ kind: "while", condition, body });
    return true;
}

/** Compound-assignment tokens → the underlying binary op (for C-style-`for` update steps). */
const COMPOUND_OP_MAP = new Map<ts.SyntaxKind, "+" | "-" | "*" | "/" | "%">([
    [ts.SyntaxKind.PlusEqualsToken, "+"],
    [ts.SyntaxKind.MinusEqualsToken, "-"],
    [ts.SyntaxKind.AsteriskEqualsToken, "*"],
    [ts.SyntaxKind.SlashEqualsToken, "/"],
    [ts.SyntaxKind.PercentEqualsToken, "%"],
]);

/** Require `allowAssign`; push a diagnostic and return false when mutation is disallowed. */
function requireAssign(ctx: PortableExprCtx, node: ts.Node): boolean {
    if (ctx.allowAssign === true) return true;
    ctx.diagnostics.push(mkError(unsupp(ctx), "Assignment is not allowed in this body", getLocation(node, ctx.sourceFile)));
    return false;
}

/**
 * Lower a C-style-`for` init/update expression to side-effecting IR statement(s),
 * desugaring `++`/`--` and compound assignments (`+=`, …) into `assign` statements so a
 * counter step survives the while-desugar. Returns `null` (diagnostic pushed) on failure.
 */
function lowerForSideEffect(expr: ts.Expression, ctx: PortableExprCtx): IRStatement[] | null {
    // `i++` / `i--` / `++i` / `--i` → `i = i ± 1`
    if (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) {
        const op = expr.operator;
        if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
            if (!requireAssign(ctx, expr)) return null;
            const target = lowerExpr(expr.operand, ctx);
            if (target === null) return null;
            const binOp = op === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
            return [{ kind: "assign", target, value: { kind: "binary", op: binOp, left: target, right: { kind: "literal", value: 1 } } }];
        }
    }

    if (ts.isBinaryExpression(expr)) {
        const opKind = expr.operatorToken.kind;
        if (opKind === ts.SyntaxKind.EqualsToken) {
            if (!requireAssign(ctx, expr)) return null;
            const target = lowerExpr(expr.left, ctx);
            if (target === null) return null;
            const value = lowerExpr(expr.right, ctx);
            if (value === null) return null;
            return [{ kind: "assign", target, value }];
        }
        const compound = COMPOUND_OP_MAP.get(opKind);
        if (compound !== undefined) {
            if (!requireAssign(ctx, expr)) return null;
            const target = lowerExpr(expr.left, ctx);
            if (target === null) return null;
            const rhs = lowerExpr(expr.right, ctx);
            if (rhs === null) return null;
            return [{ kind: "assign", target, value: { kind: "binary", op: compound, left: target, right: rhs } }];
        }
    }

    // Fallback: any other side-effecting expression (e.g. a function call).
    const e = lowerExpr(expr, ctx);
    if (e === null) return null;
    return [{ kind: "expression", expr: e }];
}

/**
 * True if `node` contains a `continue` that targets the enclosing loop — i.e. one not
 * inside a nested loop or function (whose `continue` belongs to that inner construct).
 * A `continue` inside a `switch`/`if`/`block` within the loop still counts.
 */
function statementContainsContinue(node: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
        if (found) return;
        if (ts.isContinueStatement(n)) { found = true; return; }
        if (
            ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) ||
            ts.isWhileStatement(n) || ts.isDoStatement(n) ||
            ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
        ) {
            return; // a nested loop/function owns its own `continue`
        }
        ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    return found;
}

/**
 * Lower a statement list, threading lexical scope: each `const` binding becomes
 * visible to the statements that follow it (so in field mode a later bare reference
 * resolves to that local, not a class field).
 *
 * A statement that fails to lower pushes an `error` diagnostic and is skipped here, but
 * out-of-vocabulary in a body is a **hard error with no partial emission** (decision 10):
 * every body-lowering entry point (method, function, getter, arrow, validator/formatter
 * inner) compares `diagnostics.length` before and after and discards the *whole* body when
 * any statement failed, so a partial statement list never reaches `validateIR` or a backend.
 */
export function lowerStatements(stmts: readonly ts.Statement[], ctx: PortableExprCtx): IRStatement[] {
    const out: IRStatement[] = [];
    let locals = ctx.locals;
    for (const s of stmts) {
        const stmtCtx: PortableExprCtx = locals === undefined ? ctx : { ...ctx, locals };
        const before = out.length;
        lowerStatementInto(out, s, stmtCtx);
        // Newly-appended `const` bindings (incl. a C-style-`for` desugar's init) are
        // visible to subsequent statements — matters in field mode (local shadows a field).
        for (let i = before; i < out.length; i++) {
            const appended = out[i];
            if (appended !== undefined && appended.kind === "const") {
                locals = new Set([...(locals ?? []), appended.name]);
            }
        }
    }
    return out;
}

export function lowerBlock(node: ts.Statement, ctx: PortableExprCtx): IRStatement[] {
    if (ts.isBlock(node)) return lowerStatements(node.statements, ctx);
    const out: IRStatement[] = [];
    lowerStatementInto(out, node, ctx);
    return out;
}

// ─── Expression lowering ──────────────────────────────────────────────────────

export function lowerExpr(node: ts.Expression, ctx: PortableExprCtx): IRExpression | null {
    if (ts.isParenthesizedExpression(node)) return lowerExpr(node.expression, ctx);

    if (ts.isStringLiteral(node)) return { kind: "literal", value: node.text };
    if (ts.isNumericLiteral(node)) return { kind: "literal", value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "literal", value: null };
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) return { kind: "identifier", name: "undefined" };

    // Bare identifier: a class field (getter mode) or a param/local (body mode).
    // In field mode, a name shadowed by a local binding (getter `const`, arrow param)
    // resolves to that local, not a class field.
    if (ts.isIdentifier(node)) {
        if (isFieldMode(ctx) && ctx.locals?.has(node.text) !== true) {
            return { kind: "field", name: node.text };
        }
        return { kind: "identifier", name: node.text };
    }

    if (ts.isTypeOfExpression(node)) {
        const operand = lowerExpr(node.expression, ctx);
        if (operand === null) return null;
        return { kind: "typeof", operand };
    }

    // `await operand` — only meaningful inside an async function/method body (the
    // declaration's `async` flag is set separately by lower-method/lower-function).
    if (ts.isAwaitExpression(node)) {
        const operand = lowerExpr(node.expression, ctx);
        if (operand === null) return null;
        return { kind: "await", operand };
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
        ctx.diagnostics.push(mkError(unsupp(ctx), `Malformed regular expression literal: ${node.text}`, getLocation(node, ctx.sourceFile)));
        return null;
    }

    if (ts.isArrowFunction(node)) {
        return lowerArrow(node, ctx);
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
        unsupp(ctx),
        `Unsupported expression kind: ${ts.SyntaxKind[node.kind]}`,
        getLocation(node, ctx.sourceFile),
    ));
    return null;
}

/**
 * Lower an arrow function. Params shadow outer scope inside the body (field mode: they are
 * locals, not class fields). A concise expression body lowers to `body`; a block body lowers
 * to `statements`, except a block whose single statement is `return e` normalizes down to
 * `body: e` (preserving the inline fast path — e.g. a `filter` predicate stays a comprehension
 * in Python, not a hoisted def). The return type is inferred best-effort.
 */
function lowerArrow(node: ts.ArrowFunction, ctx: PortableExprCtx): IRExpression | null {
    const params = node.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : "_"));
    const childCtx: PortableExprCtx = { ...ctx, locals: new Set([...(ctx.locals ?? []), ...params]) };
    const returnType = inferArrowReturnType(node, ctx);
    const rt = returnType !== undefined ? { returnType } : {};

    if (ts.isBlock(node.body)) {
        const before = ctx.diagnostics.length;
        const statements = lowerStatements(node.body.statements, childCtx);
        if (ctx.diagnostics.length > before) return null; // a statement failed to lower
        // Normalize `{ return e; }` to a concise body so backends keep the inline path.
        const only = statements.length === 1 ? statements[0] : undefined;
        if (only !== undefined && only.kind === "return" && only.value !== null) {
            return { kind: "arrow", params, body: only.value, ...rt };
        }
        return { kind: "arrow", params, statements, ...rt };
    }

    const body = lowerExpr(node.body, childCtx);
    if (body === null) return null;
    return { kind: "arrow", params, body, ...rt };
}

/** Infer an arrow's return type (best-effort; `undefined` when not determinable). */
function inferArrowReturnType(node: ts.ArrowFunction, ctx: PortableExprCtx): IRType | undefined {
    const t = ts.isBlock(node.body)
        ? ctx.checker.getSignatureFromDeclaration(node)?.getReturnType()
        : ctx.checker.getTypeAtLocation(node.body);
    return t !== undefined ? inferIRTypeFromType(t, ctx.checker) : undefined;
}

// ─── Intrinsic recognition ────────────────────────────────────────────────────

/** Classify a receiver's static type for intrinsic lookup. */
function classifyReceiver(checker: ts.TypeChecker, t: ts.Type): "string" | "array" | "regexp" | "date" | undefined {
    if ((t.flags & ts.TypeFlags.StringLike) !== 0) return "string";
    if (t.isUnion() && t.types.length > 0 && t.types.every((x) => (x.flags & ts.TypeFlags.StringLike) !== 0)) {
        return "string";
    }
    const sym = t.getSymbol();
    const name = sym?.getName();
    if (name === "Array" || name === "ReadonlyArray") return "array";
    if (name === "RegExp") return "regexp";
    // `DateTime` is a plain alias of `Date`, so a Date instance (or `new Date()`) resolves here.
    if (name === "Date") return "date";
    return undefined;
}

/** Lower `a.b` — recognizing property intrinsics like `.length` on a string/array. */
function lowerPropertyAccess(node: ts.PropertyAccessExpression, ctx: PortableExprCtx): IRExpression | null {
    // `this.fieldName` → field reference (getter mode).
    if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        return { kind: "field", name: node.name.text };
    }

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
function lowerCall(node: ts.CallExpression, ctx: PortableExprCtx): IRExpression | null {
    // Static `Date.now()` → a synthesized free-standing intrinsic. The receiver is the `Date`
    // constructor (type `DateConstructor`), not a Date instance, so classifyReceiver below would
    // not catch it — handle it first.
    if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "now" &&
        node.arguments.length === 0 &&
        ctx.checker.getTypeAtLocation(node.expression.expression).getSymbol()?.getName() === "DateConstructor" &&
        intrinsicByOp("date.now") !== undefined
    ) {
        return { kind: "intrinsic", op: "date.now", receiver: null, args: [] };
    }

    // Free-standing `Math.<fn>(...)` → numeric intrinsic. The receiver is the global `Math`
    // object (not a string/array/date), so it would otherwise fall through; recognize it
    // before the receiver-method branch and the field-mode rejection so getters work too.
    {
        const mathIntr = tryLowerMathCall(node, ctx);
        if (mathIntr !== undefined) return mathIntr;
    }

    // Free-standing `String(x)` / `Number(x)` coercion → intrinsic. Recognized before the
    // classifyFunction branch below, which would otherwise reject these ambient globals as
    // non-local function calls.
    {
        const coerce = tryLowerCoercion(node, ctx);
        if (coerce !== undefined) return coerce;
    }

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

    // Getter mode: only string/array/regexp/date intrinsics are portable. A generic call
    // (e.g. `this.helper()`, `compute()`) has no portable lowering — reject it.
    if (isFieldMode(ctx)) {
        ctx.diagnostics.push(mkError(
            unsupp(ctx),
            "Only string/array/regexp/date intrinsic methods may be called in a computed getter — arbitrary function/method calls are not portable",
            getLocation(node, ctx.sourceFile),
        ));
        return null;
    }

    const callee = lowerExpr(node.expression, ctx);
    if (callee === null) return null;
    const args = lowerArgs(node.arguments, ctx);
    if (args === null) return null;
    return { kind: "call", callee, args };
}

function lowerArgs(argNodes: ts.NodeArray<ts.Expression>, ctx: PortableExprCtx): IRExpression[] | null {
    const args: IRExpression[] = [];
    for (const arg of argNodes) {
        const a = lowerExpr(arg, ctx);
        if (a === null) return null;
        args.push(a);
    }
    return args;
}

/** Math member names with a registered `math.<name>` intrinsic. */
const MATH_FNS = new Set(["floor", "ceil", "round", "trunc", "abs", "sign", "sqrt", "pow", "min", "max"]);

/**
 * Recognize a free-standing `Math.<fn>(...)` call. Returns the lowered intrinsic on
 * success, `null` if it is a `Math.*` call that failed (diagnostic pushed), or
 * `undefined` if the call is not a `Math.*` call at all (caller keeps lowering).
 */
function tryLowerMathCall(node: ts.CallExpression, ctx: PortableExprCtx): IRExpression | null | undefined {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
    if (callee.expression.text !== "Math") return undefined;
    // Confirm it is the global `Math` object, not a user binding that shadows the name.
    if (ctx.checker.getTypeAtLocation(callee.expression).getSymbol()?.getName() !== "Math") return undefined;

    const name = callee.name.text;
    const intr = MATH_FNS.has(name) ? intrinsicByOp(`math.${name}`) : undefined;
    if (intr === undefined) {
        ctx.diagnostics.push(mkError(
            KEYMA085,
            `"Math.${name}" is not a supported numeric intrinsic — see packages/ir/intrinsics.md`,
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
    const args = lowerArgs(node.arguments, ctx);
    if (args === null) return null;
    return { kind: "intrinsic", op: intr.op, receiver: null, args };
}

/** Bare-identifier coercion callees → intrinsic op id. */
const COERCION_OPS = new Map<string, string>([["String", "to-string"], ["Number", "to-number"]]);

/**
 * Recognize a free-standing `String(x)` / `Number(x)` coercion call. Returns the lowered
 * intrinsic on success, `null` on a recognized-but-malformed call, or `undefined` when the
 * callee is not one of these globals (caller keeps lowering).
 */
function tryLowerCoercion(node: ts.CallExpression, ctx: PortableExprCtx): IRExpression | null | undefined {
    if (!ts.isIdentifier(node.expression)) return undefined;
    const op = COERCION_OPS.get(node.expression.text);
    if (op === undefined) return undefined;
    if (node.arguments.length !== 1) {
        ctx.diagnostics.push(mkError(
            KEYMA085,
            `${node.expression.text}() expects exactly 1 argument`,
            getLocation(node, ctx.sourceFile),
        ));
        return null;
    }
    const args = lowerArgs(node.arguments, ctx);
    if (args === null) return null;
    return { kind: "intrinsic", op, receiver: null, args };
}

// ─── Templates / operators / literals ─────────────────────────────────────────

function lowerTemplate(node: ts.TemplateExpression, ctx: PortableExprCtx): IRExpression | null {
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

function lowerBinary(node: ts.BinaryExpression, ctx: PortableExprCtx): IRExpression | null {
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
        ctx.diagnostics.push(mkError(unsupp(ctx), `Binary operator ${ts.SyntaxKind[opKind]} is not supported`, getLocation(node, ctx.sourceFile)));
        return null;
    }
    const left = lowerExpr(node.left, ctx);
    if (left === null) return null;
    const right = lowerExpr(node.right, ctx);
    if (right === null) return null;
    return { kind: "binary", op, left, right };
}

/** Recognize `typeof X === "literal"` (and negated). Returns undefined if not that shape. */
function tryLowerTypeIs(node: ts.BinaryExpression, ctx: PortableExprCtx): IRExpression | null | undefined {
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

function lowerInstanceOf(node: ts.BinaryExpression, ctx: PortableExprCtx): IRExpression | null {
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

function lowerUnary(node: ts.PrefixUnaryExpression, ctx: PortableExprCtx): IRExpression | null {
    const opMap = new Map<ts.SyntaxKind, "!" | "-" | "+">([
        [ts.SyntaxKind.ExclamationToken, "!"],
        [ts.SyntaxKind.MinusToken, "-"],
        [ts.SyntaxKind.PlusToken, "+"],
    ]);
    const op = opMap.get(node.operator);
    if (op === undefined) {
        ctx.diagnostics.push(mkError(unsupp(ctx), `Unary operator ${ts.SyntaxKind[node.operator]} is not supported`, getLocation(node, ctx.sourceFile)));
        return null;
    }
    const operand = lowerExpr(node.operand, ctx);
    if (operand === null) return null;
    return { kind: "unary", op, operand };
}

function lowerObjectLiteral(node: ts.ObjectLiteralExpression, ctx: PortableExprCtx): IRExpression | null {
    const properties: Array<{ key: string; value: IRExpression }> = [];
    for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) {
            ctx.diagnostics.push(mkError(unsupp(ctx), "Object literal properties must be simple assignments in portable bodies", getLocation(prop, ctx.sourceFile)));
            return null;
        }
        const key = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name)
                ? prop.name.text
                : undefined;
        if (key === undefined) {
            ctx.diagnostics.push(mkError(unsupp(ctx), "Object literal property key must be an identifier or string", getLocation(prop.name, ctx.sourceFile)));
            return null;
        }
        const val = lowerExpr(prop.initializer, ctx);
        if (val === null) return null;
        properties.push({ key, value: val });
    }
    return { kind: "object", properties };
}
