import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
    IRClassDeclaration, IRMember, IRMethod, IRFunctionDeclaration, IRType, IRStatement, IRExpression,
} from "@keyma/core/ir";
import {
    emitModuleJs, emitModuleDts, type ModuleContent, type ModuleEmitDeps,
} from "../../src/backend-js/emit-module.js";

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

// Minimal deps — buildClassData returns an empty literal; the class-shell emission is what's
// under test, so the domain metadata object is irrelevant here.
const deps: ModuleEmitDeps = {
    includePrivate: true,
    bundle: "library",
    includeDefaults: false,
    classModule: new Map(),
    functionModule: new Map(),
    embeddedTypeNames: new Map(),
    functionDecls: new Map(),
    buildClassData: () => ({}),
};

const assign = (fieldName: string, from: string): IRStatement => ({
    kind: "assign",
    target: { kind: "field", name: fieldName },
    value: { kind: "identifier", name: from },
});
const ret = (value: IRExpression | null): IRStatement => ({ kind: "return", value });

// ─── 008 hydration → static fromValue ─────────────────────────────────────────
describe("emitModuleJs — fromValue hydration (008)", () => {
    const user = cls({
        name: "User",
        sourceName: "User",
        fields: [field("id", { kind: "id" }), field("name")],
    });
    const js = emitModuleJs("src/user", content([user]), deps);

    it("hydrates via a static fromValue factory, not a constructor", () => {
        assert.ok(js.includes("static fromValue(value) {"), js);
        assert.ok(js.includes("const instance = Object.create(this.prototype);"), js);
        assert.ok(js.includes("instance._hydrate(value);"), js);
        assert.ok(js.includes("return instance;"), js);
    });

    it("assigns own fields inside _hydrate", () => {
        assert.ok(js.includes("_hydrate(value) {"), js);
        assert.ok(js.includes("this.id = value.id;"), js);
        assert.ok(js.includes("this.name = value.name;"), js);
    });

    it("emits NO `new Class(plain)`-style hydration constructor", () => {
        assert.ok(!js.includes("constructor(value) {"), js);
    });

    it(".d.ts replaces the hydration constructor with a static fromValue signature", () => {
        const dts = emitModuleDts("src/user", content([user]), deps);
        assert.match(dts, /static fromValue\(value\?: \{[^}]*\}\): User;/);
        assert.ok(!dts.includes("constructor(value?: {"), dts);
    });
});

// ─── 008 user-authored constructor coexists ───────────────────────────────────
describe("emitModuleJs — user constructor (008)", () => {
    const point = cls({
        name: "Point",
        sourceName: "Point",
        fields: [field("x", { kind: "number" }), field("y", { kind: "number" })],
        methods: [
            method({
                kind: "constructor",
                name: "constructor",
                params: [
                    { name: "x", type: { kind: "number" } },
                    { name: "y", type: { kind: "number" } },
                ],
                statements: [assign("x", "x"), assign("y", "y")],
            }),
        ],
    });

    it("emits the authored constructor as a real `constructor(params)`", () => {
        const js = emitModuleJs("src/point", content([point]), deps);
        assert.ok(js.includes("constructor(x, y) {"), js);
        assert.ok(js.includes("this.x = x;"), js);
        // The static factory still coexists.
        assert.ok(js.includes("static fromValue(value) {"), js);
    });

    it(".d.ts declares both the user constructor and the static fromValue", () => {
        const dts = emitModuleDts("src/point", content([point]), deps);
        assert.ok(dts.includes("constructor(x: number, y: number);"), dts);
        assert.match(dts, /static fromValue\(value\?: \{[^}]*\}\): Point;/);
    });
});

// ─── 009 destructor ───────────────────────────────────────────────────────────
describe("emitModuleJs — destructor (009)", () => {
    const res = cls({
        name: "Resource",
        sourceName: "Resource",
        fields: [field("id", { kind: "id" })],
        methods: [
            method({
                kind: "destructor",
                name: "destructor",
                statements: [{ kind: "expression", expr: { kind: "call", callee: { kind: "identifier", name: "cleanup" }, args: [] } }],
            }),
        ],
    });

    it("emits a plain destructor() method (no Symbol.dispose)", () => {
        const js = emitModuleJs("src/resource", content([res]), deps);
        assert.ok(js.includes("destructor() {"), js);
        assert.ok(js.includes("cleanup();"), js);
        assert.ok(!js.includes("Symbol.dispose"), js);
    });

    it(".d.ts declares destructor(): void", () => {
        const dts = emitModuleDts("src/resource", content([res]), deps);
        assert.ok(dts.includes("destructor(): void;"), dts);
    });
});

