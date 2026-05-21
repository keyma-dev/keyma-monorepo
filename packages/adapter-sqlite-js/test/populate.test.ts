import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/index.js";
import { ALL_SCHEMAS, IDS, ORG_SCHEMA, USER_SCHEMA } from "./fixtures.js";
import { clean, startSqlite, stopSqlite, type TestHandle } from "./setup.js";

describe("SqliteAdapter — projection populate", () => {
    let h: TestHandle;
    let adapter: SqliteAdapter;

    before(() => { h = startSqlite(); });
    after(async () => { await stopSqlite(h); });

    beforeEach(async () => {
        await clean(h);
        adapter = new SqliteAdapter(h.db);
        for (const s of ALL_SCHEMAS) await adapter.ensureSchema(s);
    });

    it("read() populates a single-level reference", async () => {
        await adapter.create(ORG_SCHEMA, { id: IDS.o1, name: "Acme", tier: "gold" });
        await adapter.create(USER_SCHEMA, {
            id: IDS.u1, email: "a@x.com", name: "Alice", organization: IDS.o1,
        });
        const r = await adapter.read(
            USER_SCHEMA,
            { id: IDS.u1 },
            { populate: { organization: { schema: ORG_SCHEMA } } },
        );
        assert.ok(r);
        const org = r["organization"] as Record<string, unknown>;
        assert.equal(org["id"], IDS.o1);
        assert.equal(org["name"], "Acme");
        assert.equal(org["tier"], "gold");
    });

    it("populate yields null when the reference is null", async () => {
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A" });
        const r = await adapter.read(
            USER_SCHEMA,
            { id: IDS.u1 },
            { populate: { organization: { schema: ORG_SCHEMA } } },
        );
        assert.ok(r);
        assert.equal(r["organization"], null);
    });

    it("populate yields null when the target row is missing (dangling ref)", async () => {
        // Disable FK enforcement so the dangling reference is allowed.
        h.raw.pragma("foreign_keys = OFF");
        try {
            await adapter.create(USER_SCHEMA, {
                id: IDS.u1, email: "a@x.com", name: "A", organization: IDS.o2,
            });
            const r = await adapter.read(
                USER_SCHEMA,
                { id: IDS.u1 },
                { populate: { organization: { schema: ORG_SCHEMA } } },
            );
            assert.ok(r);
            assert.equal(r["organization"], null);
        } finally {
            h.raw.pragma("foreign_keys = ON");
        }
    });

    it("list() populates references", async () => {
        await adapter.create(ORG_SCHEMA, { id: IDS.o1, name: "Acme" });
        await adapter.create(ORG_SCHEMA, { id: IDS.o2, name: "Globex" });
        await adapter.create(USER_SCHEMA, { id: IDS.u1, email: "a@x.com", name: "A", organization: IDS.o1 });
        await adapter.create(USER_SCHEMA, { id: IDS.u2, email: "b@x.com", name: "B", organization: IDS.o2 });
        const rows = await adapter.list(USER_SCHEMA, {
            where: {},
            sort: { name: 1 },
            projection: { populate: { organization: { schema: ORG_SCHEMA } } },
        });
        assert.equal(rows.length, 2);
        assert.equal((rows[0]?.["organization"] as Record<string, unknown>)["name"], "Acme");
        assert.equal((rows[1]?.["organization"] as Record<string, unknown>)["name"], "Globex");
    });

    it("populate honors a fields-only projection on the populated record", async () => {
        await adapter.create(ORG_SCHEMA, { id: IDS.o1, name: "Acme", tier: "gold" });
        await adapter.create(USER_SCHEMA, {
            id: IDS.u1, email: "a@x.com", name: "A", organization: IDS.o1,
        });
        const r = await adapter.read(
            USER_SCHEMA,
            { id: IDS.u1 },
            {
                populate: {
                    organization: {
                        schema: ORG_SCHEMA,
                        projection: { fields: { id: 1, name: 1 } },
                    },
                },
            },
        );
        const org = r?.["organization"] as Record<string, unknown>;
        assert.equal(org["name"], "Acme");
        assert.equal("tier" in org, false);
    });
});
