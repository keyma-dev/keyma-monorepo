import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRDiagnostic, IRExpression, IRStatement } from "@keyma/core/ir";
import { KEYMA014, KEYMA085 } from "../../src/frontend-ts/index.js";
import { build, lowerGetter, hasCode } from "./_helpers.js";

// Computed getter bodies lower through the shared portable engine (field-reference mode). These
// drive `lowerGetterBody` directly on a one-class source — the domain-neutral expression/statement
// subset, with no `@Schema`/`@Computed` in the loop (decorator-driven behavior lives in schema).

/** Lower a getter `g` on `class Foo { … }` and return its lowered statement list (asserting it lowered). */
function stmtsOf(src: string, getter = "g"): IRStatement[] {
    const b = build(src);
    const diags: IRDiagnostic[] = [];
    const stmts = lowerGetter(b, "Foo", getter, diags);
    assert.equal(diags.length, 0, JSON.stringify(diags));
    assert.ok(stmts, "getter did not lower");
    return stmts!;
}

/** The single `return <expr>` value of a getter `g`. */
function lowered(src: string, getter = "g"): IRExpression | undefined {
    const ret = stmtsOf(src, getter).find((s) => s.kind === "return");
    return ret && ret.kind === "return" ? (ret.value ?? undefined) : undefined;
}

/** Assert that lowering getter `g` fails with `code`. */
function rejects(src: string, code: string, getter = "g"): void {
    const b = build(src);
    const diags: IRDiagnostic[] = [];
    const stmts = lowerGetter(b, "Foo", getter, diags);
    assert.equal(stmts, null);
    assert.ok(hasCode(diags, code), JSON.stringify(diags));
}

/** Extract the first arrow argument of an intrinsic expression (e.g. a filter/map predicate). */
function firstArrow(expr: IRExpression | undefined): Extract<IRExpression, { kind: "arrow" }> | undefined {
    if (expr === undefined || expr.kind !== "intrinsic") return undefined;
    const a = expr.args[0];
    return a !== undefined && a.kind === "arrow" ? a : undefined;
}

// ─── KEYMA014 — unsupported getter body shapes ───────────────────────────────

describe("KEYMA014 — unsupported getter bodies", () => {
    it("rejects a free call expression", () => {
        rejects(`declare function compute(): string; class Foo { get g(): string { return compute(); } }`, KEYMA014);
    });
    it("rejects a method call on this", () => {
        rejects(`class Foo { private helper(): string { return "x"; } get g(): string { return this.helper(); } }`, KEYMA014);
    });
    it("rejects an array literal", () => {
        rejects(`class Foo { items!: string[]; get g(): string[] { return []; } }`, KEYMA014);
    });
    it("rejects a getter with no reachable return", () => {
        rejects(`class Foo { label!: string; get g(): void { void this.label; } }`, KEYMA014);
    });
});

// ─── Multi-statement portable bodies ─────────────────────────────────────────

describe("getters — multi-statement portable bodies", () => {
    it("lowers `const x = this.n; return x * 2`, resolving x as a local identifier", () => {
        assert.deepEqual(stmtsOf(`class Foo { n!: number; get doubled(): number { const x = this.n; return x * 2; } }`, "doubled"), [
            { kind: "const", name: "x", init: { kind: "field", name: "n" } },
            {
                kind: "return",
                value: {
                    kind: "binary", op: "*",
                    left: { kind: "identifier", name: "x" },
                    right: { kind: "literal", value: 2 },
                },
            },
        ]);
    });

    it("lowers an `if` with an early return", () => {
        assert.deepEqual(stmtsOf(`class Foo { n!: number; get sign(): string { if (this.n < 0) { return "neg"; } return "pos"; } }`, "sign"), [
            {
                kind: "if",
                condition: { kind: "binary", op: "<", left: { kind: "field", name: "n" }, right: { kind: "literal", value: 0 } },
                consequent: [{ kind: "return", value: { kind: "literal", value: "neg" } }],
            },
            { kind: "return", value: { kind: "literal", value: "pos" } },
        ]);
    });

    it("rejects a body whose only path has no reachable return (KEYMA014)", () => {
        rejects(`class Foo { n!: number; get sign(): number { if (this.n < 0) { const y = this.n; } } }`, KEYMA014, "sign");
    });

    it("resolves an arrow param as a local, not a field", () => {
        assert.deepEqual(lowered(`class Foo { tags!: string[]; get shortTags(): string[] { return this.tags.filter(t => t.length < 3); } }`, "shortTags"), {
            kind: "intrinsic", op: "array.filter",
            receiver: { kind: "field", name: "tags" },
            args: [{
                kind: "arrow", params: ["t"],
                body: {
                    kind: "binary", op: "<",
                    left: { kind: "intrinsic", op: "string.length", receiver: { kind: "identifier", name: "t" }, args: [] },
                    right: { kind: "literal", value: 3 },
                },
                returnType: { kind: "boolean" },
            }],
        });
    });
});

