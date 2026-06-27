import ts from "typescript";
import type {
    IRService,
    IRServiceMethod,
    IRClassDeclaration,
    IRType,
    IRDiagnostic,
} from "@keyma/core/ir";
import { getLocation, isCoreDslSymbol } from "./util.js";
import { extractDecoratorOptions } from "./decorator.js";
import { discoverEnums, type EnumInfo } from "./discover-enums.js";
import { lowerSignature, type MethodLowerCtx } from "./lower-method.js";
import {
    mkError,
    KEYMA093,
    KEYMA094,
    KEYMA095,
    KEYMA096,
    KEYMA097,
} from "./diagnostics.js";

/**
 * The canonical module for type-marker resolution in service signatures. The DSL semantic
 * types a service param/return may use (`Reference`/`Embedded`/`ID`/…) are core-owned and
 * recognized by `mapTypeNode` through their `@keyma/core/dsl` identity regardless of which
 * re-export umbrella the author imported them through, so the base pass resolves against the
 * canonical specifier and stays domain-agnostic.
 */
const CORE_DSL_MODULE = "@keyma/core/dsl";

/** The neutral inputs the base service pass consults — a slice of the frontend domain context. */
export type ServicePassContext = {
    checker: ts.TypeChecker;
    diagnostics: IRDiagnostic[];
    namePrefix: string;
    /** Explicit DSL-module override from config, if any (for marker resolution). */
    dslModuleName?: string;
};

/**
 * The built-in `@Service` base pass. `@Service`/RPC is a base-language concern the compiler
 * owns end-to-end — parallel to class lowering — so discovery, extraction, the KEYMA093–097
 * checks, and service-name normalization all live here rather than in any domain.
 *
 * It runs in `compileProgram` AFTER every registered domain has produced its class surface, so
 * it sees the full, finalized set of classes (`classes`) to resolve service param/return types
 * and to enforce visibility/collision rules — without any inter-domain seam. The pass stays
 * domain-agnostic: it knows only "`@Service` classes I discovered" (matched by their
 * `@keyma/core/dsl` identity) and "classes some domain produced" (`classes`); it never names a
 * domain's class decorator. The contributed classes are already finalized (their `name` is
 * the prefixed canonical identity); `sourceName` is normalization-stable, so service param/
 * return targets resolve correctly.
 */
export function runServicePass(
    program: ts.Program,
    ctx: ServicePassContext,
    classes: readonly IRClassDeclaration[],
    dataModelDecoratedNames: ReadonlySet<string>,
): IRService[] {
    const { checker, diagnostics } = ctx;
    const dslModuleName = ctx.dslModuleName ?? CORE_DSL_MODULE;

    // The full lowered data-class surface — used to resolve service param/return types
    // (`classNames`) and to resolve final names during normalization. `@Service` classes are
    // NOT lowered as data classes, so the KEYMA095 service/data-model overlap is detected via
    // `dataModelDecoratedNames` (classes bearing a registered domain class-decorator) instead.
    const classNames = new Set(classes.map((s) => s.sourceName));
    const enums = discoverEnums(program);

    const services: IRService[] = [];
    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        ts.forEachChild(sourceFile, (node) => {
            if (!ts.isClassDeclaration(node) || !node.name) return;
            const decorator = findCoreServiceDecorator(node, checker);
            if (decorator === undefined) return;

            // KEYMA095: a class that is BOTH a service and a data model. A @Service class is not
            // base-lowered as a data class, so we flag a @Service that ALSO bears a registered
            // domain class-decorator (`@Schema`/`@Edge`/…) — domain-agnostic, and it generalizes
            // to any future data-producing domain.
            if (dataModelDecoratedNames.has(node.name.text)) {
                diagnostics.push(
                    mkError(
                        KEYMA095,
                        `Class "${node.name.text}" is both a @Service and a data model — a service declares callable methods, not stored fields. Split the callable contract from the data class.`,
                        getLocation(node.name, sourceFile),
                    ),
                );
                return;
            }

            const opts = extractDecoratorOptions(decorator);
            services.push(
                extractService(node, node.name.text, sourceFile, opts, {
                    checker,
                    dslModuleName,
                    classNames,
                    enums,
                    diagnostics,
                }),
            );
        });
    }

    // Public service methods must not leak a private class (KEYMA096). Runs while service
    // param/return targets still carry the authored `sourceName`, matched against the private
    // classes' `sourceName`s.
    checkServiceVisibilityLeaks(classes, services, diagnostics);

    // Apply the configured prefix to every service `name`/`id` and rewrite its param/return
    // reference/embedded/instance targets from the authored class name (`sourceName`) to the
    // target class's final `name`. The contributed classes are already normalized, so their
    // `name` is the final identity to point at.
    normalizeServiceNames(classes, services, ctx.namePrefix);

    // Service names must be unique and must not collide with a class name (KEYMA097). Runs on
    // the final (prefixed) names of both sides — equivalent to comparing the un-prefixed names
    // since the prefix is common.
    checkServiceNameCollisions(classes, services, diagnostics);

    return services;
}

/** Whether a class is a `@Service` contract (matched by its `@keyma/core/dsl` identity). The
 *  compiler driver uses this to exclude service classes from base data-class lowering. */
export function isServiceClass(node: ts.ClassDeclaration, checker: ts.TypeChecker): boolean {
    return findCoreServiceDecorator(node, checker) !== undefined;
}

