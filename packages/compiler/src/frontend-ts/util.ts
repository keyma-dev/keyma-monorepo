import ts from "typescript";
import type { IRSourceLocation } from "@keyma/core/ir";

export function getLocation(node: ts.Node, sf: ts.SourceFile): IRSourceLocation {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: sf.fileName, line: line + 1, column: character };
}

/** Follow import/alias chains to get the original declaration's symbol. */
export function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
    if (symbol.flags & ts.SymbolFlags.Alias) {
        return checker.getAliasedSymbol(symbol);
    }
    return symbol;
}

/**
 * Returns the module specifier string if the symbol was introduced via a named
 * import (`import { X } from "module"`). Returns undefined for locally-declared symbols.
 */
export function getImportModuleSpecifier(symbol: ts.Symbol): string | undefined {
    const decls = symbol.getDeclarations();
    if (!decls) return undefined;
    for (const decl of decls) {
        if (ts.isImportSpecifier(decl) || ts.isImportClause(decl)) {
            const importDecl = ts.isImportSpecifier(decl)
                ? decl.parent.parent.parent
                : decl.parent;
            if (
                ts.isImportDeclaration(importDecl) &&
                ts.isStringLiteral(importDecl.moduleSpecifier)
            ) {
                return importDecl.moduleSpecifier.text;
            }
        }
    }
    return undefined;
}

/**
 * Returns true if `symbol` was imported from `moduleName` (e.g. "@keyma/core/dsl").
 * Checks the import declaration's module specifier directly, so it's path-agnostic.
 */
export function isFromModule(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
    moduleName: string
): boolean {
    const fromModule = getImportModuleSpecifier(symbol);
    if (fromModule !== undefined) return fromModule === moduleName;

    // Fallback: check the resolved declaration's source file path.
    const resolved = resolveAlias(symbol, checker);
    const decls = resolved.getDeclarations() ?? [];
    return decls.some((d) => {
        const file = d.getSourceFile().fileName.replace(/\\/g, "/");
        return (
            file.includes(`/${moduleName.replace("@", "").replace("/", "/")}/`) ||
            file.includes("/packages/dsl/")
        );
    });
}

// Matches a `@keyma/core/dsl` module file in BOTH layouts: the installed package
// (`@keyma/core/dist/src/dsl/…`) and the in-repo source (`packages/core/src/dsl/…`).
const CORE_DSL_FILE = /(?:@keyma\/core|packages\/core)\/(?:dist\/)?(?:src\/)?dsl\//;

/**
 * Returns true if `symbol` resolves — through any import/re-export alias chain — to a
 * declaration in `@keyma/core/dsl`. Unlike {@link isFromModule}, which matches the *literal*
 * import specifier, this follows the alias to the ORIGINAL declaration and matches by package,
 * so a symbol imported through the `@keyma/schema/dsl` re-export (`export * from
 * "@keyma/core/dsl"`) still matches its core identity. Use it to recognize a core DSL symbol
 * (decorator or semantic type) regardless of which umbrella the author imported it through.
 */
export function isResolvedCoreDsl(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
    const resolved = resolveAlias(symbol, checker);
    const decls = resolved.getDeclarations() ?? [];
    return decls.some((d) => CORE_DSL_FILE.test(d.getSourceFile().fileName.replace(/\\/g, "/")));
}

/**
 * Returns true if `symbol` resolves (through any alias chain) to the export `name` of
 * `@keyma/core/dsl` — e.g. `Service`. Combines a resolved-name match with
 * {@link isResolvedCoreDsl}, so `@Service` is recognized whether it was imported from
 * `@keyma/core/dsl` directly or via the `@keyma/schema/dsl` re-export.
 */
export function isCoreDslSymbol(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
    name: string
): boolean {
    return resolveAlias(symbol, checker).getName() === name && isResolvedCoreDsl(symbol, checker);
}

/** Get the simple text name of an entity name node (identifier or qualified). */
export function entityNameText(name: ts.EntityName): string {
    return ts.isIdentifier(name) ? name.text : entityNameText(name.right);
}

/** Read a numeric literal node's value, or undefined if not a numeric literal. */
export function numericLiteralValue(node: ts.Expression): number | undefined {
    if (ts.isNumericLiteral(node)) return Number(node.text);
    // Handle negative numeric literals: PrefixUnaryExpression(-) + NumericLiteral
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)
    ) {
        return -Number(node.operand.text);
    }
    return undefined;
}

/** Read a string literal node's value, or undefined if not a string literal. */
export function stringLiteralValue(node: ts.Expression): string | undefined {
    return ts.isStringLiteral(node) ? node.text : undefined;
}

/** Read a boolean literal node's value, or undefined. */
export function booleanLiteralValue(node: ts.Expression): boolean | undefined {
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    return undefined;
}
