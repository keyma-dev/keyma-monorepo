import ts from "typescript";
import type { IRDiagnostic, IRSourceLocation } from "@keyma/ir";
import { getLocation } from "./util.js";
import { mkError, KEYMA095 } from "./diagnostics.js";
import { findKeymaClassDecorator, extractSchemaOptions } from "./discover.js";

export type DiscoveredService = {
    classNode: ts.ClassDeclaration;
    className: string;
    sourceFile: ts.SourceFile;
    /** Options from @Service({ name, private, description }). */
    serviceOptions: {
        name?: string;
        private?: boolean;
        description?: string;
    };
    source: IRSourceLocation;
};

type DiscoverContext = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    diagnostics: IRDiagnostic[];
};

/** Walk all source files (excluding declaration files) and find @Service-decorated classes. */
export function discoverServices(
    program: ts.Program,
    ctx: DiscoverContext,
): DiscoveredService[] {
    const results: DiscoveredService[] = [];

    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        ts.forEachChild(sourceFile, (node) => {
            if (!ts.isClassDeclaration(node) || !node.name) return;
            const serviceDecorator = findKeymaClassDecorator(node, ctx.checker, ctx.dslModuleName, "Service");
            if (!serviceDecorator) return;

            // A service is not a schema — reject the combination so the class isn't
            // processed as both.
            const schemaDecorator = findKeymaClassDecorator(node, ctx.checker, ctx.dslModuleName, "Schema");
            const edgeDecorator = findKeymaClassDecorator(node, ctx.checker, ctx.dslModuleName, "Edge");
            if (schemaDecorator || edgeDecorator) {
                ctx.diagnostics.push(
                    mkError(
                        KEYMA095,
                        `Class "${node.name.text}" combines @Service with @Schema/@Edge — a service declares callable methods, not a data model`,
                        getLocation(node.name, sourceFile),
                    ),
                );
                return;
            }

            const opts = extractSchemaOptions(serviceDecorator, ctx);
            const serviceOptions: DiscoveredService["serviceOptions"] = {
                ...(opts.name !== undefined && { name: opts.name }),
                ...(opts.private !== undefined && { private: opts.private }),
                ...(opts.description !== undefined && { description: opts.description }),
            };
            results.push({
                classNode: node,
                className: node.name.text,
                sourceFile,
                serviceOptions,
                source: getLocation(node.name, sourceFile),
            });
        });
    }

    return results;
}
