import ts from "typescript";
import type { IRSourceLocation } from "@keyma/ir";
import { getLocation, resolveAlias, isFromModule } from "./util.js";

/** A callable node that can be lowered into a validator/formatter declaration. */
type CallableNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/**
 * A validator/formatter factory collected at a `@Validate`/`@Format` use site,
 * pending lowering to an IR declaration. The factory is a plain function returning
 * a `ValidatorFn`/`FormatterFn` (e.g. `function minLength(m): ValidatorFn<string>`).
 */
export type CollectedFactory = {
    /** IR name — the factory function's own name (also the model-file import binding). */
    name: string;
    /** The factory node carrying its params + body (the body returns the inner fn). */
    node: CallableNode;
    /** The `<T>` argument of the `ValidatorFn<T>`/`FormatterFn<T>` return annotation, if any. */
    returnTypeArg: ts.TypeNode | undefined;
    sourceFile: ts.SourceFile;
    source: IRSourceLocation;
};

/** Resolution result for one `@Validate`/`@Format` argument. */
export type ResolvedFactory = { name: string; factoryParams: readonly ts.ParameterDeclaration[] };

export type CollectorDeps = {
    checker: ts.TypeChecker;
    /** Module name of the Keyma DSL (e.g. "@keyma/dsl"). */
    dslModuleName: string;
};

/**
 * Use-driven collector of validator/formatter factories. Instead of scanning every
 * source file for declarations up front, `resolveValidator`/`resolveFormatter` are
 * called at each `@Validate(...)`/`@Format(...)` argument: they resolve the callee
 * across imports/aliases to a function whose return type is the DSL's
 * `ValidatorFn`/`FormatterFn`, enqueue it (deduped by symbol identity), and return
 * its IR name + factory parameter list. `drainValidators`/`drainFormatters` return
 * the set actually referenced — so unused library validators are never emitted.
 */
export type ValidatorFormatterCollector = {
    resolveValidator: (callee: ts.Identifier) => ResolvedFactory | undefined;
    resolveFormatter: (callee: ts.Identifier) => ResolvedFactory | undefined;
    drainValidators: () => CollectedFactory[];
    drainFormatters: () => CollectedFactory[];
};

export function createValidatorFormatterCollector(deps: CollectorDeps): ValidatorFormatterCollector {
    const { checker, dslModuleName } = deps;
    const seenValidators = new Set<ts.Symbol>();
    const seenFormatters = new Set<ts.Symbol>();
    const validators: CollectedFactory[] = [];
    const formatters: CollectedFactory[] = [];

    function resolve(
        callee: ts.Identifier,
        marker: "ValidatorFn" | "FormatterFn",
        seen: Set<ts.Symbol>,
        out: CollectedFactory[],
    ): ResolvedFactory | undefined {
        const symbol = checker.getSymbolAtLocation(callee);
        if (symbol === undefined) return undefined;
        const resolved = resolveAlias(symbol, checker);

        const found = findFactory(resolved.getDeclarations() ?? []);
        if (found === undefined) return undefined;
        // A validator/formatter factory is identified by its declared return type
        // being the DSL's ValidatorFn/FormatterFn — not by any naming convention.
        if (!isDslTypeRef(found.returnTypeNode, marker)) return undefined;

        const name = resolved.getName();
        if (!seen.has(resolved)) {
            seen.add(resolved);
            const sourceFile = found.node.getSourceFile();
            out.push({
                name,
                node: found.node,
                returnTypeArg:
                    found.returnTypeNode !== undefined && ts.isTypeReferenceNode(found.returnTypeNode)
                        ? found.returnTypeNode.typeArguments?.[0]
                        : undefined,
                sourceFile,
                source: getLocation(found.node, sourceFile),
            });
        }
        return { name, factoryParams: found.node.parameters };
    }

    /** Whether a type node is a reference to the DSL's `ValidatorFn`/`FormatterFn`. */
    function isDslTypeRef(node: ts.TypeNode | undefined, marker: string): boolean {
        if (node === undefined || !ts.isTypeReferenceNode(node)) return false;
        const sym = checker.getSymbolAtLocation(node.typeName);
        if (sym === undefined) return false;
        return resolveAlias(sym, checker).getName() === marker && isFromModule(sym, checker, dslModuleName);
    }

    return {
        resolveValidator: (callee) => resolve(callee, "ValidatorFn", seenValidators, validators),
        resolveFormatter: (callee) => resolve(callee, "FormatterFn", seenFormatters, formatters),
        drainValidators: () => validators,
        drainFormatters: () => formatters,
    };
}

/** Find the factory declaration (function/arrow with a body) among a symbol's declarations. */
function findFactory(
    decls: readonly ts.Declaration[],
): { node: CallableNode; returnTypeNode: ts.TypeNode | undefined } | undefined {
    for (const d of decls) {
        if (ts.isFunctionDeclaration(d) && d.body !== undefined) {
            return { node: d, returnTypeNode: d.type };
        }
        if (
            ts.isVariableDeclaration(d) &&
            d.initializer !== undefined &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
            // A `const x: ValidatorFn<T>'s factory` carries the annotation on the
            // variable; otherwise read it off the arrow/function expression.
            return { node: d.initializer, returnTypeNode: d.type ?? d.initializer.type };
        }
    }
    return undefined;
}
