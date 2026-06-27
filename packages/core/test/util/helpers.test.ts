import { test } from "node:test";
import assert from "node:assert/strict";
import type { IRExpression, IRStatement, IRMember, IRClassDeclaration, IRType, IRFunctionDeclaration } from "../../src/ir/index.js";
import { mkRaw, isRaw } from "../../src/util/emit-literal.js";
import { mkError, mkWarning } from "../../src/util/diagnostics.js";
import { filterVisible, filterVisibleFields, filterVisibleMethods } from "../../src/util/visibility.js";
import {
    unwrapArray,
    collectIdentifiers,
    collectStatementIdentifiers,
    collectRefTargets,
    collectFunctionRefs,
    reachableFunctions,
} from "../../src/util/ir-walk.js";

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
    } as unknown as IRClassDeclaration;
    assert.deepEqual(filterVisibleFields(schema, false).map((f) => f.name), ["a"]);
    assert.deepEqual(filterVisibleFields(schema, true).map((f) => f.name), ["a", "b"]);
    assert.deepEqual(filterVisibleMethods(schema, false), []);
    assert.deepEqual(filterVisibleMethods(schema, true).map((m) => m.name), ["m"]);
    assert.deepEqual(filterVisibleMethods({ fields: [] } as unknown as IRClassDeclaration, false), []); // undefined methods
});

// ─── IR traversal ──────────────────────────────────────────────────────────────

test("unwrapArray peels every array layer", () => {
    const embedded: IRType = { kind: "embedded", target: "Addr" };
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

test("collectIdentifiers walks an await operand", () => {
    const expr: IRExpression = { kind: "await", operand: { kind: "call", callee: { kind: "identifier", name: "fetch" }, args: [{ kind: "identifier", name: "url" }] } };
    const out = new Set<string>();
    collectIdentifiers(expr, out);
    assert.deepEqual([...out].sort(), ["fetch", "url"]);
});

test("collectStatementIdentifiers walks forOf / while / switch (and skips break/continue)", () => {
    const stmts: IRStatement[] = [
        { kind: "forOf", name: "item", iterable: { kind: "identifier", name: "xs" }, body: [
            { kind: "expression", expr: { kind: "call", callee: { kind: "identifier", name: "use" }, args: [{ kind: "identifier", name: "item" }] } },
        ] },
        { kind: "while", condition: { kind: "identifier", name: "go" }, body: [{ kind: "break" }, { kind: "continue" }] },
        { kind: "switch", discriminant: { kind: "identifier", name: "d" }, cases: [
            { test: { kind: "identifier", name: "k" }, body: [{ kind: "expression", expr: { kind: "identifier", name: "g" } }] },
            { test: null, body: [{ kind: "expression", expr: { kind: "await", operand: { kind: "identifier", name: "p" } } }] },
        ] },
    ];
    const out = new Set<string>();
    stmts.forEach((s) => collectStatementIdentifiers(s, out));
    assert.deepEqual([...out].sort(), ["d", "g", "go", "item", "k", "p", "use", "xs"]);
});

test("collectRefTargets gathers embedded/reference schema names through arrays", () => {
    const fields = [
        { type: { kind: "embedded", target: "Addr" } },
        { type: { kind: "array", of: { kind: "reference", target: "User" } } },
        { type: { kind: "string" } },
    ] as unknown as IRMember[];
    assert.deepEqual([...collectRefTargets(fields)].sort(), ["Addr", "User"]);
});

test("collectFunctionRefs returns only declared function names actually referenced", () => {
    const schema = {
        fields: [{ name: "createdAt", visibility: "public", default: { kind: "expression", expression: { kind: "call", callee: { kind: "identifier", name: "seedFn" }, args: [] } } }],
        methods: [{ name: "full", visibility: "public", statements: [{ kind: "return", value: { kind: "call", callee: { kind: "identifier", name: "helperFn" }, args: [] } }] }],
    } as unknown as IRClassDeclaration;
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

test("reachableFunctions takes the transitive closure from seeds, dropping undeclared seeds", () => {
    const fn = (name: string, ...refs: string[]): [string, IRFunctionDeclaration] => [name, {
        name,
        params: [],
        returnType: { kind: "json" },
        statements: refs.map((r) => ({ kind: "expression", expr: { kind: "call", callee: { kind: "identifier", name: r }, args: [] } })),
        source: { file: "f.ts", line: 1, column: 1 },
    } as unknown as IRFunctionDeclaration];

    const byName = new Map<string, IRFunctionDeclaration>([
        fn("a", "b"),       // a → b
        fn("b", "c"),       // b → c
        fn("c"),            // leaf
        fn("d", "a"),       // d → a, but nothing reaches d
        fn("serverOnly", "c"),
    ]);

    // Transitive closure from a client-style root: a, b, c — never d.
    assert.deepEqual([...reachableFunctions(["a"], byName)].sort(), ["a", "b", "c"]);
    // A seed naming no declaration (an undeclared/vendor-only ref) contributes nothing.
    assert.deepEqual([...reachableFunctions(["missing"], byName)], []);
    // The security gate: a function reachable only from the server root is absent when the
    // client root ("a") drives the closure, and present when "serverOnly" does.
    assert.ok(![...reachableFunctions(["a"], byName)].includes("serverOnly"));
    assert.deepEqual([...reachableFunctions(["serverOnly"], byName)].sort(), ["c", "serverOnly"]);
});
