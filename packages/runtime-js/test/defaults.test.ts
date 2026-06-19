import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDefaults } from "../src/defaults.js";
import type { SchemaMetadata } from "../src/types.js";

const schema: SchemaMetadata = {
    name: "thing",
    sourceName: "Thing",
    fields: [
        { name: "id", type: { kind: "id" } },
        { name: "status", type: { kind: "string" }, default: { kind: "literal", value: "active" } },
        { name: "tags", type: { kind: "array", of: { kind: "string" } }, default: { kind: "literal", value: [] } },
        { name: "createdOn", type: { kind: "dateTime" }, default: { kind: "generator", name: "now" } },
        { name: "token", type: { kind: "id" }, default: { kind: "generator", name: "uuid" } },
        { name: "title", type: { kind: "string" } },
    ],
};

describe("applyDefaults", () => {
    it("fills absent keys with literal and generator defaults", () => {
        const data: Record<string, unknown> = { id: "1" };
        applyDefaults(schema, data);
        assert.equal(data["status"], "active");
        assert.deepEqual(data["tags"], []);
        assert.ok(data["createdOn"] instanceof Date);
        assert.equal(typeof data["token"], "string");
    });

    it("does not override provided values", () => {
        const data: Record<string, unknown> = { id: "1", status: "archived" };
        applyDefaults(schema, data);
        assert.equal(data["status"], "archived");
    });

    it("clones array literal defaults so instances don't share state", () => {
        const a: Record<string, unknown> = { id: "1" };
        const b: Record<string, unknown> = { id: "2" };
        applyDefaults(schema, a);
        applyDefaults(schema, b);
        (a["tags"] as unknown[]).push("x");
        assert.deepEqual(b["tags"], []);
    });

    it("leaves fields without a default untouched", () => {
        const data: Record<string, unknown> = { id: "1" };
        applyDefaults(schema, data);
        assert.equal("title" in data, false);
    });
});
