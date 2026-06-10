import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MongoAdapter } from "../src/index.js";
import { ADDRESS_SCHEMA, OIDS, ORG_SCHEMA, USER_SCHEMA } from "./fixtures.js";
import { clean, startMongo, stopMongo, DB_NAME, type TestHandle } from "./setup.js";

describe("MongoAdapter — CRUD round-trips", () => {
    let h: TestHandle;
    let adapter: MongoAdapter;

    before(async () => {
        h = await startMongo();
    });

    after(async () => {
        await stopMongo(h);
    });

    beforeEach(async () => {
        await clean(h);
        adapter = new MongoAdapter({ url: h.uri, db: DB_NAME });
        await adapter.ensureSchema(ORG_SCHEMA);
        await adapter.ensureSchema(ADDRESS_SCHEMA);
        await adapter.ensureSchema(USER_SCHEMA);
    });

    afterEach(async () => {
        await adapter.close();
    });

    it("create then read returns equivalent record with generated id", async () => {
        const created = await adapter.create(USER_SCHEMA, {
            email: "alice@example.com",
            name: "Alice",
        });
        assert.ok(typeof created["id"] === "string" && created["id"].length === 24);
        assert.equal(created["email"], "alice@example.com");

        const fetched = await adapter.read(USER_SCHEMA, { id: created["id"] });
        assert.ok(fetched);
        assert.equal(fetched!["email"], "alice@example.com");
        assert.equal(fetched!["name"], "Alice");
    });

    it("create with provided id preserves it", async () => {
        const created = await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "bob@example.com",
            name: "Bob",
        });
        assert.equal(created["id"], OIDS.u1);
        const fetched = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        assert.equal(fetched!["name"], "Bob");
    });

    it("list filters via $gte / $in, supports sort/skip/limit", async () => {
        for (const u of [
            { id: OIDS.u1, email: "a@x.com", name: "A", age: 20 },
            { id: OIDS.u2, email: "b@x.com", name: "B", age: 30 },
            { id: OIDS.u3, email: "c@x.com", name: "C", age: 40 },
            { id: OIDS.u4, email: "d@x.com", name: "D", age: 50 },
        ]) {
            await adapter.create(USER_SCHEMA, u);
        }

        const olderThan30 = await adapter.list(USER_SCHEMA, {
            where: { age: { $gte: 30 } },
            sort: { age: 1 },
        });
        assert.deepEqual(
            olderThan30.map((u) => u["id"]),
            [OIDS.u2, OIDS.u3, OIDS.u4],
        );

        const inSet = await adapter.list(USER_SCHEMA, {
            where: { id: { $in: [OIDS.u1, OIDS.u3] } },
            sort: { id: 1 },
        });
        assert.deepEqual(
            inSet.map((u) => u["id"]),
            [OIDS.u1, OIDS.u3],
        );

        const paged = await adapter.list(USER_SCHEMA, {
            where: {},
            sort: { age: 1 },
            skip: 1,
            limit: 2,
        });
        assert.deepEqual(
            paged.map((u) => u["id"]),
            [OIDS.u2, OIDS.u3],
        );
    });

    it("update merges fields without clobbering unspecified ones", async () => {
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "alice@example.com",
            name: "Alice",
            age: 25,
        });
        const updated = await adapter.update(
            USER_SCHEMA,
            { id: OIDS.u1 },
            { age: 26 },
        );
        assert.equal(updated["email"], "alice@example.com");
        assert.equal(updated["name"], "Alice");
        assert.equal(updated["age"], 26);
    });

    it("update with explicit null stores null", async () => {
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            age: 30,
        });
        await adapter.update(USER_SCHEMA, { id: OIDS.u1 }, { age: null });
        const fetched = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        assert.equal(fetched!["age"], null);
    });

    it("delete removes the record; subsequent read returns null", async () => {
        await adapter.create(USER_SCHEMA, { id: OIDS.u1, email: "a@x.com", name: "A" });
        await adapter.delete(USER_SCHEMA, { id: OIDS.u1 });
        const fetched = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        assert.equal(fetched, null);
    });

    it("delete on missing id is silent", async () => {
        await adapter.delete(USER_SCHEMA, { id: OIDS.u1 });
    });

    it("Decimal128 round-trip preserves precision", async () => {
        const created = await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            balance: "12345.678901234567890123",
        });
        assert.equal(created["balance"], "12345.678901234567890123");
        const fetched = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        assert.equal(fetched!["balance"], "12345.678901234567890123");
    });

    it("BigInt round-trip via Long", async () => {
        const big = 2n ** 20n + 17n;
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            score: big,
        });
        const fetched = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        console.log(typeof fetched!["score"])
        assert.equal(fetched!["score"], big);

        await adapter.update(USER_SCHEMA, { id: OIDS.u1 }, { score: -big });
        const after = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        assert.equal(after!["score"], -big);
    });

    it("Bytes round-trip as Uint8Array", async () => {
        const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            avatar: bytes,
        });
        const fetched = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        const got = fetched!["avatar"];
        assert.ok(got instanceof Uint8Array);
        assert.deepEqual(Array.from(got as Uint8Array), [0xde, 0xad, 0xbe, 0xef]);
    });

    it("dateTime round-trip as Date", async () => {
        const when = new Date("2026-05-16T12:00:00Z");
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            createdAt: when,
        });
        const fetched = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        const got = fetched!["createdAt"];
        assert.ok(got instanceof Date);
        assert.equal((got as Date).toISOString(), when.toISOString());
    });

    it("embedded document round-trips with nested fields", async () => {
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            address: { line1: "1 Main St", city: "Portland", postalCode: "97201" },
        });
        const fetched = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        assert.deepEqual(fetched!["address"], {
            line1: "1 Main St",
            city: "Portland",
            postalCode: "97201",
        });
    });

    it("array<string> round-trips", async () => {
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            tags: ["red", "blue"],
        });
        const fetched = await adapter.read(USER_SCHEMA, { id: OIDS.u1 });
        assert.deepEqual(fetched!["tags"], ["red", "blue"]);
    });

    it("read by non-id where clause", async () => {
        await adapter.create(USER_SCHEMA, { id: OIDS.u1, email: "carol@x.com", name: "Carol" });
        const fetched = await adapter.read(USER_SCHEMA, { email: "carol@x.com" });
        assert.equal(fetched!["id"], OIDS.u1);
    });

    it("sort by id translates to _id", async () => {
        for (const id of [OIDS.u3, OIDS.u1, OIDS.u2]) {
            await adapter.create(USER_SCHEMA, { id, email: `${id}@x.com`, name: id });
        }
        const sorted = await adapter.list(USER_SCHEMA, {
            where: {},
            sort: { id: 1 },
        });
        assert.deepEqual(
            sorted.map((u) => u["id"]),
            [OIDS.u1, OIDS.u2, OIDS.u3],
        );
    });

    it("update on missing target throws", async () => {
        await assert.rejects(
            adapter.update(USER_SCHEMA, { id: OIDS.u1 }, { name: "x" }),
            /not found/,
        );
    });

    it("ensureSchema is idempotent", async () => {
        await adapter.ensureSchema(USER_SCHEMA);
        await adapter.ensureSchema(USER_SCHEMA);
    });

    it("projection only returns requested fields", async () => {
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            age: 30,
        });
        const fetched = await adapter.read(
            USER_SCHEMA,
            { id: OIDS.u1 },
            { fields: { id: 1, email: 1 } },
        );
        assert.deepEqual(Object.keys(fetched!).sort(), ["email", "id"]);
    });
});