// ─── Expression kinds: new / date / typeof / object / string / array ─────────

describe("getters — supported portable expressions", () => {
    it("lowers a `new` expression", () => {
        assert.equal(lowered(`class Foo { get g(): Date { return new Date(); } }`)?.kind, "new");
    });

    it("lowers a Date accessor method to a date intrinsic", () => {
        assert.deepEqual(lowered(`class Foo { created!: Date; get year(): number { return this.created.getFullYear(); } }`, "year"), {
            kind: "intrinsic", op: "date.getFullYear", receiver: { kind: "field", name: "created" }, args: [],
        });
    });

    it("lowers static `Date.now()` to a date.now intrinsic (no receiver)", () => {
        assert.deepEqual(lowered(`class Foo { get t(): number { return Date.now(); } }`, "t"), {
            kind: "intrinsic", op: "date.now", receiver: null, args: [],
        });
    });

    it("KEYMA085 — rejects an unsupported Date method (a mutator)", () => {
        rejects(`class Foo { created!: Date; get t(): number { return this.created.setHours(0); } }`, KEYMA085, "t");
    });

    it("lowers an object literal", () => {
        assert.equal(lowered(`class Foo { get meta(): unknown { return { a: 1 }; } }`, "meta")?.kind, "object");
    });

    it("lowers a typeof expression", () => {
        assert.deepEqual(lowered(`class Foo { n!: number; get typeLabel(): string { return typeof this.n; } }`, "typeLabel"), {
            kind: "typeof", operand: { kind: "field", name: "n" },
        });
    });

    it("lowers a string method intrinsic", () => {
        assert.deepEqual(lowered(`class Foo { name!: string; get trimmed(): string { return this.name.trim(); } }`, "trimmed"), {
            kind: "intrinsic", op: "string.trim", receiver: { kind: "field", name: "name" }, args: [],
        });
    });

    it("lowers an array length intrinsic", () => {
        assert.deepEqual(lowered(`class Foo { tags!: string[]; get count(): number { return this.tags.length; } }`, "count"), {
            kind: "intrinsic", op: "array.length", receiver: { kind: "field", name: "tags" }, args: [],
        });
    });
});

// ─── Math / coercion / array map-some-every ──────────────────────────────────

