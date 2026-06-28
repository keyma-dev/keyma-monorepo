import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    record, optional, external, instanceType, arrayType, typeVar,
    field, ident, literal, intrinsic,
    checkType, checkExpression,
    type IRExpression, type IRType,
} from "@keyma/core/ir";
import {
    collectIdentifiers, collectIntrinsicOps, collectTypeVarsInExpression, collectTypeVarsInType,
} from "@keyma/core/util";

// ─── `optional` type ─────────────────────────────────────────────────────────

describe("ir builder — optional type", () => {
    it("builds {kind:'optional', of} and validates valid-by-construction", () => {
        const t = optional(external("ValidationError"));
        assert.deepEqual(t, { kind: "optional", of: { kind: "external", name: "ValidationError" } });
        assert.deepEqual(checkType(t, "t"), []);
    });

    it("checkType recurses into `of` (a bad inner type is reported)", () => {
        const bad = { kind: "optional", of: { kind: "external", name: "" } };
        const errs = checkType(bad, "t");
        assert.equal(errs.length, 1);
        assert.equal(errs[0]!.path, "t.of.name");
    });

    it("collectTypeVarsInType walks the optional `of`", () => {
        const out = new Set<string>();
        collectTypeVarsInType(optional(typeVar("T")), out);
        assert.deepEqual([...out], ["T"]);
    });
});

// ─── `record` expression ───────────────────────────────────────────────────────

describe("ir builder — record expression", () => {
    it("builds a typed record from an external type and validates", () => {
        const r = record(external("ValidationError"), {
            field: literal("firstName"),
            code: literal("minLength"),
            message: literal("too short"),
        });
        assert.deepEqual(r, {
            kind: "record",
            type: { kind: "external", name: "ValidationError" },
            properties: [
                { key: "field", value: { kind: "literal", value: "firstName" } },
                { key: "code", value: { kind: "literal", value: "minLength" } },
                { key: "message", value: { kind: "literal", value: "too short" } },
            ],
        });
        assert.deepEqual(checkExpression(r, "e"), []);
    });

    it("accepts an instance-typed record", () => {
        const r = record(instanceType("ValidatorCtx"), { object: intrinsic("self", null, []) });
        assert.equal((r as { type: { kind: string } }).type.kind, "instance");
        assert.deepEqual(checkExpression(r, "e"), []);
    });

    it("throws when the type is neither external nor instance", () => {
        assert.throws(() => record(arrayType(external("X")), {}), /must be "external" or "instance"/);
    });

    it("checkExpression reports a malformed type / property value", () => {
        const badType: IRExpression = {
            kind: "record",
            type: { kind: "json" },
            properties: [],
        } as unknown as IRExpression;
        assert.ok(checkExpression(badType, "e").some((x) => x.path === "e.type.kind"));

        const badProp: IRExpression = {
            kind: "record",
            type: { kind: "external", name: "ValidationError" },
            properties: [{ key: "field", value: { kind: "binary" } }],
        } as unknown as IRExpression;
        assert.ok(checkExpression(badProp, "e").some((x) => x.path.startsWith("e.properties[0].value")));
    });
});

// ─── walkers see record property values ─────────────────────────────────────────

describe("ir walkers — record property values", () => {
    const rec = record(external("ValidatorCtx"), {
        object: ident("minLength"),
        code: intrinsic("self", null, []),
    });

    it("collectIdentifiers walks property values", () => {
        const out = new Set<string>();
        collectIdentifiers(rec, out);
        assert.ok(out.has("minLength"));
    });

    it("collectIntrinsicOps walks property values", () => {
        const out = new Set<string>();
        collectIntrinsicOps(rec, out);
        assert.ok(out.has("self"));
    });

    it("collectTypeVarsInExpression walks property values", () => {
        const out = new Set<string>();
        const r = record(external("X"), { a: ident("f", { T: typeVar("U") }) });
        collectTypeVarsInExpression(r, out);
        assert.deepEqual([...out], ["U"]);
    });
});
