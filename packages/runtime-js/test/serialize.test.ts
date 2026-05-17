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
        { name: "fullName", type: { kind: "string" }, required: false, computed: true, ephemeral: true },
    ],
};

describe("serialize", () => {
    it("client target strips private fields", () => {
        const out = serialize(
            SCHEMA,
            { id: "u1", email: "a@b.com", secret: "x", fullName: "A B" },
            { target: "client" },
        );
        assert.deepEqual(out, { id: "u1", email: "a@b.com", fullName: "A B" });
    });

    it("server target keeps all fields", () => {
        const out = serialize(
            SCHEMA,
            { id: "u1", email: "a@b.com", secret: "x", fullName: "A B" },
            { target: "server" },
        );
        assert.deepEqual(out, { id: "u1", email: "a@b.com", secret: "x", fullName: "A B" });
    });

    it("database target strips ephemeral computed fields", () => {
        const out = serialize(
            SCHEMA,
            { id: "u1", email: "a@b.com", secret: "x", fullName: "A B" },
            { target: "database" },
        );
        assert.deepEqual(out, { id: "u1", email: "a@b.com", secret: "x" });
    });

    it("omits keys not present in the value", () => {
        const out = serialize(SCHEMA, { id: "u1" }, { target: "client" });
        assert.deepEqual(out, { id: "u1" });
    });
});
