import type { IRExpression, IRStatement, IRMember, IRType, IRClassDeclaration, IRFunctionDeclaration } from "../ir/index.js";
import { filterVisibleFields, filterVisibleMethods } from "./visibility.js";

/** Recursively unwrap array layers from an IRType to get the innermost element type. */
export function unwrapArray(type: IRType): IRType {
    return type.kind === "array" ? unwrapArray(type.of) : type;
}

/** Collect every identifier name referenced anywhere in an IRExpression tree into `out`. */
export function collectIdentifiers(expr: IRExpression, out: Set<string>): void {
    switch (expr.kind) {
        case "identifier": out.add(expr.name); break;
        case "member": collectIdentifiers(expr.object, out); break;
        case "call": collectIdentifiers(expr.callee, out); expr.args.forEach((a) => collectIdentifiers(a, out)); break;
        case "new": collectIdentifiers(expr.callee, out); expr.args.forEach((a) => collectIdentifiers(a, out)); break;
        case "typeof": collectIdentifiers(expr.operand, out); break;
        case "unary": collectIdentifiers(expr.operand, out); break;
        case "template": expr.parts.forEach((p) => collectIdentifiers(p, out)); break;
        case "binary": collectIdentifiers(expr.left, out); collectIdentifiers(expr.right, out); break;
        case "conditional":
            collectIdentifiers(expr.condition, out);
            collectIdentifiers(expr.whenTrue, out);
            collectIdentifiers(expr.whenFalse, out);
            break;
        case "object": expr.properties.forEach((p) => collectIdentifiers(p.value, out)); break;
        case "array": expr.elements.forEach((el) => collectIdentifiers(el, out)); break;
        case "record": expr.properties.forEach((p) => collectIdentifiers(p.value, out)); break;
        case "arrow":
            if (expr.body) collectIdentifiers(expr.body, out);
            (expr.statements ?? []).forEach((s) => collectStatementIdentifiers(s, out));
            break;
        case "await": collectIdentifiers(expr.operand, out); break;
        case "intrinsic":
            if (expr.receiver) collectIdentifiers(expr.receiver, out);
            expr.args.forEach((a) => collectIdentifiers(a, out));
            break;
    }
}

/** Collect every identifier name referenced anywhere in an IRStatement tree into `out`. */
export function collectStatementIdentifiers(stmt: IRStatement, out: Set<string>): void {
    switch (stmt.kind) {
        case "return": if (stmt.value) collectIdentifiers(stmt.value, out); break;
        case "expression": collectIdentifiers(stmt.expr, out); break;
        case "const": collectIdentifiers(stmt.init, out); break;
        case "assign": collectIdentifiers(stmt.target, out); collectIdentifiers(stmt.value, out); break;
        case "if":
            collectIdentifiers(stmt.condition, out);
            stmt.consequent.forEach((s) => collectStatementIdentifiers(s, out));
            (stmt.alternate ?? []).forEach((s) => collectStatementIdentifiers(s, out));
            break;
        case "forOf":
            // `stmt.name` is a fresh loop binding, not a free reference (mirrors `const`).
            collectIdentifiers(stmt.iterable, out);
            stmt.body.forEach((s) => collectStatementIdentifiers(s, out));
            break;
        case "while":
            collectIdentifiers(stmt.condition, out);
            stmt.body.forEach((s) => collectStatementIdentifiers(s, out));
            break;
        case "switch":
            collectIdentifiers(stmt.discriminant, out);
            stmt.cases.forEach((c) => {
                if (c.test) collectIdentifiers(c.test, out);
                c.body.forEach((s) => collectStatementIdentifiers(s, out));
            });
            break;
        case "break":
        case "continue":
            break;
    }
}

/** Collect every intrinsic `op` used anywhere in an IRExpression tree into `out`. Used by the
 *  driver's pre-emit compatibility scan to find which intrinsic ops a body relies on. */
export function collectIntrinsicOps(expr: IRExpression, out: Set<string>): void {
    switch (expr.kind) {
        case "intrinsic":
            out.add(expr.op);
            if (expr.receiver) collectIntrinsicOps(expr.receiver, out);
            expr.args.forEach((a) => collectIntrinsicOps(a, out));
            break;
        case "member": collectIntrinsicOps(expr.object, out); break;
        case "call": collectIntrinsicOps(expr.callee, out); expr.args.forEach((a) => collectIntrinsicOps(a, out)); break;
        case "new": collectIntrinsicOps(expr.callee, out); expr.args.forEach((a) => collectIntrinsicOps(a, out)); break;
        case "typeof": collectIntrinsicOps(expr.operand, out); break;
        case "unary": collectIntrinsicOps(expr.operand, out); break;
        case "await": collectIntrinsicOps(expr.operand, out); break;
        case "template": expr.parts.forEach((p) => collectIntrinsicOps(p, out)); break;
        case "binary": collectIntrinsicOps(expr.left, out); collectIntrinsicOps(expr.right, out); break;
        case "conditional":
            collectIntrinsicOps(expr.condition, out);
            collectIntrinsicOps(expr.whenTrue, out);
            collectIntrinsicOps(expr.whenFalse, out);
            break;
        case "object": expr.properties.forEach((p) => collectIntrinsicOps(p.value, out)); break;
        case "array": expr.elements.forEach((el) => collectIntrinsicOps(el, out)); break;
        case "record": expr.properties.forEach((p) => collectIntrinsicOps(p.value, out)); break;
        case "arrow":
            if (expr.body) collectIntrinsicOps(expr.body, out);
            (expr.statements ?? []).forEach((s) => collectIntrinsicOpsInStatement(s, out));
            break;
    }
}

