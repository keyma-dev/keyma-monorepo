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

    // Two forms:
    //   Validator("name", factory)  — explicit name
    //   Validator(factory)          — name inferred from the const binding
    const arg0 = call.arguments[0];
    let registeredName: string;
    let factoryArg: ts.Expression | undefined;
    if (arg0 !== undefined && ts.isStringLiteral(arg0)) {
        registeredName = arg0.text;
        factoryArg = call.arguments[1];
    } else if (arg0 !== undefined && (ts.isArrowFunction(arg0) || ts.isFunctionExpression(arg0))) {
        registeredName = funcName; // inferred from the exported const binding
        factoryArg = arg0;
    } else {
        ctx.diagnostics.push(
            mkError(
                KEYMA080,
                `${which}() takes (name, factory) or (factory) — the first argument must be a string-literal name or a factory function`,
                getLocation(call, sourceFile),
            ),
        );
        return null;
    }

    if (!factoryArg || (!ts.isArrowFunction(factoryArg) && !ts.isFunctionExpression(factoryArg))) {
        ctx.diagnostics.push(
            mkError(
                KEYMA080,
                `${which}() factory must be an arrow function or function expression`,
                getLocation(call, sourceFile),
            ),
        );
        return null;
    }

    return { funcName, funcNode: factoryArg, registeredName, source };
}
