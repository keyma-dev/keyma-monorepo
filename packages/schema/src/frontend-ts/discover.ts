import ts from "typescript";
import { getLocation, findKeymaClassDecorator, extractDecoratorOptions } from "@keyma/compiler/frontend-ts";
import type { IRDiagnostic, IRSourceLocation } from "@keyma/core/ir";
import { KEYMA032, KEYMA033 } from "./diagnostics.js";

export type DiscoveredEdgeOptions = {
    /** Whether the edge is directed. Defaults to true when omitted. The
     *  from/to endpoints and the traversal label (the schema `name`) are
     *  derived from the @From()/@To() fields and @Schema/@Edge `name`. */
    directed?: boolean;
};

export type DiscoveredSchema = {
    classNode: ts.ClassDeclaration;
    className: string;
    sourceFile: ts.SourceFile;
    /** Options from @Schema({ name, private, ephemeral, description }). */
    schemaOptions: {
        name?: string;
        private?: boolean;
        ephemeral?: boolean;
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
        ? extractDecoratorOptions(schemaDecorator)
        : edgeDecorator
            ? extractDecoratorOptions(edgeDecorator)  // @Edge shares the Schema options shape
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
    // edgeOptions present-iff @Edge — always set it (even empty) so the extract
    // pass knows this class is an edge and looks for @From()/@To() fields.
    if (edgeDecorator) {
        result.edgeOptions = extractEdgeOptions(edgeDecorator);
    }
    return result;
}

/** Extract @Edge decorator options. Only `directed` is read here; the schema
 *  `name` (used as the traversal label) is read by extractDecoratorOptions, and
 *  the from/to endpoints come from the @From()/@To() fields. */
function extractEdgeOptions(decorator: ts.Decorator): DiscoveredEdgeOptions {
    const expr = decorator.expression;
    if (!ts.isCallExpression(expr) || expr.arguments.length === 0) return {};
    const arg = expr.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return {};

    const out: DiscoveredEdgeOptions = {};
    for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        if (prop.name.text !== "directed") continue;
        const val = prop.initializer;
        if (val.kind === ts.SyntaxKind.TrueKeyword) out.directed = true;
        if (val.kind === ts.SyntaxKind.FalseKeyword) out.directed = false;
    }
    return out;
}

export { KEYMA032, KEYMA033 };
