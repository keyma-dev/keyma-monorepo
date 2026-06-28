import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
    IRStatement,
    IRSourceLocation,
    IRClassDeclaration,
    IRFunctionDeclaration,
    IRMethod,
    IRDiagnostic,
} from "@keyma/core/ir";
import { stmtToCpp, plainReturn } from "../../src/backend-cpp/emit-validators.js";
import { emitModuleCpp, CPP_ASYNC_DIAGNOSTIC, type ModuleEmitDeps } from "../../src/backend-cpp/emit-module.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const loc = (): IRSourceLocation => ({ file: "src/widget.ts", line: 1, column: 1 });

/** `<callee>()` expression-statement helper. */
const callStmt = (callee: string): IRStatement => ({
    kind: "expression",
    expr: { kind: "call", callee: { kind: "identifier", name: callee }, args: [] },
});

const MODULE_REF = "models/widget";

/** A complete-but-minimal ModuleEmitDeps for exercising the module emitter in isolation. */
function makeDeps(classes: readonly IRClassDeclaration[]): ModuleEmitDeps {
    return {
        includePrivate: true,
        bundle: "library",
        includeDefaults: false,
        binary: false,
        nsRoot: "app",
        classBySourceName: new Map(classes.map((s) => [s.sourceName, s])),
        classModule: new Map(classes.map((s) => [s.sourceName, MODULE_REF])),
        classNameByName: new Map(classes.map((s) => [s.name, s.sourceName])),
        cppTypeByName: new Map(classes.map((s) => [s.name, s.sourceName])),
        enumTypeByName: new Map(),
        enumModuleByName: new Map(),
        idFieldByName: new Map(),
        referenceTargetNames: new Set(),
        functionDecls: new Map(),
        functionNames: new Set(),
        functionModule: new Map(),
        runtimeInclude: "<keyma/runtime.hpp>",
        buildClassData: (cls) => ({
            name: cls.name,
            sourceName: cls.sourceName,
            refs: [],
            indexes: [],
            fields: [],
        }),
    };
}

// ─── 011: loops ────────────────────────────────────────────────────────────────

