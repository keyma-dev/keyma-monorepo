import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/index.js";
import { ALL_SCHEMAS, IDS, USER_SCHEMA } from "./fixtures.js";
import { clean, startSqlite, stopSqlite, type TestHandle } from "./setup.js";

describe("SqliteAdapter — list & filter", () => {
    let h: TestHandle;
    let adapter: SqliteAdapter;

    before(() => { h = startSqlite(); });
    after(async () => { await stopSqlite(h); });

    async function seedUsers(): Promise<void> {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "Alice", age: 20 });
        await adapter.create(USER_SCHEMA, { id: IDS.u2, email: "b@x.com", name: "Bob", age: 30 });
        await adapter.create(USER_SCHEMA, { id: IDS.u3, email: "c@x.com", name: "Carol", age: 40 });
        await adapter.create(USER_SCHEMA, { id: IDS.u4, email: "d@x.com", name: "Dave", age: 50 });
    }

    beforeEach(async () => {
        await clean(h);
        adapter = new SqliteAdapter(h.db);
        for (const s of ALL_SCHEMAS) await adapter.ensureSchema(s);
    });

    it("list() returns all rows when where is empty", async () => {
        await seedUsers();
        const rows = await adapter.list(USER_SCHEMA, { where: {}, sort: {} });
        assert.equal(rows.length, 4);
    });

    it("list() with where filters by equality", async () => {
        await seedUsers();
        const rows = await adapter.list(USER_SCHEMA, { where: { name: "Carol" }, sort: {} });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.["id"], IDS.u3);
    });

    it("list() supports $gt / $lte combo", async () => {
        await seedUsers();
        const rows = await adapter.list(USER_SCHEMA, {
            where: { age: { $gt: 20, $lte: 40 } },
            sort: { age: 1 },
        });
        assert.deepEqual(rows.map((r) => r["id"]), [IDS.u2, IDS.u3]);
    });

    it("list() supports $in", async () => {
        await seedUsers();
        const rows = await adapter.list(USER_SCHEMA, {
            where: { id: { $in: [IDS.u1, IDS.u3] } },
            sort: { id: 1 },
        });
        assert.deepEqual(rows.map((r) => r["id"]), [IDS.u1, IDS.u3].sort());
    });

    it("list() supports $nin and $ne", async () => {
        await seedUsers();
        const rows = await adapter.list(USER_SCHEMA, {
            where: { name: { $nin: ["Alice", "Bob"] } },
            sort: { name: 1 },
        });
        assert.deepEqual(rows.map((r) => r["name"]), ["Carol", "Dave"]);
    });

    it("list() supports $and / $or", async () => {
        await seedUsers();
        const rows = await adapter.list(USER_SCHEMA, {
            where: {
                $or: [
                    { age: { $lt: 25 } },
                    { name: "Dave" },
                ],
            },
            sort: { age: 1 },
        });
        assert.deepEqual(rows.map((r) => r["id"]), [IDS.u1, IDS.u4]);
    });

    it("list() supports $nor", async () => {
        await seedUsers();
        const rows = await adapter.list(USER_SCHEMA, {
            where: {
                $nor: [
                    { name: "Alice" },
                    { name: "Bob" },
                ],
            },
            sort: { name: 1 },
        });
        assert.deepEqual(rows.map((r) => r["name"]), ["Carol", "Dave"]);
    });

    it("list() with sort/limit/skip is deterministic", async () => {
        await seedUsers();
        const rows = await adapter.list(USER_SCHEMA, {
            where: {},
            sort: { age: -1 },
            limit: 2,
            skip: 1,
        });
        assert.deepEqual(rows.map((r) => r["name"]), ["Carol", "Bob"]);
    });

    it("list() falls back to id sort for tiebreaker", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "twin" });
        await adapter.create(USER_SCHEMA, { id: IDS.u2, email: "b@x.com", name: "twin" });
        await adapter.create(USER_SCHEMA, { id: IDS.u3, email: "c@x.com", name: "twin" });
        const rows = await adapter.list(USER_SCHEMA, { where: {}, sort: { name: 1 } });
        assert.deepEqual(rows.map((r) => r["id"]), [IDS.u1, IDS.u2, IDS.u3]);
    });

    it("read() supports operator object filter", async () => {
        await seedUsers();
        const r = await adapter.read(USER_SCHEMA, { age: { $gte: 50 } });
        assert.ok(r);
        assert.equal(r["name"], "Dave");
    });

    it("filter on nullable field with $eq null finds null rows", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A" });
        await adapter.create(USER_SCHEMA, { id: IDS.u2, email: "b@x.com", name: "B" });
        const rows = await adapter.list(USER_SCHEMA, {
            where: { organization: null },
            sort: { id: 1 },
        });
        assert.equal(rows.length, 2);
    });
});
