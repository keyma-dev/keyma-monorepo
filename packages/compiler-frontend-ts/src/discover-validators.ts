import ts from "typescript";
import { isFromModule, getLocation } from "./util.js";
import type { IRDiagnostic, IRSourceLocation } from "@keyma/ir";
import { mkError, KEYMA080 } from "./diagnostics.js";

export type DiscoveredValidator = {
    funcNode: ts.ArrowFunction | ts.FunctionExpression;
    funcName: string;
    sourceFile: ts.SourceFile;
    /** The name string from Validator("name", fn). */
    validatorName: string;
    source: IRSourceLocation;
};

export type DiscoveredFormatter = {
    funcNode: ts.ArrowFunction | ts.FunctionExpression;
    funcName: string;
    sourceFile: ts.SourceFile;
    /** The name string from Formatter("name", fn). */
    formatterName: string;
    source: IRSourceLocation;
};

type DiscoverContext = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    diagnostics: IRDiagnostic[];
};

/** Walk all non-declaration source files for exported `const x = Validator("name", fn)` declarations. */
export function discoverValidators(
    program: ts.Program,
    ctx: DiscoverContext
): DiscoveredValidator[] {
    const results: DiscoveredValidator[] = [];
    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        ts.forEachChild(sourceFile, (node) => {
            if (!ts.isVariableStatement(node)) return;
            const found = tryDiscoverCall(node, sourceFile, ctx, "Validator");
            if (found !== null) {
                results.push({
                    funcNode: found.funcNode,
                    funcName: found.funcName,
                    sourceFile,
                    validatorName: found.registeredName,
                    source: found.source,
                });
            }
        });
    }
    return results;
}

/** Walk all non-declaration source files for exported `const x = Formatter("name", fn)` declarations. */
export function discoverFormatters(
    program: ts.Program,
    ctx: DiscoverContext
): DiscoveredFormatter[] {
    const results: DiscoveredFormatter[] = [];
    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        ts.forEachChild(sourceFile, (node) => {
            if (!ts.isVariableStatement(node)) return;
            const found = tryDiscoverCall(node, sourceFile, ctx, "Formatter");
            if (found !== null) {
                results.push({
                    funcNode: found.funcNode,
                    funcName: found.funcName,
                    sourceFile,
                    formatterName: found.registeredName,
                    source: found.source,
                });
            }
        });
    }
    return results;
}

type DiscoveredCall = {
    funcName: string;
    funcNode: ts.ArrowFunction | ts.FunctionExpression;
    registeredName: string;
    source: IRSourceLocation;
};

/**
 * Matches: export const <ident> = Validator("name", fn) | Formatter("name", fn)
 * where the callee resolves to the DSL module.
 */
function tryDiscoverCall(
    node: ts.VariableStatement,
    sourceFile: ts.SourceFile,
    ctx: DiscoverContext,
    which: "Validator" | "Formatter",
): DiscoveredCall | null {
    const decls = node.declarationList.declarations;
    if (decls.length !== 1) return null;
    const decl = decls[0];
    if (!decl || !ts.isIdentifier(decl.name)) return null;
    if (!decl.initializer || !ts.isCallExpression(decl.initializer)) return null;

    const call = decl.initializer;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== which) return null;

    const symbol = ctx.checker.getSymbolAtLocation(call.expression);
    if (!symbol || !isFromModule(symbol, ctx.checker, ctx.dslModuleName)) return null;

    const funcName = decl.name.text;
    const source = getLocation(decl.name, sourceFile);

    // Must be exported.
    const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!isExported) {
        ctx.diagnostics.push(
            mkError(
                KEYMA080,
                `${which}() must be assigned to an exported const ("${funcName}" is not exported)`,
                source,
            ),
        );
        return null;
    }

    // Arg 0: string literal name.
    const nameArg = call.arguments[0];
    if (!nameArg || !ts.isStringLiteral(nameArg)) {
        ctx.diagnostics.push(
            mkError(
                KEYMA080,
                `${which}() first argument must be a string literal name`,
                getLocation(call, sourceFile),
            ),
        );
        return null;
    }
    const registeredName = nameArg.text;

    // Arg 1: arrow function or function expression.
    const factoryArg = call.arguments[1];
    if (!factoryArg || (!ts.isArrowFunction(factoryArg) && !ts.isFunctionExpression(factoryArg))) {
        ctx.diagnostics.push(
            mkError(
                KEYMA080,
                `${which}() second argument must be an arrow function or function expression`,
                getLocation(call, sourceFile),
            ),
        );
        return null;
    }

    return { funcName, funcNode: factoryArg, registeredName, source };
}