describe("stmtToCpp — loops (issue 011)", () => {
    it("forOf → range-for with const auto&", () => {
        const out = stmtToCpp(
            {
                kind: "forOf",
                name: "item",
                iterable: { kind: "identifier", name: "items" },
                body: [callStmt("use")],
            },
            "",
            plainReturn,
        );
        assert.match(out, /for \(const auto& item : items\) \{/);
        assert.ok(out.includes("use();"));
        assert.ok(out.trimEnd().endsWith("}"));
    });

    it("while → native while", () => {
        const out = stmtToCpp(
            { kind: "while", condition: { kind: "identifier", name: "go" }, body: [{ kind: "break" }] },
            "",
            plainReturn,
        );
        assert.match(out, /while \(go\) \{/);
        assert.ok(out.includes("break;"));
    });

    it("break / continue emit natively", () => {
        assert.equal(stmtToCpp({ kind: "break" }, "", plainReturn), "break;");
        assert.equal(stmtToCpp({ kind: "continue" }, "", plainReturn), "continue;");
        assert.equal(stmtToCpp({ kind: "continue" }, "    ", plainReturn), "    continue;");
    });
});

// ─── 012: switch ─────────────────────────────────────────────────────────────

describe("stmtToCpp — switch (issue 012)", () => {
    it("integral discriminant → native switch with [[fallthrough]]", () => {
        const out = stmtToCpp(
            {
                kind: "switch",
                discriminant: { kind: "identifier", name: "code" },
                cases: [
                    // non-empty, no terminating break → falls through (gets [[fallthrough]])
                    { test: { kind: "literal", value: 1 }, body: [callStmt("a")] },
                    // terminating break → no [[fallthrough]]
                    { test: { kind: "literal", value: 2 }, body: [callStmt("b"), { kind: "break" }] },
                    // default
                    { test: null, body: [callStmt("d")] },
                ],
            },
            "",
            plainReturn,
        );
        assert.match(out, /switch \(code\) \{/);
        assert.ok(out.includes("case 1: {"));
        assert.ok(out.includes("[[fallthrough]];"), "non-terminating case should get [[fallthrough]]");
        assert.ok(out.includes("case 2: {"));
        assert.ok(out.includes("default: {"));
        assert.ok(out.includes("a();"));
        assert.ok(out.includes("b();"));
        // The native form must NOT degrade to an if/else chain.
        assert.ok(!out.includes("if (code =="));
        // The terminating case keeps exactly one [[fallthrough]] (only case 1 falls through).
        assert.equal(out.split("[[fallthrough]];").length - 1, 1);
    });

    it("integral switch — stacked empty labels fall through with no marker", () => {
        const out = stmtToCpp(
            {
                kind: "switch",
                discriminant: { kind: "identifier", name: "code" },
                cases: [
                    { test: { kind: "literal", value: 1 }, body: [] },
                    { test: { kind: "literal", value: 2 }, body: [callStmt("a"), { kind: "break" }] },
                ],
            },
            "",
            plainReturn,
        );
        assert.match(out, /case 1:\s*\n\s*case 2: \{/);
        // An empty stacked label gets no braces and no fallthrough marker.
        assert.ok(!out.includes("[[fallthrough]]"));
    });

    it("string discriminant → if / else-if chain (break stripped)", () => {
        const out = stmtToCpp(
            {
                kind: "switch",
                discriminant: { kind: "identifier", name: "name" },
                cases: [
                    { test: { kind: "literal", value: "a" }, body: [callStmt("x"), { kind: "break" }] },
                    { test: { kind: "literal", value: "b" }, body: [callStmt("y"), { kind: "break" }] },
                    { test: null, body: [callStmt("z")] },
                ],
            },
            "",
            plainReturn,
        );
        assert.match(out, /if \(name == "a"\) \{/);
        assert.match(out, /\} else if \(name == "b"\) \{/);
        assert.match(out, /\} else \{/);
        assert.ok(out.includes("x();"));
        assert.ok(out.includes("z();"));
        // No native switch and the case-terminating `break;` is illegal in an if-body → stripped.
        assert.ok(!out.includes("switch (name)"));
        assert.ok(!out.includes("break;"));
    });

    it("string switch — stacked empty labels OR-join into one condition", () => {
        const out = stmtToCpp(
            {
                kind: "switch",
                discriminant: { kind: "identifier", name: "name" },
                cases: [
                    { test: { kind: "literal", value: "a" }, body: [] },
                    { test: { kind: "literal", value: "b" }, body: [callStmt("x"), { kind: "break" }] },
                ],
            },
            "",
            plainReturn,
        );
        assert.match(out, /if \(name == "a" \|\| name == "b"\) \{/);
    });
});

// ─── 008/009: constructor + destructor ────────────────────────────────────────

describe("emitModuleCpp — constructor & destructor (issues 008/009)", () => {
    const schema: IRClassDeclaration = {
        name: "Widget",
        sourceName: "Widget",
        visibility: "public",
        fields: [
            {
                name: "size",
                type: { kind: "integer" },
                visibility: "public",
                readonly: false,
                required: true,
                source: loc(),
            },
        ],
        methods: [
            {
                kind: "constructor",
                name: "constructor",
                params: [{ name: "size", type: { kind: "integer" } }],
                statements: [
                    { kind: "assign", target: { kind: "field", name: "size" }, value: { kind: "identifier", name: "size" } },
                ],
                visibility: "public",
                source: loc(),
            },
            {
                kind: "destructor",
                name: "destructor",
                params: [],
                statements: [callStmt("cleanup")],
                visibility: "public",
                source: loc(),
            },
        ],
        source: loc(),
    };

    it("emits a user constructor T(params) { body } that coexists with from_value", () => {
        const content = emitModuleCpp(MODULE_REF, [schema], [], [], makeDeps([schema]));
        // User constructor: `Widget(std::int64_t size) {`
        assert.match(content, /\bWidget\(std::int64_t size\) \{/);
        assert.ok(content.includes("this->size = size;"));
        // Hydration factory stays — no collision.
        assert.ok(content.includes("from_value"));
    });

    it("emits a destructor ~T() { body }", () => {
        const content = emitModuleCpp(MODULE_REF, [schema], [], [], makeDeps([schema]));
        assert.match(content, /~Widget\(\) \{/);
        assert.ok(content.includes("cleanup();"));
    });
});

// ─── 010: async → diagnostic, never silent sync degradation ───────────────────

describe("emitModuleCpp — async diagnostic (issue 010)", () => {
    it("async function → diagnostic, body omitted (no silent sync emission)", () => {
        const asyncFn: IRFunctionDeclaration = {
            name: "loadAll",
            params: [],
            returnType: { kind: "string" },
            async: true,
            statements: [
                {
                    kind: "return",
                    value: { kind: "await", operand: { kind: "call", callee: { kind: "identifier", name: "remote" }, args: [] } },
                },
            ],
            source: loc(),
        };
        const sink: IRDiagnostic[] = [];
        const content = emitModuleCpp(MODULE_REF, [], [], [asyncFn], makeDeps([]), sink);

        assert.equal(sink.length, 1);
        assert.equal(sink[0]!.code, CPP_ASYNC_DIAGNOSTIC);
        assert.equal(sink[0]!.severity, "error");
        assert.match(sink[0]!.message, /async bodies not yet C\+\+-emittable/);
        // The async body is NOT silently degraded to a synchronous function.
        assert.ok(!content.includes("loadAll"), "async function must be omitted, not emitted");
        assert.ok(!content.includes("remote("), "the awaited body must not be emitted");
    });

    it("async method → diagnostic, member omitted", () => {
        const asyncMethod: IRMethod = {
            kind: "method",
            name: "fetch",
            async: true,
            params: [],
            returnType: { kind: "string" },
            statements: [
                {
                    kind: "return",
                    value: { kind: "await", operand: { kind: "call", callee: { kind: "identifier", name: "net" }, args: [] } },
                },
            ],
            visibility: "public",
            source: loc(),
        };
        const schema: IRClassDeclaration = {
            name: "Svc",
            sourceName: "Svc",
            visibility: "public",
            fields: [],
            methods: [asyncMethod],
            source: loc(),
        };
        const sink: IRDiagnostic[] = [];
        const content = emitModuleCpp(MODULE_REF, [schema], [], [], makeDeps([schema]), sink);

        assert.equal(sink.length, 1);
        assert.equal(sink[0]!.code, CPP_ASYNC_DIAGNOSTIC);
        assert.ok(!content.includes("fetch"), "async method must be omitted");
        assert.ok(!content.includes("net("), "the awaited body must not be emitted");
    });
});
