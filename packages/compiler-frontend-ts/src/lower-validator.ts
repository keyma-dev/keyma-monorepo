import ts from "typescript";
import type {
    IRValidatorDeclaration,
    IRFormatterDeclaration,
    IRFunctionBody,
    IRParam,
    IRStatement,
    IRType,
    IRDiagnostic,
} from "@keyma/ir";
import { mkError, KEYMA081, KEYMA083, KEYMA084 } from "./diagnostics.js";
import { getLocation } from "./util.js";
import { mapTypeNode, type TypeMapContext } from "./map-type.js";
import { lowerExpr, lowerStatement, type BodyLowerCtx, type FnRefVerdict } from "./lower-body.js";
import type { DiscoveredValidator, DiscoveredFormatter } from "./discover-validators.js";

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
    discovered: DiscoveredValidator,
    extraDiagnostics: IRDiagnostic[],
    deps: LowerDeps,
): IRValidatorDeclaration {
    const ctx = mkCtx(discovered.sourceFile, extraDiagnostics, deps);
    const { factoryParams, inputType, body } = lowerFactory(discovered.funcNode, ctx);
    return { name: discovered.validatorName, factoryParams, inputType, body, source: discovered.source };
}

export function lowerFormatterDeclaration(
    discovered: DiscoveredFormatter,
    extraDiagnostics: IRDiagnostic[],
    deps: LowerDeps,
): IRFormatterDeclaration {
    const ctx = mkCtx(discovered.sourceFile, extraDiagnostics, deps);
    const { factoryParams, inputType, body } = lowerFactory(discovered.funcNode, ctx);
    return { name: discovered.formatterName, factoryParams, inputType, body, source: discovered.source };
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
    factoryParams: { name: string }[];
    inputType: IRType;
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
            return { factoryParams, inputType: { kind: "json" }, body: emptyBody() };
        }

        const stmt = body.statements[0];
        if (!stmt || !ts.isReturnStatement(stmt) || !stmt.expression) {
            ctx.diagnostics.push(mkError(KEYMA081, "Factory body must be a single return statement", getLocation(body, ctx.sourceFile)));
            return { factoryParams, inputType: { kind: "json" }, body: emptyBody() };
        }

        innerFn = stmt.expression;
    }

    if (!ts.isArrowFunction(innerFn) && !ts.isFunctionExpression(innerFn)) {
        ctx.diagnostics.push(mkError(KEYMA081, "Factory must return an arrow function or function expression", getLocation(innerFn, ctx.sourceFile)));
        return { factoryParams, inputType: { kind: "json" }, body: emptyBody() };
    }

    // Inner params by position: 0=value, 1=field, 2=context
    const innerParams = innerFn.parameters;
    if (innerParams.length < 1 || innerParams.length > 3) {
        ctx.diagnostics.push(mkError(
            KEYMA083,
            `Inner function must have 1–3 parameters (value[, fieldKey[, context]]), got ${innerParams.length}`,
            getLocation(innerFn, ctx.sourceFile),
        ));
        return { factoryParams, inputType: { kind: "json" }, body: emptyBody() };
    }

    // The `value` parameter must carry an explicit, concrete type.
    const inputType = mapValueParamType(innerParams[0], innerFn, ctx);

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
 * Map the `value` parameter's declared type, rejecting an absent annotation or an
 * `unknown`/`any` annotation (KEYMA084). On error, returns a neutral `json` type so
 * the declaration still has a well-formed shape.
 */
function mapValueParamType(
    param: ts.ParameterDeclaration | undefined,
    innerFn: ts.Node,
    ctx: LowerCtx,
): IRType {
    if (param === undefined || param.type === undefined) {
        ctx.diagnostics.push(mkError(
            KEYMA084,
            "Validator/formatter input (value) parameter must declare an explicit type — `unknown`/`any`/untyped is not allowed",
            getLocation(param ?? innerFn, ctx.sourceFile),
        ));
        return { kind: "json" };
    }
    if (param.type.kind === ts.SyntaxKind.UnknownKeyword || param.type.kind === ts.SyntaxKind.AnyKeyword) {
        ctx.diagnostics.push(mkError(
            KEYMA084,
            "Validator/formatter input (value) parameter must declare a concrete type, not `unknown` or `any`",
            getLocation(param, ctx.sourceFile),
        ));
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
    const result = mapTypeNode(param.type, typeMapCtx);
    if ("diag" in result) {
        ctx.diagnostics.push(result.diag);
        return { kind: "json" };
    }
    return result.type;
}

function emptyBody(): IRFunctionBody {
    return { params: [], statements: [] };
}
