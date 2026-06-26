import ts from "typescript";
import type {
    IRValidatorDeclaration,
    IRFormatterDeclaration,
    IRFunctionBody,
    IRParam,
    IRStatement,
    IRType,
    IRDiagnostic,
} from "@keyma/core/ir";
import { mkError, KEYMA081, KEYMA083 } from "./diagnostics.js";
import { getLocation } from "./util.js";
import { mapTypeNode, type TypeMapContext } from "./map-type.js";
import { lowerExpr, lowerStatement, type BodyLowerCtx, type FnRefVerdict } from "./lower-body.js";
import type { CollectedFactory } from "./discover-validators.js";

/** Dependencies threaded from the compile driver for type-aware body lowering. */
export type LowerDeps = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
    classifyFunction?: (ident: ts.Identifier) => FnRefVerdict;
};

type LowerCtx = BodyLowerCtx;

// ─── Public entry points ─────────────────────────────────────────────────────

export function lowerValidatorDeclaration(
    collected: CollectedFactory,
    extraDiagnostics: IRDiagnostic[],
    deps: LowerDeps,
): IRValidatorDeclaration {
    const ctx = mkCtx(collected.sourceFile, extraDiagnostics, deps);
    const { factoryParams, inputType, body } = lowerFactory(collected.node, collected.returnTypeArg, ctx);
    return { name: collected.name, factoryParams, inputType, body, source: collected.source };
}

export function lowerFormatterDeclaration(
    collected: CollectedFactory,
    extraDiagnostics: IRDiagnostic[],
    deps: LowerDeps,
): IRFormatterDeclaration {
    const ctx = mkCtx(collected.sourceFile, extraDiagnostics, deps);
    const { factoryParams, inputType, body } = lowerFactory(collected.node, collected.returnTypeArg, ctx);
    return { name: collected.name, factoryParams, inputType, body, source: collected.source };
}

function mkCtx(sourceFile: ts.SourceFile, diagnostics: IRDiagnostic[], deps: LowerDeps): LowerCtx {
    return {
        diagnostics,
        sourceFile,
        checker: deps.checker,
        dslModuleName: deps.dslModuleName,
        schemaClassNames: deps.schemaClassNames,
        ...(deps.classifyFunction !== undefined ? { classifyFunction: deps.classifyFunction } : {}),
    };
}

// ─── Factory lowering ─────────────────────────────────────────────────────────

type LoweredFactory = {
    factoryParams: { name: string; optional?: boolean }[];
    inputType: IRType;
    body: IRFunctionBody;
};

function lowerFactory(
    func: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
    returnTypeArg: ts.TypeNode | undefined,
    ctx: LowerCtx,
): LoweredFactory {
    // A param is optional (a call site may omit it) when it has a `?` or a default
    // initializer. Typed backends emit a default for these; JS ignores it.
    const factoryParams: { name: string; optional?: boolean }[] = func.parameters.map((p) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : "_",
        ...(p.questionToken !== undefined || p.initializer !== undefined ? { optional: true } : {}),
    }));

    // The value type the field carries (and the backend's runtime guard) comes from
    // the factory's `ValidatorFn<T>`/`FormatterFn<T>` return annotation. An absent
    // type argument means "no guard" — a neutral `json` input.
    const inputType = mapInputType(returnTypeArg, ctx);

    let innerFn: ts.Expression;

    if (ts.isArrowFunction(func) && !ts.isBlock(func.body)) {
        // Concise arrow: (factoryParams) => innerFn
        innerFn = func.body;
    } else {
        const body = func.body as ts.Block | undefined;
        if (body === undefined || body.statements.length !== 1) {
            ctx.diagnostics.push(mkError(
                KEYMA081,
                "Validator/formatter factory body must contain a single return statement returning an inner function",
                getLocation(body ?? func, ctx.sourceFile),
            ));
            return { factoryParams, inputType, body: emptyBody() };
        }

        const stmt = body.statements[0];
        if (!stmt || !ts.isReturnStatement(stmt) || !stmt.expression) {
            ctx.diagnostics.push(mkError(KEYMA081, "Factory body must be a single return statement", getLocation(body, ctx.sourceFile)));
            return { factoryParams, inputType, body: emptyBody() };
        }

        innerFn = stmt.expression;
    }

    if (!ts.isArrowFunction(innerFn) && !ts.isFunctionExpression(innerFn)) {
        ctx.diagnostics.push(mkError(KEYMA081, "Factory must return an arrow function or function expression", getLocation(innerFn, ctx.sourceFile)));
        return { factoryParams, inputType, body: emptyBody() };
    }

    // Inner params by position: 0=value, 1=field, 2=context
    const innerParams = innerFn.parameters;
    if (innerParams.length < 1 || innerParams.length > 3) {
        ctx.diagnostics.push(mkError(
            KEYMA083,
            `Inner function must have 1–3 parameters (value[, fieldKey[, context]]), got ${innerParams.length}`,
            getLocation(innerFn, ctx.sourceFile),
        ));
        return { factoryParams, inputType, body: emptyBody() };
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

    return { factoryParams, inputType, body: { params: irParams, statements: irStatements } };
}

/**
 * Map the input type from a `ValidatorFn<T>`/`FormatterFn<T>` return annotation's
 * `<T>` argument. The backend emits a runtime guard from it. An absent or
 * `unknown`/`any` argument yields a neutral `json` input (no guard).
 */
function mapInputType(typeArg: ts.TypeNode | undefined, ctx: LowerCtx): IRType {
    if (
        typeArg === undefined ||
        typeArg.kind === ts.SyntaxKind.UnknownKeyword ||
        typeArg.kind === ts.SyntaxKind.AnyKeyword
    ) {
        return { kind: "json" };
    }
    const typeMapCtx: TypeMapContext = {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
        bareClassReference: true,
        diagnostics: ctx.diagnostics,
        sourceFile: ctx.sourceFile,
    };
    const result = mapTypeNode(typeArg, typeMapCtx);
    if ("diag" in result) {
        ctx.diagnostics.push(result.diag);
        return { kind: "json" };
    }
    return result.type;
}

function emptyBody(): IRFunctionBody {
    return { params: [], statements: [] };
}