describe("intrinsics — Math, coercion, array map/some/every", () => {
    it("lowers Math.round(...) to a free-standing math.round intrinsic", () => {
        assert.deepEqual(lowered(`class Foo { n!: number; get r(): number { return Math.round(this.n * 1.5); } }`, "r"), {
            kind: "intrinsic", op: "math.round", receiver: null,
            args: [{ kind: "binary", op: "*", left: { kind: "field", name: "n" }, right: { kind: "literal", value: 1.5 } }],
        });
    });

    it("lowers variadic Math.min(...) with multiple args", () => {
        assert.deepEqual(lowered(`class Foo { a!: number; b!: number; get m(): number { return Math.min(this.a, this.b, 0); } }`, "m"), {
            kind: "intrinsic", op: "math.min", receiver: null,
            args: [{ kind: "field", name: "a" }, { kind: "field", name: "b" }, { kind: "literal", value: 0 }],
        });
    });

    it("rejects an unsupported Math method (KEYMA085)", () => {
        rejects(`class Foo { n!: number; get h(): number { return Math.hypot(this.n, 1); } }`, KEYMA085, "h");
    });

    it("lowers String(x) to a to-string intrinsic", () => {
        assert.deepEqual(lowered(`class Foo { n!: number; get s(): string { return String(this.n); } }`, "s"), {
            kind: "intrinsic", op: "to-string", receiver: null, args: [{ kind: "field", name: "n" }],
        });
    });

    it("lowers Number(x) to a to-number intrinsic", () => {
        assert.deepEqual(lowered(`class Foo { s!: string; get n(): number { return Number(this.s); } }`, "n"), {
            kind: "intrinsic", op: "to-number", receiver: null, args: [{ kind: "field", name: "s" }],
        });
    });

    it("lowers array.map with an arrow whose param is a local identifier", () => {
        assert.deepEqual(lowered(`class Foo { tags!: string[]; get lengths(): number[] { return this.tags.map(t => t.length); } }`, "lengths"), {
            kind: "intrinsic", op: "array.map",
            receiver: { kind: "field", name: "tags" },
            args: [{
                kind: "arrow", params: ["t"],
                body: { kind: "intrinsic", op: "string.length", receiver: { kind: "identifier", name: "t" }, args: [] },
                returnType: { kind: "number" },
            }],
        });
    });

    it("lowers array.some / array.every", () => {
        const some = lowered(`class Foo { tags!: string[]; get anyLong(): boolean { return this.tags.some(t => t.length > 5); } }`, "anyLong");
        assert.equal((some as { op: string }).op, "array.some");
        const every = lowered(`class Foo { nums!: number[]; get allPos(): boolean { return this.nums.every(x => x > 0); } }`, "allPos");
        assert.equal((every as { op: string }).op, "array.every");
    });
});

// ─── Arrow block bodies + return-type inference ──────────────────────────────

describe("arrows — block bodies & return-type inference", () => {
    it("lowers a genuinely multi-statement block-arrow predicate to `statements`", () => {
        const arrow = firstArrow(lowered(`class Foo { tags!: string[]; get longTrimmed(): string[] { return this.tags.filter(x => { const t = x.trim(); return t.length > 3; }); } }`, "longTrimmed"));
        assert.ok(arrow !== undefined);
        assert.equal(arrow.body, undefined);
        assert.deepEqual(arrow.statements, [
            { kind: "const", name: "t", init: { kind: "intrinsic", op: "string.trim", receiver: { kind: "identifier", name: "x" }, args: [] } },
            {
                kind: "return",
                value: {
                    kind: "binary", op: ">",
                    left: { kind: "intrinsic", op: "string.length", receiver: { kind: "identifier", name: "t" }, args: [] },
                    right: { kind: "literal", value: 3 },
                },
            },
        ]);
        assert.deepEqual(arrow.returnType, { kind: "boolean" });
    });

    it("normalizes a single-return block arrow `{ return e }` down to a concise `body`", () => {
        const arrow = firstArrow(lowered(`class Foo { nums!: number[]; get pos(): number[] { return this.nums.filter(x => { return x > 0; }); } }`, "pos"));
        assert.ok(arrow !== undefined);
        assert.equal(arrow.statements, undefined);
        assert.deepEqual(arrow.body, { kind: "binary", op: ">", left: { kind: "identifier", name: "x" }, right: { kind: "literal", value: 0 } });
        assert.deepEqual(arrow.returnType, { kind: "boolean" });
    });

    it("infers a string return type (`s => s.toUpperCase()`)", () => {
        const arrow = firstArrow(lowered(`class Foo { tags!: string[]; get upper(): string[] { return this.tags.map(s => s.toUpperCase()); } }`, "upper"));
        assert.ok(arrow !== undefined);
        assert.deepEqual(arrow.returnType, { kind: "string" });
    });
});

// ─── Null literal ─────────────────────────────────────────────────────────────

describe("expression lowering — null literal", () => {
    it("lowers null literal to { kind: 'literal', value: null }", () => {
        assert.deepEqual(lowered(`class Foo { get nothing(): string | null { return null; } }`, "nothing"), { kind: "literal", value: null });
    });
});