/** Collect every intrinsic `op` used anywhere in an IRStatement tree into `out`. */
export function collectIntrinsicOpsInStatement(stmt: IRStatement, out: Set<string>): void {
    switch (stmt.kind) {
        case "return": if (stmt.value) collectIntrinsicOps(stmt.value, out); break;
        case "expression": collectIntrinsicOps(stmt.expr, out); break;
        case "const": collectIntrinsicOps(stmt.init, out); break;
        case "assign": collectIntrinsicOps(stmt.target, out); collectIntrinsicOps(stmt.value, out); break;
        case "if":
            collectIntrinsicOps(stmt.condition, out);
            stmt.consequent.forEach((s) => collectIntrinsicOpsInStatement(s, out));
            (stmt.alternate ?? []).forEach((s) => collectIntrinsicOpsInStatement(s, out));
            break;
        case "forOf":
            collectIntrinsicOps(stmt.iterable, out);
            stmt.body.forEach((s) => collectIntrinsicOpsInStatement(s, out));
            break;
        case "while":
            collectIntrinsicOps(stmt.condition, out);
            stmt.body.forEach((s) => collectIntrinsicOpsInStatement(s, out));
            break;
        case "switch":
            collectIntrinsicOps(stmt.discriminant, out);
            stmt.cases.forEach((c) => {
                if (c.test) collectIntrinsicOps(c.test, out);
                c.body.forEach((s) => collectIntrinsicOpsInStatement(s, out));
            });
            break;
        case "break":
        case "continue":
            break;
    }
}

/** Collect every `typeVar` name referenced anywhere in an IRType tree into `out`. */
export function collectTypeVarsInType(type: IRType, out: Set<string>): void {
    switch (type.kind) {
        case "typeVar": out.add(type.name); break;
        case "array": collectTypeVarsInType(type.of, out); break;
        case "optional": collectTypeVarsInType(type.of, out); break;
        case "function":
            type.params.forEach((p) => collectTypeVarsInType(p.type, out));
            if (type.returns) collectTypeVarsInType(type.returns, out);
            break;
        case "reference":
            if (type.idType) collectTypeVarsInType(type.idType, out);
            break;
    }
}

/** Collect every `typeVar` name referenced anywhere in an IRExpression tree into `out`
 *  (through arrow param/return types, `typeArgs` bindings, and nested sub-expressions). */
export function collectTypeVarsInExpression(expr: IRExpression, out: Set<string>): void {
    const args = (a: Record<string, IRType> | undefined): void => {
        if (a) for (const t of Object.values(a)) collectTypeVarsInType(t, out);
    };
    switch (expr.kind) {
        case "identifier": args(expr.typeArgs); break;
        case "member": collectTypeVarsInExpression(expr.object, out); break;
        case "call":
            args(expr.typeArgs);
            collectTypeVarsInExpression(expr.callee, out);
            expr.args.forEach((a) => collectTypeVarsInExpression(a, out));
            break;
        case "new": collectTypeVarsInExpression(expr.callee, out); expr.args.forEach((a) => collectTypeVarsInExpression(a, out)); break;
        case "typeof": collectTypeVarsInExpression(expr.operand, out); break;
        case "unary": collectTypeVarsInExpression(expr.operand, out); break;
        case "template": expr.parts.forEach((p) => collectTypeVarsInExpression(p, out)); break;
        case "binary": collectTypeVarsInExpression(expr.left, out); collectTypeVarsInExpression(expr.right, out); break;
        case "conditional":
            collectTypeVarsInExpression(expr.condition, out);
            collectTypeVarsInExpression(expr.whenTrue, out);
            collectTypeVarsInExpression(expr.whenFalse, out);
            break;
        case "object": expr.properties.forEach((p) => collectTypeVarsInExpression(p.value, out)); break;
        case "array": expr.elements.forEach((el) => collectTypeVarsInExpression(el, out)); break;
        case "record": expr.properties.forEach((p) => collectTypeVarsInExpression(p.value, out)); break;
        case "arrow":
            expr.params.forEach((p) => { if (typeof p !== "string" && p.type) collectTypeVarsInType(p.type, out); });
            if (expr.returnType) collectTypeVarsInType(expr.returnType, out);
            if (expr.body) collectTypeVarsInExpression(expr.body, out);
            (expr.statements ?? []).forEach((s) => collectTypeVarsInStatement(s, out));
            break;
        case "await": collectTypeVarsInExpression(expr.operand, out); break;
        case "intrinsic":
            if (expr.receiver) collectTypeVarsInExpression(expr.receiver, out);
            expr.args.forEach((a) => collectTypeVarsInExpression(a, out));
            break;
    }
}

