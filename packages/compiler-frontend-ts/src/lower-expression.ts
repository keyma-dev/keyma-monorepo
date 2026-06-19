import ts from "typescript";
import type { IRExpression, IRDiagnostic } from "@keyma/ir";
import { mkError, KEYMA014 } from "./diagnostics.js";
import { getLocation } from "./util.js";
import { lowerExpr, type PortableExprCtx } from "./lower-portable-expr.js";

/** Dependencies the getter lowerer threads into the shared portable engine. */
export type GetterLowerDeps = {
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
};

/**
 * Lower a computed getter body to an IRExpression. A getter must be a single
 * `return <expr>`; the expression is lowered through the shared portable engine in
 * field-reference mode, so `this.x`/bare names resolve to schema fields and the
 * full portable subset (intrinsics, `typeof`, conditionals, `new`, templates) is
 * available. Pushes diagnostics (all `KEYMA014`) and returns null on failure.
 */
export function lowerGetterBody(
    getter: ts.GetAccessorDeclaration,
    deps: GetterLowerDeps,
): IRExpression | null {
    const body = getter.body;
    if (!body) {
        deps.diagnostics.push(mkError(KEYMA014, "Computed getter must have a body", getLocation(getter, deps.sourceFile)));
        return null;
    }

    const stmts = body.statements;
    if (stmts.length !== 1) {
        deps.diagnostics.push(mkError(KEYMA014, "Computed getter body must contain a single return statement", getLocation(body, deps.sourceFile)));
        return null;
    }

    const stmt = stmts[0];
    if (!stmt || !ts.isReturnStatement(stmt) || !stmt.expression) {
        deps.diagnostics.push(mkError(KEYMA014, "Computed getter body must contain a single return statement", getLocation(body, deps.sourceFile)));
        return null;
    }

    const ctx: PortableExprCtx = {
        diagnostics: deps.diagnostics,
        sourceFile: deps.sourceFile,
        checker: deps.checker,
        dslModuleName: deps.dslModuleName,
        schemaClassNames: deps.schemaClassNames,
        refMode: "fields",
        unsupportedCode: KEYMA014,
    };

    return lowerExpr(stmt.expression, ctx);
}
