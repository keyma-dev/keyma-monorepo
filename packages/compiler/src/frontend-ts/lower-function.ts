import ts from "typescript";
import type {
    IRFunctionDeclaration,
    IRFunctionParam,
    IRStatement,
    IRType,
    IRDiagnostic,
} from "@keyma/core/ir";
import { mkError, KEYMA086 } from "./diagnostics.js";
import { getLocation, resolveAlias } from "./util.js";
import { mapTypeNode, type TypeMapContext } from "./map-type.js";
import { lowerExpr, lowerStatements, type BodyLowerCtx, type FnRefVerdict } from "./lower-body.js";
import { peelPromise } from "./lower-method.js";

/** A callable node that can be compiled into an IRFunctionDeclaration. */
type CallableNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

type QueuedFunction = {
    symbol: ts.Symbol;
    name: string;
    node: CallableNode;
    sourceFile: ts.SourceFile;
};

export type FunctionCollectorDeps = {
    checker: ts.TypeChecker;
    dslModuleName: string;
    schemaClassNames: ReadonlySet<string>;
    diagnostics: IRDiagnostic[];
};

/**
 * Resolves and compiles project-local utility functions referenced (transitively)
 * from validator/formatter bodies. `classify` is wired into body lowering so that
 * each call target is resolved; `drain` lowers every enqueued function (which may
 * enqueue further functions) until the worklist is empty.
 */
export type FunctionCollector = {
    classify: (ident: ts.Identifier) => FnRefVerdict;
    /**
     * Enqueue the complete project-local top-level function surface (every `function` decl and
     * `const f = (…) => …` / function-expression in a non-declaration, non-`node_modules` source
     * file), so the IR carries all local functions — referenced or not — as a complete import
     * surface. `isExcluded(returnType)` skips declarations a domain lowers separately (the schema
     * domain excludes validator/formatter factories, which lower only where referenced). Shares
     * `classify`'s dedup, so a function already reached by reference is not enqueued twice.
     */
    enqueueLocalSurface: (program: ts.Program, isExcluded: (returnType: ts.TypeNode | undefined) => boolean) => void;
    drain: () => IRFunctionDeclaration[];
};

