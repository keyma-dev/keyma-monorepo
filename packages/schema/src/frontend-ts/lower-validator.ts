import ts from "typescript";
import type {
    IRFunctionDeclaration,
    IRFunctionParam,
    IRArrowParam,
    IRStatement,
    IRType,
    IRDiagnostic,
} from "@keyma/core/ir";
import {
    lowerExpr,
    lowerStatement,
    mapTypeNode,
    getLocation,
    type BodyLowerCtx,
    type FnRefVerdict,
    type TypeMapContext,
} from "@keyma/compiler/frontend-ts";
import { mkError, KEYMA026, KEYMA081, KEYMA083 } from "./diagnostics.js";
import type { CollectedFactory } from "./discover-validators.js";

/** Dependencies threaded from the schema frontend for type-aware body lowering. */
export type LowerDeps = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
    classifyFunction?: (ident: ts.Identifier) => FnRefVerdict;
};

type LowerCtx = BodyLowerCtx;

// ─── Public entry points ─────────────────────────────────────────────────────
//
// A validator/formatter factory collapses to an ordinary `IRFunctionDeclaration`
// (in `KeymaIR.functionDeclarations`): its body returns a typed inner arrow. The
// three former special encodings dissolve into generic IR — the factory params
// become the function's typed params (with `optional?`); the inner arrow's first
// param carries the former `inputType`; the value/field/context roles become the
// inner arrow's positional params. The schema backend packs read these back to emit
// the runtime `ValidatorFn`/`FormatterFn` wrapper.

export function lowerValidatorFactory(
    collected: CollectedFactory,
    extraDiagnostics: IRDiagnostic[],
    deps: LowerDeps,
): IRFunctionDeclaration {
    const ctx = mkCtx(collected.sourceFile, extraDiagnostics, deps);
    return lowerFactory(collected, ctx);
}

export function lowerFormatterFactory(
    collected: CollectedFactory,
    extraDiagnostics: IRDiagnostic[],
    deps: LowerDeps,
): IRFunctionDeclaration {
    const ctx = mkCtx(collected.sourceFile, extraDiagnostics, deps);
    return lowerFactory(collected, ctx);
}

function mkCtx(sourceFile: ts.SourceFile, diagnostics: IRDiagnostic[], deps: LowerDeps): LowerCtx {
    return {
        diagnostics,
        sourceFile,
        checker: deps.checker,
        dslModuleName: deps.dslModuleName,
        classNames: deps.schemaClassNames,
        ...(deps.classifyFunction !== undefined ? { classifyFunction: deps.classifyFunction } : {}),
    };
}

function typeMapCtxOf(ctx: LowerCtx): TypeMapContext {
    return {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        classNames: ctx.classNames,
        bareClassInstance: true,
        diagnostics: ctx.diagnostics,
        sourceFile: ctx.sourceFile,
    };
}

// ─── Factory lowering ─────────────────────────────────────────────────────────

