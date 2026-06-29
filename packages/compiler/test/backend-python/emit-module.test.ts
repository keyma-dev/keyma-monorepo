import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
    IRClassDeclaration, IRMember, IRMethod, IRFunctionDeclaration, IRType, IRStatement, IRExpression,
} from "@keyma/core/ir";
import { emitModulePython, type ModuleContent, type ModuleEmitDeps } from "../../src/backend-python/emit-module.js";

const SRC = { file: "x.ts", line: 1, column: 1 };

// ─── IR builders ──────────────────────────────────────────────────────────────
function field(name: string, type: IRType = { kind: "string" }): IRMember {
    return { name, type, visibility: "public", readonly: false, required: true, source: SRC };
}
function method(over: Partial<IRMethod> & Pick<IRMethod, "kind" | "name">): IRMethod {
    return { params: [], statements: [], visibility: "public", source: SRC, ...over };
}
function cls(over: Partial<IRClassDeclaration> & Pick<IRClassDeclaration, "name" | "sourceName">): IRClassDeclaration {
    return { visibility: "public", fields: [], source: SRC, ...over };
}
function content(classes: IRClassDeclaration[], functions: IRFunctionDeclaration[] = []): ModuleContent {
    return { classes, functions };
}

const deps: ModuleEmitDeps = {
    includePrivate: true,
    bundle: "library",
    includeDefaults: false,
    classModule: new Map(),
    functionModule: new Map(),
    classNameByName: new Map(),
    functionDecls: new Map(),
    buildClassData: () => ({ name: "", sourceName: "", fields: [] }),
};

const assign = (fieldName: string, from: string): IRStatement => ({
    kind: "assign",
    target: { kind: "field", name: fieldName },
    value: { kind: "identifier", name: from },
});
const ret = (value: IRExpression | null): IRStatement => ({ kind: "return", value });

// ─── 008 hydration → from_value static factory ────────────────────────────────
describe("emitModulePython — from_value hydration (008)", () => {
    const user = cls({ name: "User", sourceName: "User", fields: [field("id", { kind: "id" }), field("name")] });
    const py = emitModulePython("src/user", content([user]), deps);

    it("hydrates via a `from_value` classmethod that bypasses __init__ with __new__", () => {
        assert.ok(py.includes("    @classmethod"), py);
        assert.ok(py.includes("    def from_value(cls, value: Dict[str, Any] = None):"), py);
        assert.ok(py.includes("        obj = cls.__new__(cls)"), py);
        assert.ok(py.includes("        obj._hydrate(value)"), py);
        assert.ok(py.includes("        return obj"), py);
    });

    it("assigns own fields inside _hydrate (not __init__)", () => {
        assert.ok(py.includes("    def _hydrate(self, value: Dict[str, Any] = None):"), py);
        assert.ok(py.includes('self.id'), py);
        assert.ok(py.includes('value.get("name")'), py);
        // No hydration constructor occupies __init__.
        assert.ok(!py.includes("def __init__(self, value"), py);
    });
});

// ─── 008 user-authored constructor coexists with from_value ───────────────────
describe("emitModulePython — user constructor (008)", () => {
    const point = cls({
        name: "Point", sourceName: "Point",
        fields: [field("x", { kind: "number" }), field("y", { kind: "number" })],
        methods: [method({
            kind: "constructor", name: "constructor",
            params: [{ name: "x", type: { kind: "number" } }, { name: "y", type: { kind: "number" } }],
            statements: [assign("x", "x"), assign("y", "y")],
        })],
    });

    it("emits the authored constructor as `def __init__(self, ...)`, coexisting with the factory", () => {
        const py = emitModulePython("src/point", content([point]), deps);
        assert.ok(py.includes("    def __init__(self, x, y):"), py);
        assert.ok(py.includes("self.x = x"), py);
        // The hydration factory still exists and stays out of __init__.
        assert.ok(py.includes("    def from_value(cls, value: Dict[str, Any] = None):"), py);
        assert.ok(py.includes("    def _hydrate(self, value: Dict[str, Any] = None):"), py);
    });
});

// ─── 009 destructor → __del__ ─────────────────────────────────────────────────
describe("emitModulePython — destructor (009)", () => {
    const res = cls({
        name: "Resource", sourceName: "Resource", fields: [field("id", { kind: "id" })],
        methods: [method({
            kind: "destructor", name: "destructor",
            statements: [{ kind: "expression", expr: { kind: "call", callee: { kind: "identifier", name: "cleanup" }, args: [] } }],
        })],
    });

    it("emits `def __del__(self):` with the body", () => {
        const py = emitModulePython("src/resource", content([res]), deps);
        assert.ok(py.includes("    def __del__(self):"), py);
        assert.ok(py.includes("cleanup()"), py);
    });
});