/** Collect every `typeVar` name referenced anywhere in an IRStatement tree into `out`. */
export function collectTypeVarsInStatement(stmt: IRStatement, out: Set<string>): void {
    switch (stmt.kind) {
        case "return": if (stmt.value) collectTypeVarsInExpression(stmt.value, out); break;
        case "expression": collectTypeVarsInExpression(stmt.expr, out); break;
        case "const": collectTypeVarsInExpression(stmt.init, out); break;
        case "assign": collectTypeVarsInExpression(stmt.target, out); collectTypeVarsInExpression(stmt.value, out); break;
        case "if":
            collectTypeVarsInExpression(stmt.condition, out);
            stmt.consequent.forEach((s) => collectTypeVarsInStatement(s, out));
            (stmt.alternate ?? []).forEach((s) => collectTypeVarsInStatement(s, out));
            break;
        case "forOf":
            collectTypeVarsInExpression(stmt.iterable, out);
            stmt.body.forEach((s) => collectTypeVarsInStatement(s, out));
            break;
        case "while":
            collectTypeVarsInExpression(stmt.condition, out);
            stmt.body.forEach((s) => collectTypeVarsInStatement(s, out));
            break;
        case "switch":
            collectTypeVarsInExpression(stmt.discriminant, out);
            stmt.cases.forEach((c) => {
                if (c.test) collectTypeVarsInExpression(c.test, out);
                c.body.forEach((s) => collectTypeVarsInStatement(s, out));
            });
            break;
        case "break":
        case "continue":
            break;
    }
}

/** The set of embedded/reference schema targets named by these fields (recursing through arrays). */
export function collectRefTargets(fields: readonly IRMember[]): Set<string> {
    const out = new Set<string>();
    const collect = (type: IRType): void => {
        if (type.kind === "embedded" || type.kind === "reference") out.add(type.target);
        else if (type.kind === "array") collect(type.of);
    };
    for (const f of fields) collect(f.type);
    return out;
}

/** Inputs `collectFunctionRefs` needs from a backend's module-emit context. */
export interface FunctionRefDeps {
    readonly includePrivate: boolean;
    readonly includeDefaults: boolean;
    readonly functionNames: ReadonlySet<string>;
}

/**
 * The subset of declared utility-function names (`deps.functionNames`) actually referenced by a
 * module's expression defaults and method bodies — used to tree-shake function imports/emit.
 */
export function collectFunctionRefs(schemas: readonly IRClassDeclaration[], deps: FunctionRefDeps): Set<string> {
    const ids = new Set<string>();
    for (const schema of schemas) {
        for (const field of filterVisibleFields(schema, deps.includePrivate)) {
            if (deps.includeDefaults && field.default !== undefined && field.default.kind === "expression") {
                collectIdentifiers(field.default.expression, ids);
            }
        }
        for (const method of filterVisibleMethods(schema, deps.includePrivate)) {
            for (const stmt of method.statements) collectStatementIdentifiers(stmt, ids);
        }
    }
    return new Set([...ids].filter((id) => deps.functionNames.has(id)));
}

/**
 * Transitive closure of declared function names reachable from `seeds`, following
 * function→function references through each declaration's body. `seeds` are the function
 * names a bundle's visible roots reference directly (method/default bodies + the
 * validator/formatter factories attached to visible fields); the closure pulls in the
 * helpers those functions call in turn. The result drives **per-bundle pruning**: only the
 * reachable functions are emitted, so a helper reachable solely from a private class's
 * server method never lands in the client bundle. A seed naming no declaration (an
 * undeclared/vendor-only ref) contributes nothing and is dropped from the result.
 */
export function reachableFunctions(
    seeds: Iterable<string>,
    functionsByName: ReadonlyMap<string, IRFunctionDeclaration>,
): Set<string> {
    const reached = new Set<string>();
    const stack = [...seeds];
    while (stack.length > 0) {
        const name = stack.pop()!;
        if (reached.has(name)) continue;
        const decl = functionsByName.get(name);
        if (decl === undefined) continue; // an undeclared/vendor-only ref — nothing to recurse into
        reached.add(name);
        const ids = new Set<string>();
        for (const stmt of decl.statements) collectStatementIdentifiers(stmt, ids);
        for (const id of ids) if (functionsByName.has(id) && !reached.has(id)) stack.push(id);
    }
    return reached;
}
