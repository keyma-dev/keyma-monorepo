/**
 * Unit coverage for serialize(schema, value, { target }) from the generated
 * bundle's runtime: visibility/ephemeral stripping, Date -> ISO coercion on
 * dateTime fields, and the no-mutation guarantee.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serialize } from "@keyma/runtime-js";
import { Author, Post } from "./setup.ts";

describe("serialize — visibility, ephemeral, dates, immutability", () => {
    it("client target strips private fields (securityStamp), keeps email/id", () => {
        const out = serialize(
            Author.schema,
            { id: "a1", email: "a@x.com", securityStamp: "secret" },
            { target: "client" },
        );
        assert.equal("securityStamp" in out, false, "private field must be dropped for client");
        assert.equal(out.id, "a1");
        assert.equal(out.email, "a@x.com");
    });

    it("server target keeps private fields (securityStamp)", () => {
        const out = serialize(
            Author.schema,
            { id: "a1", email: "a@x.com", securityStamp: "secret" },
            { target: "server" },
        );
        assert.equal("securityStamp" in out, true, "private field retained for server");
        assert.equal(out.securityStamp, "secret");
        assert.equal(out.email, "a@x.com");
        assert.equal(out.id, "a1");
    });

    it("database target strips ephemeral fields (Post.previewToken), keeps title", () => {
        const out = serialize(
            Post.schema,
            { id: "p1", title: "T", previewToken: "tok" },
            { target: "database" },
        );
        assert.equal("previewToken" in out, false, "ephemeral field must be dropped for database");
        assert.equal(out.title, "T");
        assert.equal(out.id, "p1");
    });

    it("non-database target keeps ephemeral fields (server keeps previewToken)", () => {
        const out = serialize(
            Post.schema,
            { id: "p1", title: "T", previewToken: "tok" },
            { target: "server" },
        );
        assert.equal("previewToken" in out, true, "ephemeral field retained for non-database targets");
        assert.equal(out.previewToken, "tok");
        assert.equal(out.title, "T");
    });

    it("client target also keeps ephemeral fields (only database strips ephemeral)", () => {
        const out = serialize(
            Post.schema,
            { id: "p1", title: "T", previewToken: "tok" },
            { target: "client" },
        );
        assert.equal("previewToken" in out, true, "ephemeral is only stripped on database target");
        assert.equal(out.previewToken, "tok");
    });

    it("Date -> ISO string on dateTime fields", () => {
        const out = serialize(
            Author.schema,
            { id: "a1", createdAt: new Date("2024-01-02T03:04:05.000Z") },
            { target: "client" },
        );
        assert.equal(out.createdAt, "2024-01-02T03:04:05.000Z");
        assert.equal(typeof out.createdAt, "string");
    });

    it("returns a NEW object and does not mutate the input", () => {
        const input = {
            id: "a1",
            email: "a@x.com",
            securityStamp: "secret",
            createdAt: new Date("2024-01-02T03:04:05.000Z"),
        };
        const out = serialize(Author.schema, input, { target: "client" });

        assert.notEqual(out, input, "serialize returns a fresh object");
        // Input is untouched: private field still present, Date still a Date.
        assert.equal(input.securityStamp, "secret", "input private field unchanged");
        assert.ok(input.createdAt instanceof Date, "input Date not coerced to string");
        assert.equal(input.createdAt.toISOString(), "2024-01-02T03:04:05.000Z");
        // Output is the coerced/stripped form.
        assert.equal("securityStamp" in out, false);
        assert.equal(out.createdAt, "2024-01-02T03:04:05.000Z");
    });

    it("only emits fields that are present in the value (no undefined filling)", () => {
        const out = serialize(Author.schema, { id: "a1", email: "a@x.com" }, { target: "server" });
        // firstName/lastName etc. were not supplied; they must not appear.
        assert.equal("firstName" in out, false);
        assert.equal("role" in out, false, "serialize does not apply defaults");
        assert.deepEqual(Object.keys(out).sort(), ["email", "id"]);
    });
});
