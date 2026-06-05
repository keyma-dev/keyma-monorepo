import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GremlinAdapter } from "../src/index.js";
import { ADDRESS_SCHEMA, IDS, ORG_SCHEMA, TAG_SCHEMA, USER_SCHEMA } from "./fixtures.js";
import { clean, close, connect, hasServer, type LiveHandle } from "./setup.js";

// Integration tests: require a live Gremlin server (GREMLIN_ENDPOINT). Skipped
// otherwise so the suite stays green in CI without Docker.
describe("GremlinAdapter — CRUD round-trips", { skip: !hasServer }, () => {
    let h: LiveHandle;
    let adapter: GremlinAdapter;

    before(async () => {
        h = await connect();
    });
    after(async () => {
        await close(h);
    });
    beforeEach(async () => {
        await clean(h);
        adapter = new GremlinAdapter(h.g);
        await adapter.ensureSchema(ORG_SCHEMA);
        await adapter.ensureSchema(ADDRESS_SCHEMA);
        await adapter.ensureSchema(TAG_SCHEMA);
        await adapter.ensureSchema(USER_SCHEMA);
    });

    it("create then read returns equivalent record with generated id", async () => {
        const created = await adapter.create(USER_SCHEMA, { email: "alice@x.com", name: "Alice" });
        assert.equal(typeof created["id"], "string");
        assert.equal(created["email"], "alice@x.com");
        const fetched = await adapter.read(USER_SCHEMA, { id: created["id"] });
        assert.ok(fetched);
        assert.equal(fetched!["name"], "Alice");
    });

    it("create with provided id preserves it", async () => {
        const created = await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "bob@x.com", name: "Bob" });
        assert.equal(created["id"], IDS.u1);
        const fetched = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.equal(fetched!["name"], "Bob");
    });

    it("list filters via $gte / $in, supports sort/skip/limit", async () => {
        for (const u of [
            { id: IDS.u1, email: "a@x.com", name: "A", age: 20 },
            { id: IDS.u2, email: "b@x.com", name: "B", age: 30 },
            { id: IDS.u3, email: "c@x.com", name: "C", age: 40 },
            { id: IDS.u4, email: "d@x.com", name: "D", age: 50 },
        ]) {
            await adapter.create(USER_SCHEMA, u);
        }
        const olderThan30 = await adapter.list(USER_SCHEMA, { where: { age: { $gte: 30 } }, sort: { age: 1 } });
        assert.deepEqual(olderThan30.map((u) => u["id"]), [IDS.u2, IDS.u3, IDS.u4]);

        const inSet = await adapter.list(USER_SCHEMA, { where: { id: { $in: [IDS.u1, IDS.u3] } }, sort: { id: 1 } });
        assert.deepEqual(inSet.map((u) => u["id"]).sort(), [IDS.u1, IDS.u3].sort());

        const paged = await adapter.list(USER_SCHEMA, { where: {}, sort: { age: 1 }, skip: 1, limit: 2 });
        assert.deepEqual(paged.map((u) => u["id"]), [IDS.u2, IDS.u3]);
    });

    it("update merges fields without clobbering unspecified ones", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "alice@x.com", name: "Alice", age: 25 });
        const updated = await adapter.update(USER_SCHEMA, { id: IDS.u1 }, { age: 26 });
        assert.equal(updated["email"], "alice@x.com");
        assert.equal(updated["name"], "Alice");
        assert.equal(updated["age"], 26);
    });

    it("delete removes the record; subsequent read returns null", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A" });
        await adapter.delete(USER_SCHEMA, { id: IDS.u1 });
        assert.equal(await adapter.read(USER_SCHEMA, { id: IDS.u1 }), null);
    });

    it("delete on missing id is silent", async () => {
        await adapter.delete(USER_SCHEMA, { id: IDS.u1 });
    });

    it("BigInt round-trips losslessly via string storage", async () => {
        const big = 2n ** 40n + 17n;
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", score: big });
        const fetched = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.equal(fetched!["score"], big);
    });

    it("Decimal round-trips preserving precision", async () => {
        await adapter.create(USER_SCHEMA, {
            id: IDS.u1, email: "a@x.com", name: "A", balance: "12345.678901234567890123",
        });
        const fetched = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.equal(fetched!["balance"], "12345.678901234567890123");
    });

    it("Bytes round-trip as Uint8Array", async () => {
        const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", avatar: bytes });
        const got = (await adapter.read(USER_SCHEMA, { id: IDS.u1 }))!["avatar"];
        assert.ok(got instanceof Uint8Array);
        assert.deepEqual(Array.from(got as Uint8Array), [0xde, 0xad, 0xbe, 0xef]);
    });

    it("dateTime round-trips as Date", async () => {
        const when = new Date("2026-05-16T12:00:00.000Z");
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", createdAt: when });
        const got = (await adapter.read(USER_SCHEMA, { id: IDS.u1 }))!["createdAt"];
        assert.ok(got instanceof Date);
        assert.equal((got as Date).toISOString(), when.toISOString());
    });

    it("embedded document round-trips via dotted properties", async () => {
        await adapter.create(USER_SCHEMA, {
            id: IDS.u1, email: "a@x.com", name: "A",
            address: { line1: "1 Main St", city: "Portland", postalCode: "97201" },
        });
        const fetched = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.deepEqual(fetched!["address"], { line1: "1 Main St", city: "Portland", postalCode: "97201" });
    });

    it("array<string> round-trips via list cardinality", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", tags: ["red", "blue"] });
        const fetched = await adapter.read(USER_SCHEMA, { id: IDS.u1 });
        assert.deepEqual((fetched!["tags"] as string[]).slice().sort(), ["blue", "red"]);
    });

    it("read by non-id where clause", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "carol@x.com", name: "Carol" });
        const fetched = await adapter.read(USER_SCHEMA, { email: "carol@x.com" });
        assert.equal(fetched!["id"], IDS.u1);
    });

    it("update on missing target throws", async () => {
        await assert.rejects(adapter.update(USER_SCHEMA, { id: IDS.u1 }, { name: "x" }), /not found/);
    });

    it("ensureSchema is idempotent", async () => {
        await adapter.ensureSchema(USER_SCHEMA);
        await adapter.ensureSchema(USER_SCHEMA);
    });

    it("projection only returns requested fields", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", age: 30 });
        const fetched = await adapter.read(USER_SCHEMA, { id: IDS.u1 }, { fields: { id: 1, email: 1 } });
        assert.deepEqual(Object.keys(fetched!).sort(), ["email", "id"]);
    });

    it("populate resolves a reference field to the nested record", async () => {
        await adapter.create(ORG_SCHEMA, { id: IDS.o1, name: "Acme", tier: "gold" });
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", organization: IDS.o1 });
        const fetched = await adapter.read(
            USER_SCHEMA,
            { id: IDS.u1 },
            { fields: { id: 1, organization: 1 }, populate: { organization: { schema: ORG_SCHEMA, projection: { fields: { id: 1, name: 1 } } } } },
        );
        assert.deepEqual(fetched!["organization"], { id: IDS.o1, name: "Acme" });
    });

    it("populate resolves an array of references in a single query", async () => {
        await adapter.create(TAG_SCHEMA, { id: IDS.tech, label: "tech" });
        await adapter.create(TAG_SCHEMA, { id: IDS.news, label: "news" });
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", tagIds: [IDS.tech, IDS.news] });
        const fetched = await adapter.read(
            USER_SCHEMA,
            { id: IDS.u1 },
            { fields: { id: 1, tagIds: 1 }, populate: { tagIds: { schema: TAG_SCHEMA, projection: { fields: { id: 1, label: 1 } } } } },
        );
        const tags = fetched!["tagIds"] as Array<Record<string, unknown>>;
        assert.deepEqual(tags.map((t) => t["id"]).sort(), [IDS.news, IDS.tech].sort());
        assert.deepEqual(tags.map((t) => t["label"]).sort(), ["news", "tech"]);
    });

    it("nested populate (ref → ref) resolves in a single query", async () => {
        await adapter.create(ORG_SCHEMA, { id: IDS.o1, name: "Acme", tier: "gold" });
        await adapter.create(USER_SCHEMA, { id: IDS.u2, email: "mgr@x.com", name: "Mgr", organization: IDS.o1 });
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", manager: IDS.u2 });
        const fetched = await adapter.read(
            USER_SCHEMA,
            { id: IDS.u1 },
            {
                fields: { id: 1 },
                populate: {
                    manager: {
                        schema: USER_SCHEMA,
                        projection: {
                            fields: { id: 1, name: 1 },
                            populate: { organization: { schema: ORG_SCHEMA, projection: { fields: { id: 1, name: 1 } } } },
                        },
                    },
                },
            },
        );
        assert.deepEqual(fetched, {
            id: IDS.u1,
            manager: { id: IDS.u2, name: "Mgr", organization: { id: IDS.o1, name: "Acme" } },
        });
    });

    it("populate yields null for a missing single reference", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", organization: "does-not-exist" });
        const fetched = await adapter.read(
            USER_SCHEMA,
            { id: IDS.u1 },
            { fields: { id: 1, organization: 1 }, populate: { organization: { schema: ORG_SCHEMA, projection: { fields: { id: 1 } } } } },
        );
        assert.equal(fetched!["organization"], null);
    });
});
