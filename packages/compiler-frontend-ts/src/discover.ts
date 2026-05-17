import ts from "typescript";
import { isFromModule, getLocation } from "./util.js";
import type { IRDiagnostic, IRSourceLocation } from "@keyma/ir";
import { mkError, KEYMA032, KEYMA033, KEYMA063 } from "./diagnostics.js";

export type DiscoveredEdgeOptions = {
    /** Source class identifier text from @Edge({ from: <ident>, ... }). */
    fromClassName: string;
    /** Target class identifier text. */
    toClassName: string;
    label?: string;
    directed?: boolean;
    fromField?: string;
    toField?: string;
};

export type DiscoveredSchema = {
    classNode: ts.ClassDeclaration;
    className: string;
    sourceFile: ts.SourceFile;
    /** Options from @Schema({ name, private, description }). */
    schemaOptions: {
        name?: string;
        private?: boolean;
        description?: string;
    };
    /** Source name of the direct parent @Schema class, if any. */
    parentClassName?: string;
    /** Present iff the class was decorated with @Edge(...). Carries from/to/etc. */
    edgeOptions?: DiscoveredEdgeOptions;
    source: IRSourceLocation;
};

type DiscoverContext = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    diagnostics: IRDiagnostic[];
};

/** Walk all source files (excluding declaration files) and find @Schema-decorated classes. */
export function discoverSchemas(
    program: ts.Program,
    ctx: DiscoverContext
): DiscoveredSchema[] {
    const results: DiscoveredSchema[] = [];

    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        ts.forEachChild(sourceFile, (node) => {
            if (!ts.isClassDeclaration(node)) return;
            const discovered = tryDiscoverSchema(node, sourceFile, ctx);
            if (discovered) results.push(discovered);
        });
    }

    return results;
}

function tryDiscoverSchema(
    node: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    ctx: DiscoverContext
): DiscoveredSchema | null {
    if (!node.name) return null;
    // @Edge implies @Schema behavior — accept a class decorated with either.
    const schemaDecorator = findKeymaClassDecorator(node, ctx.checker, ctx.dslModuleName, "Schema");
    const edgeDecorator = findKeymaClassDecorator(node, ctx.checker, ctx.dslModuleName, "Edge");
    if (!schemaDecorator && !edgeDecorator) return null;

    const className = node.name.text;
    const schemaOptions = schemaDecorator
        ? extractSchemaOptions(schemaDecorator, ctx)
        : edgeDecorator
            ? extractSchemaOptions(edgeDecorator, ctx)  // @Edge shares the Schema options shape
            : {};
    const source = getLocation(node.name, sourceFile);

    // Check parent class
    let parentClassName: string | undefined;
    if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
            if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
            const parentRef = clause.types[0];
            if (!parentRef) continue;
            const parentExpr = parentRef.expression;
            if (!ts.isIdentifier(parentExpr)) continue;
            const parentName = parentExpr.text;

            // We'll validate the parent is a @Schema class in the flatten pass (after all schemas collected).
            parentClassName = parentName;
        }
    }

    const result: DiscoveredSchema = { classNode: node, className, sourceFile, schemaOptions, source };
    if (parentClassName !== undefined) result.parentClassName = parentClassName;
    if (edgeDecorator) {
        const edgeOptions = extractEdgeOptions(edgeDecorator, sourceFile, ctx);
        if (edgeOptions) result.edgeOptions = edgeOptions;
    }
    return result;
}

/** Find a named class-level decorator (e.g. "Schema" or "Edge") from the DSL module. */
function findKeymaClassDecorator(
    node: ts.ClassDeclaration,
    checker: ts.TypeChecker,
    dslModuleName: string,
    decoratorName: string
): ts.Decorator | undefined {
    const modifiers = ts.getDecorators(node) ?? node.modifiers;
    if (!modifiers) return undefined;

    for (const modifier of modifiers) {
        if (!ts.isDecorator(modifier)) continue;
        const expr = modifier.expression;
        const ident = ts.isCallExpression(expr) ? expr.expression : expr;
        if (!ts.isIdentifier(ident) || ident.text !== decoratorName) continue;

        const symbol = checker.getSymbolAtLocation(ident);
        if (!symbol) continue;
        if (isFromModule(symbol, checker, dslModuleName)) return modifier;
    }
    return undefined;
}

/** Extract @Schema decorator options from a call expression. */
function extractSchemaOptions(
    decorator: ts.Decorator,
    ctx: DiscoverContext
): DiscoveredSchema["schemaOptions"] {
    const expr = decorator.expression;
    if (!ts.isCallExpression(expr) || expr.arguments.length === 0) return {};

    const arg = expr.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return {};

    const opts: DiscoveredSchema["schemaOptions"] = {};
    for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const key = prop.name.text;
        const val = prop.initializer;

        if (key === "name" && ts.isStringLiteral(val)) {
            opts.name = val.text;
        } else if (key === "private") {
            if (val.kind === ts.SyntaxKind.TrueKeyword) opts.private = true;
            if (val.kind === ts.SyntaxKind.FalseKeyword) opts.private = false;
        } else if (key === "description" && ts.isStringLiteral(val)) {
            opts.description = val.text;
        }
    }
    return opts;
}

/** Extract @Edge decorator options. Reports KEYMA063 if `from`/`to` aren't class identifiers. */
function extractEdgeOptions(
    decorator: ts.Decorator,
    sourceFile: ts.SourceFile,
    ctx: DiscoverContext
): DiscoveredEdgeOptions | undefined {
    const expr = decorator.expression;
    if (!ts.isCallExpression(expr) || expr.arguments.length === 0) return undefined;
    const arg = expr.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;

    let fromClassName: string | undefined;
    let toClassName: string | undefined;
    let label: string | undefined;
    let directed: boolean | undefined;
    let fromField: string | undefined;
    let toField: string | undefined;

    for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const key = prop.name.text;
        const val = prop.initializer;

        if (key === "from" || key === "to") {
            if (!ts.isIdentifier(val)) {
                ctx.diagnostics.push(
                    mkError(
                        KEYMA063,
                        `@Edge "${key}" must be a class identifier`,
                        getLocation(val, sourceFile),
                    ),
                );
                continue;
            }
            if (key === "from") fromClassName = val.text;
            else toClassName = val.text;
        } else if (key === "label" && ts.isStringLiteral(val)) {
            label = val.text;
        } else if (key === "directed") {
            if (val.kind === ts.SyntaxKind.TrueKeyword) directed = true;
            if (val.kind === ts.SyntaxKind.FalseKeyword) directed = false;
        } else if (key === "fromField" && ts.isStringLiteral(val)) {
            fromField = val.text;
        } else if (key === "toField" && ts.isStringLiteral(val)) {
            toField = val.text;
        }
        // name/private/description are read by extractSchemaOptions
    }

    if (fromClassName === undefined || toClassName === undefined) {
        ctx.diagnostics.push(
            mkError(
                KEYMA063,
                `@Edge requires "from" and "to" class identifiers`,
                getLocation(arg, sourceFile),
            ),
        );
        return undefined;
    }

    const out: DiscoveredEdgeOptions = { fromClassName, toClassName };
    if (label !== undefined) out.label = label;
    if (directed !== undefined) out.directed = directed;
    if (fromField !== undefined) out.fromField = fromField;
    if (toField !== undefined) out.toField = toField;
    return out;
}

export { KEYMA032, KEYMA033 };