/** True when a callable node is declared `async` (works for all three callable node forms). */
function isAsyncCallable(node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): boolean {
    return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/** A self-contained no-op factory IR, used when the factory is rejected (a diagnostic was pushed
 *  and the build will halt) so the document stays well-formed. */
function noOpFactory(collected: CollectedFactory, params: IRFunctionParam[]): IRFunctionDeclaration {
    return {
        name: collected.name,
        params,
        returnType: { kind: "function", params: [], returns: { kind: "json" } },
        statements: [],
        source: collected.source,
    };
}

function lowerFactory(collected: CollectedFactory, ctx: LowerCtx): IRFunctionDeclaration {
    const func = collected.node;

    // Validators/formatters are synthesized into plain synchronous methods (decision 12) — an
    // `async` factory or inner function has no synchronous lowering. Reject at the frontend.
    if (isAsyncCallable(func)) {
        ctx.diagnostics.push(mkError(
            KEYMA026,
            "A validator/formatter factory may not be `async` — validators and formatters must be synchronous",
            getLocation(func, ctx.sourceFile),
        ));
        return noOpFactory(collected, []);
    }

    // Factory (outer) params become the function's typed params. A param is `optional`
    // (a call site may omit it) when it has a `?` or a default initializer — typed
    // backends emit a default. Param types are re-emitted as literal spec args, so a
    // best-effort map (json fallback) is enough.
    const params: IRFunctionParam[] = func.parameters.map((p) => {
        const name = ts.isIdentifier(p.name) ? p.name.text : "_";
        const optional = p.questionToken !== undefined || p.initializer !== undefined;
        return { name, type: mapFactoryParamType(p.type, ctx), ...(optional ? { optional: true } : {}) };
    });

    // The value type the field carries (and the backend's runtime guard) comes from the
    // factory's `ValidatorFn<T>`/`FormatterFn<T>` return annotation. Absent ⇒ neutral `json`.
    const inputType = mapInputType(collected.returnTypeArg, ctx);

    const inner = extractInnerFunction(func, ctx);
    if (inner === undefined) {
        // Malformed factory — emit a self-contained no-op so the IR stays well-formed.
        return noOpFactory(collected, params);
    }
    if (isAsyncCallable(inner)) {
        ctx.diagnostics.push(mkError(
            KEYMA026,
            "A validator/formatter inner function may not be `async` — validators and formatters must be synchronous",
            getLocation(inner, ctx.sourceFile),
        ));
        return noOpFactory(collected, params);
    }

    // Inner params by position: 0=value, 1=field, 2=context. The first carries the
    // input type; the rest stay name-only (the backend reads them positionally).
    const innerParamNames = inner.parameters.map((p, i) =>
        ts.isIdentifier(p.name) ? p.name.text : `_p${i}`,
    );
    const arrowParams: IRArrowParam[] = innerParamNames.map((name, i) =>
        i === 0 ? { name, type: inputType } : name,
    );

    const innerStatements = lowerInnerBody(inner, ctx);

    // The HOF return type — a `function` type whose first param is the input type. Field
    // (string) and context (json) types are best-effort; the backend reads the inner arrow.
    const returnParams: IRFunctionParam[] = innerParamNames.map((name, i) => ({
        name,
        type: i === 0 ? inputType : i === 1 ? { kind: "string" } : { kind: "json" },
    }));

    return {
        name: collected.name,
        params,
        returnType: { kind: "function", params: returnParams, returns: { kind: "json" } },
        statements: [
            { kind: "return", value: { kind: "arrow", params: arrowParams, statements: innerStatements } },
        ],
        source: collected.source,
    };
}

/**
 * Find the inner function the factory returns — a concise `(params) => innerFn` or a
 * single `return innerFn` — and verify it is an arrow/function expression with 1–3 params.
 * Returns the inner callable, or `undefined` (with a diagnostic) when malformed.
 */
function extractInnerFunction(
    func: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
    ctx: LowerCtx,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
    let innerFn: ts.Expression;
    if (ts.isArrowFunction(func) && !ts.isBlock(func.body)) {
        innerFn = func.body;
    } else {
        const body = func.body as ts.Block | undefined;
        const stmt = body?.statements[0];
        if (body === undefined || body.statements.length !== 1 || stmt === undefined
            || !ts.isReturnStatement(stmt) || stmt.expression === undefined) {
            ctx.diagnostics.push(mkError(
                KEYMA081,
                "Validator/formatter factory body must contain a single return statement returning an inner function",
                getLocation(body ?? func, ctx.sourceFile),
            ));
            return undefined;
        }
        innerFn = stmt.expression;
    }

    if (!ts.isArrowFunction(innerFn) && !ts.isFunctionExpression(innerFn)) {
        ctx.diagnostics.push(mkError(
            KEYMA081,
            "Factory must return an arrow function or function expression",
            getLocation(innerFn, ctx.sourceFile),
        ));
        return undefined;
    }
    if (innerFn.parameters.length < 1 || innerFn.parameters.length > 3) {
        ctx.diagnostics.push(mkError(
            KEYMA083,
            `Inner function must have 1–3 parameters (value[, fieldKey[, context]]), got ${innerFn.parameters.length}`,
            getLocation(innerFn, ctx.sourceFile),
        ));
        return undefined;
    }
    return innerFn;
}

/**
 * Lower the inner function's body to portable statements (concise arrow → a single return).
 * Out-of-vocabulary in a validator/formatter body is a hard error with no partial emission
 * (decision 10): if any statement fails to lower (pushing a diagnostic), discard the whole body
 * rather than emitting a partial one — the diagnostic halts the build.
 */
function lowerInnerBody(inner: ts.ArrowFunction | ts.FunctionExpression, ctx: LowerCtx): IRStatement[] {
    const before = ctx.diagnostics.length;
    const statements: IRStatement[] = [];
    if (ts.isArrowFunction(inner) && !ts.isBlock(inner.body)) {
        const expr = lowerExpr(inner.body, ctx);
        if (expr !== null) statements.push({ kind: "return", value: expr });
        return ctx.diagnostics.length > before ? [] : statements;
    }
    const block = inner.body as ts.Block;
    for (const s of block.statements) {
        const irStmt = lowerStatement(s, ctx);
        if (irStmt !== null) statements.push(irStmt);
    }
    return ctx.diagnostics.length > before ? [] : statements;
}

/**
 * Map the input type from a `ValidatorFn<T>`/`FormatterFn<T>` return annotation's `<T>`
 * argument. The backend emits a runtime guard from it. An absent or `unknown`/`any`
 * argument yields a neutral `json` input (no guard).
 */
function mapInputType(typeArg: ts.TypeNode | undefined, ctx: LowerCtx): IRType {
    if (typeArg === undefined
        || typeArg.kind === ts.SyntaxKind.UnknownKeyword
        || typeArg.kind === ts.SyntaxKind.AnyKeyword) {
        return { kind: "json" };
    }
    const result = mapTypeNode(typeArg, typeMapCtxOf(ctx));
    if ("diag" in result) {
        ctx.diagnostics.push(result.diag);
        return { kind: "json" };
    }
    return result.type;
}

/** Best-effort map of a factory param's declared type; `json` fallback (spec args are
 *  re-emitted as literals, so a precise type is not required and a map failure is silent). */
function mapFactoryParamType(typeNode: ts.TypeNode | undefined, ctx: LowerCtx): IRType {
    if (typeNode === undefined) return { kind: "json" };
    const result = mapTypeNode(typeNode, typeMapCtxOf(ctx));
    return "diag" in result ? { kind: "json" } : result.type;
}
