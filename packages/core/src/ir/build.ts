/**
 * Shared IR builders — typed node constructors used by BOTH the compiler and every
 * domain frontend to assemble base IR "valid-by-construction". Raw object literals become
 * the exception, not the rule; `validateIR` remains the backstop for anything a builder
 * cannot statically guarantee (cross-references, bound type variables, symbol-table hits).
 *
 * These are deliberately thin: each returns the precise IR node so misuse is a type error.
 * Optional fields are attached only when provided (the workspace runs with
 * `exactOptionalPropertyTypes`, so an explicit `undefined` is not the same as an absent key).
 */
import type {
    IRType,
    IRExpression,
    IRStatement,
    IRArrowParam,
    IRFunctionParam,
    IRMethod,
    IRFunctionDeclaration,
    IRSourceLocation,
} from "./types.js";

type BinaryOp = Extract<IRExpression, { kind: "binary" }>["op"];
type UnaryOp = Extract<IRExpression, { kind: "unary" }>["op"];

// ── Types ────────────────────────────────────────────────────────────────────

/** A runtime-provided (compiler-emitted) type resolved to a per-language symbol. */
export function external(name: string): IRType {
    return { kind: "external", name };
}

/** A generic type variable, bound at a reference site via `typeArgs`. */
export function typeVar(name: string): IRType {
    return { kind: "typeVar", name };
}

/** A live instance of class `name` (param/return positions). */
export function instanceType(name: string): IRType {
    return { kind: "instance", name };
}

/** A higher-order-function type `(params) => returns`; omit `returns` for `void`. */
export function fnType(params: IRFunctionParam[], returns?: IRType): IRType {
    return returns === undefined ? { kind: "function", params } : { kind: "function", params, returns };
}

/** An array type `of[]`; set `elementNullable` for `(of | null)[]`. */
export function arrayType(of: IRType, elementNullable?: boolean): IRType {
    return elementNullable ? { kind: "array", of, elementNullable } : { kind: "array", of };
}

/** A typed function/method parameter; set `optional` for a defaultable trailing param. */
export function param(name: string, type: IRType, optional?: boolean): IRFunctionParam {
    return optional ? { name, type, optional } : { name, type };
}

// ── Expressions ──────────────────────────────────────────────────────────────

export function literal(value: string | number | boolean | null): IRExpression {
    return { kind: "literal", value };
}

/** A record-field read, `this.<name>`. */
export function field(name: string): IRExpression {
    return { kind: "field", name };
}

/** A bare identifier; pass `typeArgs` when it is a generic function-value reference. */
export function ident(name: string, typeArgs?: Record<string, IRType>): IRExpression {
    return typeArgs === undefined ? { kind: "identifier", name } : { kind: "identifier", name, typeArgs };
}

export function member(object: IRExpression, name: string): IRExpression {
    return { kind: "member", object, member: name };
}

/** A call; pass `typeArgs` when `callee` is a generic function/factory used as a value. */
export function call(callee: IRExpression, args: IRExpression[] = [], typeArgs?: Record<string, IRType>): IRExpression {
    return typeArgs === undefined ? { kind: "call", callee, args } : { kind: "call", callee, args, typeArgs };
}

export function newExpr(callee: IRExpression, args: IRExpression[] = []): IRExpression {
    return { kind: "new", callee, args };
}

/** An object literal. Keys preserve insertion order. */
export function obj(properties: Record<string, IRExpression>): IRExpression {
    return { kind: "object", properties: Object.entries(properties).map(([key, value]) => ({ key, value })) };
}

export function template(parts: IRExpression[]): IRExpression {
    return { kind: "template", parts };
}

export function binary(op: BinaryOp, left: IRExpression, right: IRExpression): IRExpression {
    return { kind: "binary", op, left, right };
}

export function unary(op: UnaryOp, operand: IRExpression): IRExpression {
    return { kind: "unary", op, operand };
}

export function conditional(condition: IRExpression, whenTrue: IRExpression, whenFalse: IRExpression): IRExpression {
    return { kind: "conditional", condition, whenTrue, whenFalse };
}

export function intrinsic(op: string, receiver: IRExpression | null, args: IRExpression[] = []): IRExpression {
    return { kind: "intrinsic", op, receiver, args };
}

/** A concise (expression-bodied) arrow, `(params) => body`. */
export function arrowExpr(params: IRArrowParam[], body: IRExpression, returnType?: IRType): IRExpression {
    return returnType === undefined
        ? { kind: "arrow", params, body }
        : { kind: "arrow", params, body, returnType };
}

/** A block-bodied arrow, `(params) => { statements }`. */
export function arrowBlock(params: IRArrowParam[], statements: IRStatement[], returnType?: IRType): IRExpression {
    return returnType === undefined
        ? { kind: "arrow", params, statements }
        : { kind: "arrow", params, statements, returnType };
}

// ── Statements ─────────────────────────────────────────────────────────────

/** A `return`; omit `value` (or pass `null`) for a bare `return`. */
export function ret(value?: IRExpression | null): IRStatement {
    return { kind: "return", value: value ?? null };
}

export function constDecl(name: string, init: IRExpression): IRStatement {
    return { kind: "const", name, init };
}

export function exprStmt(expr: IRExpression): IRStatement {
    return { kind: "expression", expr };
}

export function assign(target: IRExpression, value: IRExpression): IRStatement {
    return { kind: "assign", target, value };
}

export function ifStmt(condition: IRExpression, consequent: IRStatement[], alternate?: IRStatement[]): IRStatement {
    return alternate === undefined
        ? { kind: "if", condition, consequent }
        : { kind: "if", condition, consequent, alternate };
}

// ── Members / declarations ───────────────────────────────────────────────────

/**
 * Build an `IRMethod`. `returnType`/`async`/`bodyAudience` are attached only when given,
 * matching the absent-vs-undefined distinction the IR relies on.
 */
export function method(opts: {
    name: string;
    kind: IRMethod["kind"];
    params?: IRFunctionParam[];
    returnType?: IRType;
    async?: boolean;
    statements: IRStatement[];
    bodyAudience?: IRMethod["bodyAudience"];
    visibility: IRMethod["visibility"];
    source: IRSourceLocation;
}): IRMethod {
    const m: IRMethod = {
        name: opts.name,
        kind: opts.kind,
        params: opts.params ?? [],
        statements: opts.statements,
        visibility: opts.visibility,
        source: opts.source,
    };
    if (opts.returnType !== undefined) m.returnType = opts.returnType;
    if (opts.async !== undefined) m.async = opts.async;
    if (opts.bodyAudience !== undefined) m.bodyAudience = opts.bodyAudience;
    return m;
}

/**
 * Build an `IRFunctionDeclaration`. `typeParams`/`async` are attached only when given.
 */
export function funcDecl(opts: {
    name: string;
    typeParams?: string[];
    params?: IRFunctionParam[];
    returnType: IRType;
    async?: boolean;
    statements: IRStatement[];
    source: IRSourceLocation;
}): IRFunctionDeclaration {
    const d: IRFunctionDeclaration = {
        name: opts.name,
        params: opts.params ?? [],
        returnType: opts.returnType,
        statements: opts.statements,
        source: opts.source,
    };
    if (opts.typeParams !== undefined) d.typeParams = opts.typeParams;
    if (opts.async !== undefined) d.async = opts.async;
    return d;
}
