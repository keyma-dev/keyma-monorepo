import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyDefaults } from "../src/defaults.js";
import type { SchemaMetadata } from "../src/types.js";

// `applyDefaults` is now attached directly to the frozen metadata (re-emitted by the
// compiler), filling absent expression-default fields. Literal defaults ride in the
// field metadata and are applied generically by the runtime.
const baseFields: SchemaMetadata["fields"] = [
    { name: "id", type: { kind: "id" } },
    { name: "status", type: { kind: "string" }, default: { kind: "literal", value: "active" } },
    { name: "tags", type: { kind: "array", of: { kind: "string" } }, default: { kind: "literal", value: [] } },
    { name: "createdOn", type: { kind: "dateTime" }, default: { kind: "expression", expression: {} } },
    { name: "title", type: { kind: "string" } },
];

const schema: SchemaMetadata = {
    name: "thing",
    sourceName: "Thing",
    fields: baseFields,
    applyDefaults: (value) => {
        if (value["createdOn"] === undefined) value["createdOn"] = new Date();
    },
};

const schemaNoExprDefaults: SchemaMetadata = { name: "thing", sourceName: "Thing", fields: baseFields };

describe("applyDefaults", () => {
    it("fills absent keys with literal defaults and runs the schema's applyDefaults", () => {
        const data: Record<string, unknown> = { id: "1" };
        applyDefaults(schema, data);
        assert.equal(data["status"], "active");
        assert.deepEqual(data["tags"], []);
        assert.ok(data["createdOn"] instanceof Date);
    });

    it("does not override provided values (literal or expression)", () => {
        const provided = new Date(0);
        const data: Record<string, unknown> = { id: "1", status: "archived", createdOn: provided };
        applyDefaults(schema, data);
        assert.equal(data["status"], "archived");
        assert.equal(data["createdOn"], provided);
    });

    it("applies only literal defaults when the schema has no applyDefaults", () => {
        const data: Record<string, unknown> = { id: "1" };
        applyDefaults(schemaNoExprDefaults, data);
        assert.equal(data["status"], "active");
        assert.equal("createdOn" in data, false);
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

    it("applies inherited literal defaults and runs base applyDefaults parent-first", () => {
        const order: string[] = [];
        const base: SchemaMetadata = {
            name: "base", sourceName: "Base",
            fields: [{ name: "kind", type: { kind: "string" }, default: { kind: "literal", value: "node" } }],
            applyDefaults: () => { order.push("base"); },
        };
        const leaf: SchemaMetadata = {
            name: "leaf", sourceName: "Leaf", base,
            fields: [{ name: "status", type: { kind: "string" }, default: { kind: "literal", value: "active" } }],
            applyDefaults: () => { order.push("leaf"); },
        };
        const data: Record<string, unknown> = {};
        applyDefaults(leaf, data);
        assert.equal(data["kind"], "node");
        assert.equal(data["status"], "active");
        assert.deepEqual(order, ["base", "leaf"]);
    });
});
