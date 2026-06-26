import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeReferenceValue,
    normalizeReferenceFieldValue,
    normalizeReferenceIds,
    coreFieldType,
} from "../src/reference.js";
import { USER_SCHEMA, Organization } from "./fixtures.js";

describe("normalizeReferenceValue", () => {
    it("passes a bare id string through", () => {
        assert.equal(normalizeReferenceValue("o1"), "o1");
    });
    it("collapses an { id } object to the bare id", () => {
        assert.equal(normalizeReferenceValue({ id: "o1" }), "o1");
    });
    it("collapses a full model instance to its id", () => {
        const org = new Organization({ id: "o1", name: "Acme", tier: "pro" });
        assert.equal(normalizeReferenceValue(org), "o1");
    });
    it("passes null and undefined through unchanged", () => {
        assert.equal(normalizeReferenceValue(null), null);
        assert.equal(normalizeReferenceValue(undefined), undefined);
    });
    it("passes a non-object primitive through", () => {
        assert.equal(normalizeReferenceValue(42), 42);
    });
    it("leaves an object without an `id` alone", () => {
        const v = { name: "Acme" };
        assert.equal(normalizeReferenceValue(v), v);
    });
});

describe("normalizeReferenceFieldValue", () => {
    it("normalizes scalar operator operands", () => {
        assert.deepEqual(normalizeReferenceFieldValue({ $eq: { id: "o1" } }), { $eq: "o1" });
        assert.deepEqual(normalizeReferenceFieldValue({ $ne: "o1" }), { $ne: "o1" });
    });
    it("normalizes array operator operands element-wise", () => {
        assert.deepEqual(
            normalizeReferenceFieldValue({ $in: [{ id: "o1" }, "o2"] }),
            { $in: ["o1", "o2"] },
        );
    });
    it("preserves operator objects already holding bare ids", () => {
        assert.deepEqual(
            normalizeReferenceFieldValue({ $in: ["o1", "o2"] }),
            { $in: ["o1", "o2"] },
        );
    });
    it("normalizes a bare array of references element-wise", () => {
        assert.deepEqual(normalizeReferenceFieldValue([{ id: "a" }, "b"]), ["a", "b"]);
    });
    it("collapses a scalar reference value", () => {
        assert.equal(normalizeReferenceFieldValue({ id: "o1" }), "o1");
    });
});

describe("normalizeReferenceIds", () => {
    it("collapses reference fields, leaves embedded and scalar fields untouched", () => {
        const address = { line1: "1 Main", city: "Springfield", postalCode: "12345" };
        const out = normalizeReferenceIds(
            {
                email: "a@b.com",
                organization: { id: "o1", name: "Acme" }, // reference -> id
                address, // embedded -> untouched
            },
            USER_SCHEMA,
        );
        assert.equal(out["organization"], "o1");
        assert.deepEqual(out["address"], address);
        assert.equal(out["email"], "a@b.com");
    });

    it("does not mutate the input record", () => {
        const input = { organization: { id: "o1" } };
        const out = normalizeReferenceIds(input, USER_SCHEMA);
        assert.deepEqual(input, { organization: { id: "o1" } }); // unchanged
        assert.equal(out["organization"], "o1");
        assert.notEqual(out, input);
    });

    it("ignores reference fields absent from the record", () => {
        const out = normalizeReferenceIds({ email: "a@b.com" }, USER_SCHEMA);
        assert.deepEqual(out, { email: "a@b.com" });
        assert.equal("organization" in out, false);
    });
});

describe("coreFieldType", () => {
    it("unwraps array element types", () => {
        assert.deepEqual(
            coreFieldType({ kind: "array", of: { kind: "reference", schema: "x" } }),
            { kind: "reference", schema: "x" },
        );
    });
    it("returns scalar types unchanged", () => {
        assert.deepEqual(coreFieldType({ kind: "string" }), { kind: "string" });
    });
});
