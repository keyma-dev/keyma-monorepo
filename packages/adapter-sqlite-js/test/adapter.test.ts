import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/index.js";
import { ALL_SCHEMAS, IDS, ORG_SCHEMA, USER_SCHEMA } from "./fixtures.js";
import { clean, startSqlite, stopSqlite, type TestHandle } from "./setup.js";

describe("SqliteAdapter — ensureSchema + CRUD", () => {
    let h: TestHandle;
    let adapter: SqliteAdapter;

    before(() => { h = startSqlite(); });
    after(async () => { await stopSqlite(h); });

    beforeEach(async () => {
        await clean(h);
        adapter = new SqliteAdapter(h.db);
        for (const s of ALL_SCHEMAS) await adapter.ensureSchema(s);
    });

    it("ensureSchema is idempotent", async () => {
        await adapter.ensureSchema(USER_SCHEMA);
        await adapter.ensureSchema(USER_SCHEMA);
        // No throw.
    });

    it("create() inserts a row and returns it with the assigned id", async () => {
        const created = await adapter.create(USER_SCHEMA, {
            id: IDS.u1, email: "alice@x.com", name: "Alice", age: 30, active: true,
        });
        assert.equal(created["id"], IDS.u1);
        assert.equal(created["email"], "alice@x.com");
        assert.equal(created["name"], "Alice");
        assert.equal(created["age"], 30);
        assert.equal(created["active"], true);
    });

    it("create() generates a UUID when no id is provided", async () => {
        const created = await adapter.create(USER_SCHEMA, {
            email: "bob@x.com", name: "Bob",
        });
        assert.equal(typeof created["id"], "string");
        assert.match(created["id"] as string, /^[0-9a-f-]{36}$/);
    });

    it("read() returns null when no row matches", async () => {
        const r = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.equal(r, null);
    });

    it("read() finds the row by id", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A" });
        const r = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.ok(r);
        assert.equal(r["email"], "a@x.com");
    });

    it("update() modifies the row and returns the updated record", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", age: 20 });
        const updated = await adapter.update(USER_SCHEMA, { id: IDS.u1 }, { age: 21, name: "AA" });
        assert.equal(updated["age"], 21);
        assert.equal(updated["name"], "AA");
        assert.equal(updated["email"], "a@x.com");
    });

    it("delete() removes the row", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A" });
        await adapter.delete(USER_SCHEMA, { id: IDS.u1 });
        const r = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.equal(r, null);
    });

    it("unique index rejects duplicates", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "dup@x.com", name: "A" });
        await assert.rejects(
            adapter.create(USER_SCHEMA, { id: IDS.u2, email: "dup@x.com", name: "B" }),
            /UNIQUE constraint|duplicate/i,
        );
    });

    it("boolean round-trips correctly", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", active: false });
        const r = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.equal(r?.["active"], false);
    });

    it("array<string> round-trips via JSON", async () => {
        await adapter.create(USER_SCHEMA, {
            id: IDS.u1, email: "a@x.com", name: "A",
            tags: ["alpha", "beta", "gamma"],
        });
        const r = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.deepEqual(r?.["tags"], ["alpha", "beta", "gamma"]);
    });

    it("nullable reference can be null", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A" });
        const r = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.equal(r?.["organization"], null);
    });

    it("nullable reference holds the foreign id when populated", async () => {
        await adapter.create(ORG_SCHEMA, { id: IDS.o1, name: "Acme" });
        await adapter.create(USER_SCHEMA, {
            id: IDS.u1, email: "a@x.com", name: "A", organization: IDS.o1,
        });
        const r = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.equal(r?.["organization"], IDS.o1);
    });
});