/** Find a `@Service` class decorator by its `@keyma/core/dsl` identity (through re-exports). */
function findCoreServiceDecorator(
    node: ts.ClassDeclaration,
    checker: ts.TypeChecker,
): ts.Decorator | undefined {
    const modifiers = ts.getDecorators(node) ?? node.modifiers;
    if (!modifiers) return undefined;
    for (const modifier of modifiers) {
        if (!ts.isDecorator(modifier)) continue;
        const expr = modifier.expression;
        const ident = ts.isCallExpression(expr) ? expr.expression : expr;
        if (!ts.isIdentifier(ident) || ident.text !== "Service") continue;
        const symbol = checker.getSymbolAtLocation(ident);
        if (!symbol) continue;
        if (isCoreDslSymbol(symbol, checker, "Service")) return modifier;
    }
    return undefined;
}

type ExtractServiceContext = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    classNames: ReadonlySet<string>;
    enums?: ReadonlyMap<string, EnumInfo>;
    diagnostics: IRDiagnostic[];
};

/**
 * Extract an {@link IRService} from a discovered `@Service` abstract class. Only the method
 * SIGNATURES are lowered (no bodies — service implementations live in server runtime code).
 * Each method must be abstract; concrete methods are rejected with KEYMA093.
 */
function extractService(
    classNode: ts.ClassDeclaration,
    className: string,
    sourceFile: ts.SourceFile,
    serviceOptions: { name?: string; private?: boolean; description?: string },
    ctx: ExtractServiceContext,
): IRService {
    // The service name is also the generated class name — keep the source casing
    // (no lowercasing as data-model classes do for collection names).
    const name = serviceOptions.name ?? className;
    const visibility = serviceOptions.private === true ? "private" : "public";

    const methodCtx: MethodLowerCtx = {
        checker: ctx.checker,
        dslModuleName: ctx.dslModuleName,
        classNames: ctx.classNames,
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
        source: getLocation(classNode.name!, sourceFile),
    };
    if (serviceOptions.description !== undefined) service.description = serviceOptions.description;
    return service;
}

/** Public/private visibility of a class member from its TS modifiers. */
function memberVisibility(member: ts.ClassElement): "public" | "private" {
    const flags = ts.getCombinedModifierFlags(member);
    return (flags & ts.ModifierFlags.Private) || (flags & ts.ModifierFlags.Protected) ? "private" : "public";
}

/**
 * Apply the configured prefix to every service `name`/`id` and rewrite each method's
 * param/return reference/embedded/instance targets from the authored class name (`sourceName`)
 * to the target class's final (already-prefixed) `name`. In-place mutation. The contributed
 * classes are already normalized, so `s.name` is the final identity to point at.
 */
function normalizeServiceNames(
    classes: readonly IRClassDeclaration[],
    services: IRService[],
    prefix: string,
): void {
    // Authored class name (sourceName) -> final identity. Classes are already normalized, so
    // their `name` already carries the prefix; do not re-apply it here.
    const finalName = new Map<string, string>();
    for (const s of classes) finalName.set(s.sourceName, s.name);

    const rewrite = (type: IRType): void => {
        if (type.kind === "array") {
            rewrite(type.of);
        } else if (type.kind === "reference" || type.kind === "embedded") {
            type.target = finalName.get(type.target) ?? type.target;
        } else if (type.kind === "instance") {
            type.name = finalName.get(type.name) ?? type.name;
        }
    };

    for (const svc of services) {
        for (const m of svc.methods) {
            for (const p of m.params) rewrite(p.type);
            if (m.returnType !== undefined) rewrite(m.returnType);
        }
        svc.name = prefix + svc.name;
        svc.id = `service:${svc.name}`;
    }
}

/** A public service method must not expose a private class via a param/return type. */
function checkServiceVisibilityLeaks(
    classes: readonly IRClassDeclaration[],
    services: readonly IRService[],
    diagnostics: IRDiagnostic[],
): void {
    const privateClasses = new Set(
        classes.filter((s) => s.visibility === "private").map((s) => s.sourceName),
    );
    const leakedClass = (t: IRType): string | undefined => {
        const inner = t.kind === "array" ? t.of : t;
        if ((inner.kind === "reference" || inner.kind === "embedded") && privateClasses.has(inner.target)) {
            return inner.target;
        }
        if (inner.kind === "instance" && privateClasses.has(inner.name)) {
            return inner.name;
        }
        return undefined;
    };

    for (const service of services) {
        if (service.visibility !== "public") continue;
        for (const method of service.methods) {
            if (method.visibility !== "public") continue;
            const types: IRType[] = [...method.params.map((p) => p.type)];
            if (method.returnType !== undefined) types.push(method.returnType);
            for (const t of types) {
                const leaked = leakedClass(t);
                if (leaked !== undefined) {
                    diagnostics.push(
                        mkError(
                            KEYMA096,
                            `Public service "${service.sourceName}" method "${method.name}" exposes private class "${leaked}"`,
                            method.source,
                        ),
                    );
                }
            }
        }
    }
}

/** Service names must be unique and must not collide with a class name. */
function checkServiceNameCollisions(
    classes: readonly IRClassDeclaration[],
    services: readonly IRService[],
    diagnostics: IRDiagnostic[],
): void {
    const classNames = new Set(classes.map((s) => s.name));
    const seen = new Set<string>();
    for (const service of services) {
        if (classNames.has(service.name)) {
            diagnostics.push(
                mkError(
                    KEYMA097,
                    `Service name "${service.name}" collides with a class of the same name`,
                    service.source,
                ),
            );
        }
        if (seen.has(service.name)) {
            diagnostics.push(
                mkError(
                    KEYMA097,
                    `Duplicate service name "${service.name}"`,
                    service.source,
                ),
            );
        } else {
            seen.add(service.name);
        }
    }
}
