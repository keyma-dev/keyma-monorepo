import ts from "typescript";
import type { IRService, IRServiceMethod, IRDiagnostic } from "@keyma/ir";
import { mkError, KEYMA093, KEYMA094 } from "./diagnostics.js";
import { getLocation } from "./util.js";
import { lowerSignature, type MethodLowerCtx } from "./lower-method.js";
import type { EnumInfo } from "./discover-enums.js";
import type { DiscoveredService } from "./discover-services.js";

type ExtractServiceContext = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
    enums?: ReadonlyMap<string, EnumInfo>;
    diagnostics: IRDiagnostic[];
};

/**
 * Extract an {@link IRService} from a discovered `@Service` abstract class. Only
 * the method SIGNATURES are lowered (no bodies — service implementations live in
 * server runtime code). Each method must be abstract; concrete methods are
 * rejected with KEYMA093.
 */
export function extractService(
    discovered: DiscoveredService,
    ctx: ExtractServiceContext,
): IRService {
    const { classNode, className, sourceFile, serviceOptions } = discovered;
    // The service name is also the generated class name — keep the source casing
    // (no lowercasing as schemas do for collection names).
    const name = serviceOptions.name ?? className;
    const visibility = serviceOptions.private === true ? "private" : "public";

    const methodCtx: MethodLowerCtx = {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        schemaClassNames: ctx.schemaClassNames,
        ...(ctx.enums !== undefined && { enums: ctx.enums }),
        diagnostics: ctx.diagnostics,
        sourceFile,
    };

    const seen = new Set<string>();
    const methods: IRServiceMethod[] = [];

    for (const member of classNode.members) {
        if (!ts.isMethodDeclaration(member)) continue; // skip constructor, properties, etc.
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        const methodName = member.name.text;

        // Service methods are contracts — abstract signatures with no body.
        const isAbstract = (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Abstract) !== 0;
        if (!isAbstract || member.body !== undefined) {
            ctx.diagnostics.push(
                mkError(
                    KEYMA093,
                    `Service method "${methodName}" must be abstract (a signature with no body) — implement it in server code by extending the generated class`,
                    getLocation(member, sourceFile),
                ),
            );
            continue;
        }

        if (seen.has(methodName)) {
            ctx.diagnostics.push(
                mkError(
                    KEYMA094,
                    `Duplicate method name "${methodName}" in service "${className}"`,
                    getLocation(member, sourceFile),
                ),
            );
            continue;
        }
        seen.add(methodName);

        const sig = lowerSignature(member, methodName, methodCtx);
        if (sig === null) continue;

        const method: IRServiceMethod = {
            name: methodName,
            params: sig.params,
            visibility: memberVisibility(member),
            source: getLocation(member, sourceFile),
        };
        if (sig.returnType !== undefined) method.returnType = sig.returnType;
        methods.push(method);
    }

    const service: IRService = {
        id: `service:${name}`,
        name,
        sourceName: className,
        visibility,
        methods,
        source: discovered.source,
    };
    if (serviceOptions.description !== undefined) service.description = serviceOptions.description;
    return service;
}

/** Public/private visibility of a class member from its TS modifiers. */
function memberVisibility(member: ts.ClassElement): "public" | "private" {
    const flags = ts.getCombinedModifierFlags(member);
    return (flags & ts.ModifierFlags.Private) || (flags & ts.ModifierFlags.Protected) ? "private" : "public";
}
