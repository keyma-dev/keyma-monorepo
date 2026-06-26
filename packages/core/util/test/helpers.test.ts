import { test } from "node:test";
import assert from "node:assert/strict";
import type { IRExpression, IRStatement, IRField, IRSchema, IRType } from "../../ir/src/index.js";
import { mkRaw, isRaw } from "../src/emit-literal.js";
import { mkError, mkWarning } from "../src/diagnostics.js";
import { filterVisible, filterVisibleFields, filterVisibleMethods } from "../src/visibility.js";
import {
    unwrapArray,
    collectIdentifiers,
    collectStatementIdentifiers,
    collectRefTargets,
    collectFunctionRefs,
} from "../src/ir-walk.js";

// ─── emit-literal markers ──────────────────────────────────────────────────────

test("raw / isRaw round-trip and reject non-markers", () => {
    assert.deepEqual(mkRaw("minLength(2)"), { __raw: "minLength(2)" });
    assert.equal(isRaw(mkRaw("x")), true);
    assert.equal(isRaw({ __raw: 1 }), false);
    assert.equal(isRaw({}), false);
    assert.equal(isRaw("x"), false);
    assert.equal(isRaw(null), false);
});

// ─── diagnostics ───────────────────────────────────────────────────────────────

test("mkError / mkWarning attach severity and an optional source", () => {
    assert.deepEqual(mkError("KEYMA001", "boom"), { code: "KEYMA001", severity: "error", message: "boom" });
    assert.deepEqual(mkWarning("KEYMA002", "careful"), { code: "KEYMA002", severity: "warning", message: "careful" });
    const src = { file: "a.ts", line: 3, column: 1 };
    assert.deepEqual(mkError("KEYMA003", "loc", src), { code: "KEYMA003", severity: "error", message: "loc", source: src });
});

// ─── visibility ────────────────────────────────────────────────────────────────

test("visible filters public-only, or returns a fresh copy of all", () => {
    const items = [{ visibility: "public" }, { visibility: "private" }, { visibility: "public" }];
    assert.deepEqual(filterVisible(items, false), [{ visibility: "public" }, { visibility: "public" }]);
    const all = filterVisible(items, true);
    assert.deepEqual(all, items);
    assert.notEqual(all, items); // a copy, never the same reference
});

test("visibleFields / visibleMethods read schema shape (methods may be absent)", () => {
    const schema = {
        fields: [{ name: "a", visibility: "public" }, { name: "b", visibility: "private" }],
        methods: [{ name: "m", visibility: "private" }],
    } as unknown as IRSchema;
    assert.deepEqual(filterVisibleFields(schema, false).map((f) => f.name), ["a"]);
    assert.deepEqual(filterVisibleFields(schema, true).map((f) => f.name), ["a", "b"]);
    assert.deepEqual(filterVisibleMethods(schema, false), []);
    assert.deepEqual(filterVisibleMethods(schema, true).map((m) => m.name), ["m"]);
    assert.deepEqual(filterVisibleMethods({ fields: [] } as unknown as IRSchema, false), []); // undefined methods
});

// ─── IR traversal ──────────────────────────────────────────────────────────────

test("unwrapArray peels every array layer", () => {
    const embedded: IRType = { kind: "embedded", schema: "Addr" };
    const nested: IRType = { kind: "array", of: { kind: "array", of: embedded } };
    assert.deepEqual(unwrapArray(nested), embedded);
    assert.deepEqual(unwrapArray(embedded), embedded);
});

test("collectIdentifiers walks the whole expression tree", () => {
    // f(a.b, g(c))  →  { f, a, g, c }   (member names like `b` are not identifiers)
    const expr: IRExpression = {
        kind: "call",
        callee: { kind: "identifier", name: "f" },
        args: [
            { kind: "member", object: { kind: "identifier", name: "a" }, member: "b" },
            { kind: "call", callee: { kind: "identifier", name: "g" }, args: [{ kind: "identifier", name: "c" }] },
        ],
    };
    const out = new Set<string>();
    collectIdentifiers(expr, out);
    assert.deepEqual([...out].sort(), ["a", "c", "f", "g"]);
});

test("collectStatementIdentifiers walks statements and nested expressions", () => {
    const stmt: IRStatement = { kind: "return", value: { kind: "call", callee: { kind: "identifier", name: "h" }, args: [{ kind: "identifier", name: "x" }] } };
    const out = new Set<string>();
    collectStatementIdentifiers(stmt, out);
    assert.deepEqual([...out].sort(), ["h", "x"]);
});

test("collectRefTargets gathers embedded/reference schema names through arrays", () => {
    const fields = [
        { type: { kind: "embedded", schema: "Addr" } },
        { type: { kind: "array", of: { kind: "reference", schema: "User" } } },
        { type: { kind: "string" } },
    ] as unknown as IRField[];
    assert.deepEqual([...collectRefTargets(fields)].sort(), ["Addr", "User"]);
});

test("collectFunctionRefs returns only declared function names actually referenced", () => {
    const schema = {
        fields: [{ name: "createdAt", visibility: "public", default: { kind: "expression", expression: { kind: "call", callee: { kind: "identifier", name: "seedFn" }, args: [] } } }],
        methods: [{ name: "full", visibility: "public", statements: [{ kind: "return", value: { kind: "call", callee: { kind: "identifier", name: "helperFn" }, args: [] } }] }],
    } as unknown as IRSchema;
    const functionNames = new Set(["seedFn", "helperFn", "unused"]);

    assert.deepEqual(
        [...collectFunctionRefs([schema], { includePrivate: true, includeDefaults: true, functionNames })].sort(),
        ["helperFn", "seedFn"],
    );
    // With defaults excluded, only the method-body reference survives.
    assert.deepEqual(
        [...collectFunctionRefs([schema], { includePrivate: true, includeDefaults: false, functionNames })],
        ["helperFn"],
    );
});
