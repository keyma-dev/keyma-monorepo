import ts from "typescript";
import type { IRStatement, IRDiagnostic } from "@keyma/core/ir";
import { mkError, KEYMA014 } from "./diagnostics.js";
import { getLocation } from "./util.js";
import { lowerStatements, type PortableExprCtx } from "./lower-portable-expr.js";

/** Dependencies the getter lowerer threads into the shared portable engine. */
export type GetterLowerDeps = {
    diagnostics: IRDiagnostic[];
    sourceFile: ts.SourceFile;
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
};

/** Whether a portable statement list reaches a `return` (recursing into `if` branches). */
function containsReturn(stmts: readonly IRStatement[]): boolean {
    return stmts.some((s) => {
        if (s.kind === "return") return true;
        if (s.kind === "if") {
            return containsReturn(s.consequent) || (s.alternate !== undefined && containsReturn(s.alternate));
        }
        return false;
    });
}

/**
 * Lower a computed getter body to a portable `IRStatement[]`. The body may contain
 * the full portable statement subset (`const`/`if`/`return`, no assignment — a getter
 * reads, it does not mutate); statements are lowered through the shared portable engine
 * in field-reference mode, so `this.x`/bare names resolve to schema fields while local
 * `const`s and arrow params resolve as locals. Pushes diagnostics (all `KEYMA014`) and
 * returns null on failure (no body, no reachable `return`, or any unlowerable statement).
 */
export function lowerGetterBody(
    getter: ts.GetAccessorDeclaration,
    deps: GetterLowerDeps,
): IRStatement[] | null {
    const body = getter.body;
    if (!body) {
        deps.diagnostics.push(mkError(KEYMA014, "Computed getter must have a body", getLocation(getter, deps.sourceFile)));
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

    const before = deps.diagnostics.length;
    const statements = lowerStatements(body.statements, ctx);
    // A dropped statement pushed a diagnostic — don't emit a partial getter.
    if (deps.diagnostics.length > before) return null;

    if (!containsReturn(statements)) {
        deps.diagnostics.push(mkError(KEYMA014, "Computed getter requires a `return` statement", getLocation(body, deps.sourceFile)));
        return null;
    }

    return statements;
}