export function createFunctionCollector(deps: FunctionCollectorDeps): FunctionCollector {
    const { checker, diagnostics } = deps;
    const seen = new Set<ts.Symbol>();
    const byName = new Map<string, ts.Symbol>();
    const queue: QueuedFunction[] = [];

    function classify(ident: ts.Identifier): FnRefVerdict {
        const sym = checker.getSymbolAtLocation(ident);
        if (sym === undefined) return { kind: "passthrough" };
        const resolved = resolveAlias(sym, checker);
        const decls = resolved.getDeclarations() ?? [];

        // Local bindings (factory/inner params) are emitted verbatim.
        if (decls.some((d) => ts.isParameter(d))) return { kind: "passthrough" };

        const found = findCallable(decls);
        if (found === undefined) {
            // A function-like symbol with no compilable body (e.g. an ambient
            // `declare function`, or a function imported from a `.d.ts`) cannot be
            // compiled — reject rather than silently emitting a broken external call.
            if (decls.some((d) => ts.isFunctionDeclaration(d))) {
                diagnostics.push(mkError(
                    KEYMA086,
                    `Function "${ident.text}" cannot be compiled — it has no body (ambient or external declaration)`,
                    getLocation(ident, ident.getSourceFile()),
                ));
                return { kind: "reject" };
            }
            return { kind: "passthrough" };
        }

        const declFile = found.node.getSourceFile();
        const filePath = declFile.fileName.replace(/\\/g, "/");
        if (declFile.isDeclarationFile || filePath.includes("/node_modules/")) {
            diagnostics.push(mkError(
                KEYMA086,
                `Function "${ident.text}" cannot be compiled — only project-local functions may be called from validator/formatter bodies`,
                getLocation(ident, ident.getSourceFile()),
            ));
            return { kind: "reject" };
        }

        const name = resolved.getName();

        // Distinct symbols sharing an emit name would collide in the generated module.
        const prior = byName.get(name);
        if (prior !== undefined && prior !== resolved) {
            diagnostics.push(mkError(
                KEYMA086,
                `Two distinct utility functions are named "${name}" — referenced functions must have unique names`,
                getLocation(ident, ident.getSourceFile()),
            ));
            return { kind: "reject" };
        }

        if (!seen.has(resolved)) {
            seen.add(resolved);
            byName.set(name, resolved);
            queue.push({ symbol: resolved, name, node: found.node, sourceFile: declFile });
        }
        return { kind: "compile", name };
    }

    function enqueueLocalSurface(
        program: ts.Program,
        isExcluded: (returnType: ts.TypeNode | undefined) => boolean,
    ): void {
        for (const sf of program.getSourceFiles()) {
            if (sf.isDeclarationFile) continue;
            if (sf.fileName.replace(/\\/g, "/").includes("/node_modules/")) continue;
            for (const stmt of sf.statements) {
                if (ts.isFunctionDeclaration(stmt) && stmt.body !== undefined && stmt.name !== undefined) {
                    if (!isExcluded(stmt.type)) enqueueDeclaration(stmt.name, stmt, sf);
                } else if (ts.isVariableStatement(stmt)) {
                    for (const d of stmt.declarationList.declarations) {
                        if (ts.isIdentifier(d.name) && d.initializer !== undefined
                            && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
                            if (!isExcluded(d.type ?? d.initializer.type)) enqueueDeclaration(d.name, d.initializer, sf);
                        }
                    }
                }
            }
        }
    }

    /** Enqueue one local function declaration (deduped by symbol; collision-checked by name),
     *  mirroring `classify`'s bookkeeping for the declaration-driven (full-surface) path. */
    function enqueueDeclaration(nameNode: ts.Identifier, node: CallableNode, sourceFile: ts.SourceFile): void {
        const sym = checker.getSymbolAtLocation(nameNode);
        if (sym === undefined) return;
        const resolved = resolveAlias(sym, checker);
        const name = resolved.getName();
        const prior = byName.get(name);
        if (prior !== undefined && prior !== resolved) {
            diagnostics.push(mkError(
                KEYMA086,
                `Two distinct utility functions are named "${name}" — referenced functions must have unique names`,
                getLocation(nameNode, sourceFile),
            ));
            return;
        }
        if (!seen.has(resolved)) {
            seen.add(resolved);
            byName.set(name, resolved);
            queue.push({ symbol: resolved, name, node, sourceFile });
        }
    }

    function drain(): IRFunctionDeclaration[] {
        const results: IRFunctionDeclaration[] = [];
        // The queue grows as bodies are lowered (transitive references); the `seen`
        // set is marked at enqueue time, so recursion terminates.
        while (queue.length > 0) {
            const fn = queue.shift()!;
            results.push(lowerFunction(fn));
        }
        return results;
    }

    function lowerFunction(fn: QueuedFunction): IRFunctionDeclaration {
        const ctx: BodyLowerCtx = {
            diagnostics,
            sourceFile: fn.sourceFile,
            checker,
            dslModuleName: deps.dslModuleName,
            schemaClassNames: deps.schemaClassNames,
            classifyFunction: classify,
        };
        const typeMapCtx: TypeMapContext = {
            checker,
            dslModuleName: deps.dslModuleName,
            schemaClassNames: deps.schemaClassNames,
            bareClassInstance: true,
            diagnostics,
            sourceFile: fn.sourceFile,
        };

        const params: IRFunctionParam[] = fn.node.parameters.map((p) => ({
            name: ts.isIdentifier(p.name) ? p.name.text : "_",
            type: mapAnnotatedType(p.type, p, `parameter of "${fn.name}"`, typeMapCtx, ctx),
        }));

        // An `async` function's body may `await`; its `Promise<T>` return annotation is
        // peeled to the unwrapped `T` (the wrapper is implied by `async`).
        const isAsync = isAsyncCallable(fn.node);
        const returnNode = isAsync && fn.node.type !== undefined ? peelPromise(fn.node.type) : fn.node.type;
        const returnType = mapAnnotatedType(returnNode, fn.node, `return type of "${fn.name}"`, typeMapCtx, ctx);

        const statements = lowerFunctionBody(fn.node, ctx);

        const result: IRFunctionDeclaration = {
            name: fn.name,
            params,
            returnType,
            statements,
            source: getLocation(fn.node, fn.sourceFile),
        };
        if (isAsync) result.async = true;
        return result;
    }

    /** Map an explicit type annotation; missing/unknown/any → KEYMA086 + `json` fallback. */
    function mapAnnotatedType(
        typeNode: ts.TypeNode | undefined,
        at: ts.Node,
        what: string,
        typeMapCtx: TypeMapContext,
        ctx: BodyLowerCtx,
    ): IRType {
        if (typeNode === undefined
            || typeNode.kind === ts.SyntaxKind.UnknownKeyword
            || typeNode.kind === ts.SyntaxKind.AnyKeyword) {
            ctx.diagnostics.push(mkError(
                KEYMA086,
                `Utility function ${what} must declare an explicit, concrete type`,
                getLocation(at, ctx.sourceFile),
            ));
            return { kind: "json" };
        }
        const result = mapTypeNode(typeNode, typeMapCtx);
        if ("diag" in result) {
            ctx.diagnostics.push(result.diag);
            return { kind: "json" };
        }
        return result.type;
    }

    return { classify, enqueueLocalSurface, drain };
}

function findCallable(decls: readonly ts.Declaration[]): { node: CallableNode } | undefined {
    for (const d of decls) {
        if (ts.isFunctionDeclaration(d) && d.body !== undefined) return { node: d };
        if (ts.isVariableDeclaration(d) && d.initializer !== undefined
            && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
            return { node: d.initializer };
        }
    }
    return undefined;
}

/** True when a callable is declared `async` (works for all three callable node forms). */
function isAsyncCallable(node: CallableNode): boolean {
    return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

function lowerFunctionBody(node: CallableNode, ctx: BodyLowerCtx): IRStatement[] {
    // Concise arrow body: (x) => expr  →  return expr
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        const expr = lowerExpr(node.body, ctx);
        return expr !== null ? [{ kind: "return", value: expr }] : [];
    }
    const block = node.body as ts.Block;
    // lowerStatements drives the shared engine (loop/switch/C-style-`for` desugar).
    return lowerStatements(block.statements, ctx);
}
