import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRDiagnostic } from "@keyma/core/ir";
import {
    lowerConstructor,
    lowerDestructor,
    KEYMA0206,
    KEYMA0207,
} from "../../src/frontend-ts/index.js";
import { build, methodCtx, findClass, classMethod, classCtor } from "./_helpers.js";

describe("008 — constructor", () => {
    it("lowers a constructor with typed params and `this.x =` assignments (no returnType)", () => {
        const b = build(`
            class Point {
                x: number;
                y: number;
                constructor(x: number, y: number) {
                    this.x = x;
                    this.y = y;
                }
            }
        `);
        const diags: IRDiagnostic[] = [];
        const ctor = lowerConstructor(classCtor(findClass(b.sf, "Point")), "public", methodCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.ok(ctor);
        assert.equal(ctor!.kind, "constructor");
        assert.equal(ctor!.name, "constructor");
        assert.equal("returnType" in ctor!, false);
        assert.deepEqual(ctor!.params, [
            { name: "x", type: { kind: "number" } },
            { name: "y", type: { kind: "number" } },
        ]);
        assert.equal(ctor!.statements.length, 2);
        const a0 = ctor!.statements[0]!;
        assert.equal(a0.kind, "assign");
        if (a0.kind !== "assign") return;
        assert.deepEqual(a0.target, { kind: "field", name: "x" });
        assert.deepEqual(a0.value, { kind: "identifier", name: "x" });
    });

    it("rejects an async constructor (KEYMA0207)", () => {
        const b = build(`class C { async constructor() {} }`);
        const diags: IRDiagnostic[] = [];
        const ctor = lowerConstructor(classCtor(findClass(b.sf, "C")), "public", methodCtx(b, diags));
        assert.equal(ctor, null);
        assert.ok(diags.some((d) => d.code === KEYMA0207), JSON.stringify(diags));
    });
});

describe("009 — destructor (method literally named `destructor`)", () => {
    it("lowers to a destructor with no params and no returnType", () => {
        const b = build(`
            class C {
                log: number;
                destructor(): void { this.log = 0; }
            }
        `);
        const diags: IRDiagnostic[] = [];
        const dtor = lowerDestructor(classMethod(findClass(b.sf, "C"), "destructor"), "public", methodCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.ok(dtor);
        assert.equal(dtor!.kind, "destructor");
        assert.equal(dtor!.name, "destructor");
        assert.deepEqual(dtor!.params, []);
        assert.equal("returnType" in dtor!, false);
        assert.equal(dtor!.statements[0]!.kind, "assign");
    });

    it("allows an absent return-type annotation (treated as void)", () => {
        const b = build(`class C { destructor() {} }`);
        const diags: IRDiagnostic[] = [];
        const dtor = lowerDestructor(classMethod(findClass(b.sf, "C"), "destructor"), "public", methodCtx(b, diags));
        assert.equal(diags.length, 0, JSON.stringify(diags));
        assert.ok(dtor);
        assert.equal(dtor!.kind, "destructor");
    });

    it("rejects a destructor with parameters (KEYMA0206)", () => {
        const b = build(`class C { destructor(x: number): void {} }`);
        const diags: IRDiagnostic[] = [];
        const dtor = lowerDestructor(classMethod(findClass(b.sf, "C"), "destructor"), "public", methodCtx(b, diags));
        assert.equal(dtor, null);
        assert.ok(diags.some((d) => d.code === KEYMA0206), JSON.stringify(diags));
    });

    it("rejects a destructor with a non-void return type (KEYMA0206)", () => {
        const b = build(`class C { destructor(): number { return 1; } }`);
        const diags: IRDiagnostic[] = [];
        const dtor = lowerDestructor(classMethod(findClass(b.sf, "C"), "destructor"), "public", methodCtx(b, diags));
        assert.equal(dtor, null);
        assert.ok(diags.some((d) => d.code === KEYMA0206), JSON.stringify(diags));
    });

    it("rejects an async destructor (KEYMA0206)", () => {
        const b = build(`class C { async destructor(): Promise<void> {} }`);
        const diags: IRDiagnostic[] = [];
        const dtor = lowerDestructor(classMethod(findClass(b.sf, "C"), "destructor"), "public", methodCtx(b, diags));
        assert.equal(dtor, null);
        assert.ok(diags.some((d) => d.code === KEYMA0206), JSON.stringify(diags));
    });
});