// ─── 010 async method / function ──────────────────────────────────────────────
describe("emitModulePython — async (010)", () => {
    it("prefixes an async method with `async def` and emits await in the body", () => {
        const loader = cls({
            name: "Loader", sourceName: "Loader", fields: [field("id", { kind: "id" })],
            methods: [method({
                kind: "method", name: "load", async: true, returnType: { kind: "string" },
                statements: [ret({ kind: "await", operand: { kind: "identifier", name: "p" } })],
            })],
        });
        const py = emitModulePython("src/loader", content([loader]), deps);
        assert.ok(py.includes("    async def load(self):"), py);
        assert.ok(py.includes("return await p"), py);
    });

    it("prefixes an async utility function with `async def`", () => {
        const fn: IRFunctionDeclaration = {
            name: "fetch_thing", params: [], returnType: { kind: "string" }, async: true,
            statements: [ret({ kind: "await", operand: { kind: "call", callee: { kind: "identifier", name: "g" }, args: [] } })],
            source: SRC,
        };
        const py = emitModulePython("src/util", content([], [fn]), deps);
        assert.ok(py.includes("async def fetch_thing():"), py);
        assert.ok(py.includes("return await g()"), py);
    });
});

// ─── bodyAudience — method body gated per bundle ──────────────────────────────
describe("emitModulePython — bodyAudience (method body gated per bundle)", () => {
    const model = cls({
        name: "Doc", sourceName: "Doc", fields: [field("title")],
        methods: [method({
            kind: "method", name: "format_save",
            statements: [assign("title", "scrubbed")],
            bodyAudience: { audiences: ["server", "library"], fallback: [] },
        })],
    });

    it("emits the real body for a server/library bundle", () => {
        for (const bundle of ["server", "library"] as const) {
            const py = emitModulePython("src/doc", content([model]), { ...deps, bundle });
            assert.ok(py.includes("    def format_save(self):"), py);
            assert.ok(py.includes("self.title = scrubbed"), py);
        }
    });

    it("emits the identity fallback (`pass`) for the client bundle, same signature", () => {
        const py = emitModulePython("src/doc", content([model]), { ...deps, bundle: "client" });
        assert.ok(py.includes("    def format_save(self):"), py);
        assert.ok(!py.includes("self.title = scrubbed"), py);
        // An empty gated body renders as a valid `pass`.
        const chunk = py.slice(py.indexOf("def format_save"));
        assert.ok(chunk.includes("pass"), chunk);
    });
});

// ─── statics — synthesized static members + audience gating ───────────────────
describe("emitModulePython — static members + audience", () => {
    const num = (v: number): IRExpression => ({ kind: "literal", value: v });
    const withStatics = cls({
        name: "Cfg",
        sourceName: "Cfg",
        fields: [field("id", { kind: "id" })],
        statics: [
            { name: "version", value: num(2) },
            {
                name: "shape",
                value: num(99),                       // full (server/library)
                audience: { audiences: ["server", "library"], fallback: num(1) },  // reduced (client)
            },
        ],
    });

    it("emits each static as `Class.<name> = <value>` for the bundle audience", () => {
        const py = emitModulePython("src/cfg", content([withStatics]), { ...deps, bundle: "library" });
        assert.ok(py.includes("Cfg.version = 2"), py);
        assert.ok(py.includes("Cfg.shape = 99"), py);
    });

    it("picks the audience fallback value for the client bundle", () => {
        const py = emitModulePython("src/cfg", content([withStatics]), { ...deps, bundle: "client" });
        assert.ok(py.includes("Cfg.version = 2"), py);
        assert.ok(py.includes("Cfg.shape = 1"), py);
        assert.ok(!py.includes("Cfg.shape = 99"), py);
    });
});

// ─── 008 from_value walks the inheritance chain ───────────────────────────────
describe("emitModulePython — from_value under real inheritance (008)", () => {
    it("a subclass _hydrate delegates to super()._hydrate", () => {
        const animal = cls({ name: "Animal", sourceName: "Animal", fields: [field("species")] });
        const dog = cls({ name: "Dog", sourceName: "Dog", extends: "Animal", fields: [field("breed")] });
        const py = emitModulePython("src/zoo", content([animal, dog]), deps);
        assert.ok(py.includes("class Dog(Animal):"), py);
        assert.ok(py.includes("        super()._hydrate(value)"), py);
        // The root class does not chain to a non-existent base.
        const animalChunk = py.slice(py.indexOf("class Animal"), py.indexOf("class Dog"));
        assert.ok(!animalChunk.includes("super()._hydrate"), animalChunk);
    });
});
