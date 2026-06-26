import type { IRExpression, IRStatement, IRField, IRType, IRSchema } from "../../ir/src/index.js";
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
        case "arrow":
            if (expr.body) collectIdentifiers(expr.body, out);
            (expr.statements ?? []).forEach((s) => collectStatementIdentifiers(s, out));
            break;
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
    }
}

/** The set of embedded/reference schema targets named by these fields (recursing through arrays). */
export function collectRefTargets(fields: readonly IRField[]): Set<string> {
    const out = new Set<string>();
    const collect = (type: IRType): void => {
        if (type.kind === "embedded" || type.kind === "reference") out.add(type.schema);
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
export function collectFunctionRefs(schemas: readonly IRSchema[], deps: FunctionRefDeps): Set<string> {
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
