import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serialize } from "../src/serialize.js";
import type { SchemaMetadata } from "../src/types.js";

const SCHEMA: SchemaMetadata = {
    name: "user",
    sourceName: "User",
    fields: [
        { name: "id", type: { kind: "id" }, readonly: true },
        { name: "email", type: { kind: "string" } },
        { name: "secret", type: { kind: "string" }, visibility: "private", required: false },
        { name: "scratch", type: { kind: "string" }, required: false, ephemeral: true },
    ],
};

describe("serialize", () => {
    it("client target strips private fields", () => {
        const out = serialize(
            SCHEMA,
            { id: "u1", email: "a@b.com", secret: "x", scratch: "tmp" },
            { target: "client" },
        );
        assert.deepEqual(out, { id: "u1", email: "a@b.com", scratch: "tmp" });
    });

    it("server target keeps all fields", () => {
        const out = serialize(
            SCHEMA,
            { id: "u1", email: "a@b.com", secret: "x", scratch: "tmp" },
            { target: "server" },
        );
        assert.deepEqual(out, { id: "u1", email: "a@b.com", secret: "x", scratch: "tmp" });
    });

    it("database target strips ephemeral fields", () => {
        const out = serialize(
            SCHEMA,
            { id: "u1", email: "a@b.com", secret: "x", scratch: "tmp" },
            { target: "database" },
        );
        assert.deepEqual(out, { id: "u1", email: "a@b.com", secret: "x" });
    });

    it("omits keys not present in the value", () => {
        const out = serialize(SCHEMA, { id: "u1" }, { target: "client" });
        assert.deepEqual(out, { id: "u1" });
    });
});