// ─── 010 async method / function ──────────────────────────────────────────────
describe("emitModuleJs — async (010)", () => {
    const loader = cls({
        name: "Loader",
        sourceName: "Loader",
        fields: [field("id", { kind: "id" })],
        methods: [
            method({
                kind: "method",
                name: "load",
                async: true,
                returnType: { kind: "string" },
                statements: [ret({ kind: "await", operand: { kind: "identifier", name: "p" } })],
            }),
        ],
    });

    it("prefixes an async method and emits await in the body", () => {
        const js = emitModuleJs("src/loader", content([loader]), deps);
        assert.ok(js.includes("async load() {"), js);
        assert.ok(js.includes("return await p;"), js);
    });

    it(".d.ts re-wraps the unwrapped return type in Promise<…>", () => {
        const dts = emitModuleDts("src/loader", content([loader]), deps);
        assert.ok(dts.includes("load(): Promise<string>;"), dts);
    });

    it("prefixes an async utility function and wraps its .d.ts return type", () => {
        const fn: IRFunctionDeclaration = {
            name: "fetchThing",
            params: [],
            returnType: { kind: "string" },
            async: true,
            statements: [ret({ kind: "await", operand: { kind: "call", callee: { kind: "identifier", name: "g" }, args: [] } })],
            source: SRC,
        };
        const js = emitModuleJs("src/util", content([], [fn]), deps);
        assert.ok(js.includes("export async function fetchThing()"), js);
        assert.ok(js.includes("return await g();"), js);

        const dts = emitModuleDts("src/util", content([], [fn]), deps);
        assert.ok(dts.includes("export declare function fetchThing(): Promise<string>;"), dts);
    });
});

// ─── bodyAudience — method body gated per bundle ──────────────────────────────
describe("emitModuleJs — bodyAudience (method body gated per bundle)", () => {
    // A `formatSave`-style method: the real body runs only server/library; the client gets the
    // domain-provided identity (no-op) fallback. The SIGNATURE is uniform across bundles.
    const model = cls({
        name: "Doc",
        sourceName: "Doc",
        fields: [field("title")],
        methods: [
            method({
                kind: "method",
                name: "formatSave",
                statements: [assign("title", "scrubbed")],
                bodyAudience: { audiences: ["server", "library"], fallback: [] },
            }),
        ],
    });

    it("emits the real body for a server/library bundle", () => {
        for (const bundle of ["server", "library"] as const) {
            const js = emitModuleJs("src/doc", content([model]), { ...deps, bundle });
            assert.ok(js.includes("formatSave() {"), js);
            assert.ok(js.includes("this.title = scrubbed;"), js);
        }
    });

    it("emits the identity fallback (no body) for the client bundle, same signature", () => {
        const js = emitModuleJs("src/doc", content([model]), { ...deps, bundle: "client" });
        assert.ok(js.includes("formatSave() {"), js);
        assert.ok(!js.includes("this.title = scrubbed;"), js);
    });
});

// ─── statics — synthesized static members + audience gating ───────────────────
describe("emitModuleJs — static members + audience", () => {
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
        const js = emitModuleJs("src/cfg", content([withStatics]), { ...deps, bundle: "library" });
        assert.ok(js.includes("Cfg.version = 2;"), js);
        assert.ok(js.includes("Cfg.shape = 99;"), js);
    });

    it("picks the audience fallback value for the client bundle", () => {
        const js = emitModuleJs("src/cfg", content([withStatics]), { ...deps, bundle: "client" });
        assert.ok(js.includes("Cfg.version = 2;"), js);
        assert.ok(js.includes("Cfg.shape = 1;"), js);
        assert.ok(!js.includes("Cfg.shape = 99;"), js);
    });

    it(".d.ts declares each static (type when given, else unknown)", () => {
        const typed = cls({
            name: "Cfg",
            sourceName: "Cfg",
            fields: [field("id", { kind: "id" })],
            statics: [{ name: "version", value: num(2), type: { kind: "number" } }],
        });
        const dts = emitModuleDts("src/cfg", content([typed]), deps);
        assert.ok(dts.includes("static readonly version: number;"), dts);
    });
});

// ─── 008 fromValue walks the inheritance chain ────────────────────────────────
describe("emitModuleJs — fromValue under real inheritance (008)", () => {
    it("a subclass _hydrate delegates to super._hydrate", () => {
        const animal = cls({ name: "Animal", sourceName: "Animal", fields: [field("species")] });
        const dog = cls({ name: "Dog", sourceName: "Dog", extends: "Animal", fields: [field("breed")] });
        const js = emitModuleJs("src/zoo", content([animal, dog]), deps);
        assert.ok(js.includes("export class Dog extends Animal {"), js);
        assert.ok(js.includes("super._hydrate(value);"), js);
        // The root class does not call super._hydrate.
        const animalChunk = js.slice(js.indexOf("export class Animal"), js.indexOf("export class Dog"));
        assert.ok(!animalChunk.includes("super._hydrate"), animalChunk);
    });
});
