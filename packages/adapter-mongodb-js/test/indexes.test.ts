import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MongoAdapter } from "../src/index.js";
import { AUTHORSHIP_SCHEMA, OIDS, USER_SCHEMA } from "./fixtures.js";
import { clean, startMongo, stopMongo, DB_NAME, type TestHandle } from "./setup.js";

describe("MongoAdapter — indexes", () => {
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
    });

    afterEach(async () => {
        await adapter.close();
    });

    it("creates unique index from field-level metadata; rejects duplicates", async () => {
        await adapter.ensureSchema(USER_SCHEMA);
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "alice@x.com",
            name: "Alice",
        });
        await assert.rejects(
            adapter.create(USER_SCHEMA, {
                id: OIDS.u2,
                email: "alice@x.com",
                name: "Other",
            }),
            /duplicate key|E11000/i,
        );
    });

    it("creates compound index from schema.indexes", async () => {
        await adapter.ensureSchema(USER_SCHEMA);
        const indexes = await h.db.collection("user").indexes();
        const compound = indexes.find(
            (i) => i.key && "name" in i.key && "age" in i.key,
        );
        assert.ok(compound, "compound name+age index should exist");
        assert.equal(compound!.key["name"], 1);
        assert.equal(compound!.key["age"], -1);
    });

    it("creates indexes on edge endpoint fields", async () => {
        await adapter.ensureSchema(AUTHORSHIP_SCHEMA);
        const indexes = await h.db.collection("authorship").indexes();
        assert.ok(
            indexes.find((i) => i.key && i.key["author"] === 1),
            "index on author should exist",
        );
        assert.ok(
            indexes.find((i) => i.key && i.key["post"] === 1),
            "index on post should exist",
        );
    });

    it("ensureSchema is idempotent", async () => {
        await adapter.ensureSchema(USER_SCHEMA);
        await adapter.ensureSchema(USER_SCHEMA);
        await adapter.ensureSchema(USER_SCHEMA);
    });
});
