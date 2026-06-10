import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MongoAdapter } from "../src/index.js";
import { ADDRESS_SCHEMA, OIDS, ORG_SCHEMA, USER_SCHEMA } from "./fixtures.js";
import { clean, startMongo, stopMongo, DB_NAME, type TestHandle } from "./setup.js";

describe("MongoAdapter — reference populate", () => {
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

    it("single-level reference populate returns the full referenced record", async () => {
        await adapter.create(ORG_SCHEMA, { id: OIDS.o1, name: "Acme", tier: "pro" });
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            organization: OIDS.o1,
        });
        const fetched = await adapter.read(
            USER_SCHEMA,
            { id: OIDS.u1 },
            { populate: { organization: { schema: ORG_SCHEMA } } },
        );
        assert.deepEqual(fetched!["organization"], {
            id: OIDS.o1,
            name: "Acme",
            tier: "pro",
        });
    });

    it("nested projection inside populate", async () => {
        await adapter.create(ORG_SCHEMA, { id: OIDS.o1, name: "Acme", tier: "pro" });
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            organization: OIDS.o1,
        });
        const fetched = await adapter.read(
            USER_SCHEMA,
            { id: OIDS.u1 },
            {
                populate: {
                    organization: {
                        schema: ORG_SCHEMA,
                        projection: { fields: { name: 1 } },
                    },
                },
            },
        );
        assert.deepEqual(fetched!["organization"], { name: "Acme" });
    });

    it("missing reference yields null in populated field", async () => {
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
        });
        const fetched = await adapter.read(
            USER_SCHEMA,
            { id: OIDS.u1 },
            { populate: { organization: { schema: ORG_SCHEMA } } },
        );
        assert.equal(fetched!["organization"], null);
    });

    it("populate on list", async () => {
        await adapter.create(ORG_SCHEMA, { id: OIDS.o1, name: "Acme" });
        for (const id of [OIDS.u1, OIDS.u2]) {
            await adapter.create(USER_SCHEMA, {
                id,
                email: `${id}@x.com`,
                name: id,
                organization: OIDS.o1,
            });
        }
        const list = await adapter.list(USER_SCHEMA, {
            where: {},
            sort: { id: 1 },
            projection: {
                populate: {
                    organization: {
                        schema: ORG_SCHEMA,
                        projection: { fields: { name: 1 } },
                    },
                },
            },
        });
        assert.equal(list.length, 2);
        for (const u of list) {
            assert.deepEqual(u["organization"], { name: "Acme" });
        }
    });

    it("populate on create result", async () => {
        await adapter.create(ORG_SCHEMA, { id: OIDS.o1, name: "Acme" });
        const created = await adapter.create(
            USER_SCHEMA,
            { id: OIDS.u1, email: "a@x.com", name: "A", organization: OIDS.o1 },
            {
                populate: {
                    organization: {
                        schema: ORG_SCHEMA,
                        projection: { fields: { name: 1 } },
                    },
                },
            },
        );
        assert.deepEqual(created["organization"], { name: "Acme" });
    });

    it("populate on update result", async () => {
        await adapter.create(ORG_SCHEMA, { id: OIDS.o1, name: "Acme" });
        await adapter.create(USER_SCHEMA, {
            id: OIDS.u1,
            email: "a@x.com",
            name: "A",
            organization: OIDS.o1,
        });
        const updated = await adapter.update(
            USER_SCHEMA,
            { id: OIDS.u1 },
            { name: "Alice" },
            {
                populate: {
                    organization: {
                        schema: ORG_SCHEMA,
                        projection: { fields: { name: 1 } },
                    },
                },
            },
        );
        assert.equal(updated["name"], "Alice");
        assert.deepEqual(updated["organization"], { name: "Acme" });
    });
});
