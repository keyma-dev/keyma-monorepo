import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keyma } from "../src/query.js";
import { KeymaServer } from "../src/server.js";
import { createDirectTransport } from "../src/client.js";
import { InMemoryAdapter } from "../src/testing.js";
import type { ValidatorRegistry } from "../src/validate.js";
import {
    User,
    Organization,
    USER_SCHEMA,
    ORGANIZATION_SCHEMA,
    ADDRESS_SCHEMA,
    PERSON_SCHEMA,
    COMPANY_SCHEMA,
    KNOWS_SCHEMA,
} from "./fixtures.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const defaultValidators: ValidatorRegistry = new Map([
    ["required", (v, _spec, field) =>
        v === null || v === undefined || v === ""
            ? { field, code: "required", message: `${field} is required` }
            : null],
    ["emailAddress", (v, _spec, field) =>
        typeof v === "string" && !EMAIL_RE.test(v)
            ? { field, code: "emailAddress", message: `${field} must be a valid email address` }
            : null],
    ["minLength", (v, spec, field) => {
        const min = typeof spec["value"] === "number" ? spec["value"] : 0;
        return typeof v === "string" && v.length < min
            ? { field, code: "minLength", message: `${field} must be at least ${min} characters` }
            : null;
    }],
]);

function setupServer() {
    const adapter = new InMemoryAdapter();
    const server = new KeymaServer({
        schemas: [USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA],
        adapter,
        validators: defaultValidators,
    });
    return { server, adapter, transport: createDirectTransport(server) };
}

describe("template + server end-to-end", () => {
    it("README example: query with list + read, reference projection", async () => {
        const { adapter, transport } = setupServer();
        adapter.stores.set(
            "organization",
            new Map([["o1", { id: "o1", name: "Acme", tier: "pro" }]]),
        );
        adapter.stores.set(
            "user",
            new Map([
                ["u1", { id: "u1", email: "alice@gmail.com", name: "Alice", organization: "o1" }],
                ["u2", { id: "u2", email: "bob@gmail.com", name: "Bob", organization: "o1" }],
            ]),
        );

        const q = Keyma.query({
            users: Keyma.list(User, undefined, { organization: { name: 1 } }),
            user: Keyma.read(User, { id: Keyma.input("id") }, { organization: { name: 1 } }),
        });

        const response = await q.request(
            { users: { skip: 0, limit: 10 } },
            { inputs: { user: { id: "u1" } }, transport },
        );

        assert.equal(response.results.users.ok, true);
        if (response.results.users.ok) {
            assert.equal(response.results.users.data.length, 2);
            assert.deepEqual(
                response.results.users.data[0]?.organization,
                { name: "Acme" },
            );
        }
        assert.equal(response.results.user.ok, true);
        if (response.results.user.ok && response.results.user.data !== null) {
            assert.deepEqual(response.results.user.data.organization, { name: "Acme" });
        }
    });

    it("template is reusable across multiple .request() calls", async () => {
        const { adapter, transport } = setupServer();
        adapter.stores.set(
            "user",
            new Map([
                ["u1", { id: "u1", email: "a@x.com", name: "Alice" }],
                ["u2", { id: "u2", email: "b@x.com", name: "Bob" }],
            ]),
        );

        const q = Keyma.query({
            user: Keyma.read(User, { id: Keyma.input("id") }),
        });

        const r1 = await q.request({}, { inputs: { user: { id: "u1" } }, transport });
        const r2 = await q.request({}, { inputs: { user: { id: "u2" } }, transport });

        assert.equal(r1.results.user.ok, true);
        assert.equal(r2.results.user.ok, true);
        if (r1.results.user.ok && r1.results.user.data !== null) {
            assert.equal(r1.results.user.data.email, "a@x.com");
        }
        if (r2.results.user.ok && r2.results.user.data !== null) {
            assert.equal(r2.results.user.data.email, "b@x.com");
        }
    });

    it("mutation: create + delete are independent (per-leaf results)", async () => {
        const { transport } = setupServer();

        const m = Keyma.mutation({
            ok: Keyma.create(Organization, {
                name: Keyma.input("name"),
                tier: Keyma.input("tier"),
            }),
            bad: Keyma.create(User, {
                email: Keyma.input("email"),
                name: Keyma.input("name"),
            }),
        });

        const response = await m.request(
            {},
            {
                inputs: {
                    ok: { name: "Acme", tier: "pro" },
                    bad: { email: "not-an-email", name: "X" },
                },
                transport,
            },
        );

        assert.equal(response.results.ok.ok, true);
        assert.equal(response.results.bad.ok, false);
        if (!response.results.bad.ok) {
            assert.equal(response.results.bad.code, "VALIDATION_FAILED");
        }
    });

    it("hydrates response data into schema class instances", async () => {
        const { adapter, transport } = setupServer();
        adapter.stores.set(
            "user",
            new Map([
                ["u1", { id: "u1", email: "a@x.com", name: "Alice" }],
                ["u2", { id: "u2", email: "b@x.com", name: "Bob" }],
            ]),
        );
        adapter.stores.set(
            "organization",
            new Map([["o1", { id: "o1", name: "Acme", tier: "pro" }]]),
        );

        const q = Keyma.query({
            user: Keyma.read(User, { id: Keyma.input("id") }),
            users: Keyma.list(User),
            org: Keyma.read(Organization, { id: Keyma.input("oid") }),
        });

        const resp = await q.request(
            {},
            { inputs: { user: { id: "u1" }, org: { oid: "o1" } }, transport },
        );

        assert.equal(resp.results.user.ok, true);
        if (resp.results.user.ok && resp.results.user.data !== null) {
            assert.ok(resp.results.user.data instanceof User, "read result should be instanceof User");
            assert.equal(resp.results.user.data.email, "a@x.com");
        }

        assert.equal(resp.results.users.ok, true);
        if (resp.results.users.ok) {
            assert.equal(resp.results.users.data.length, 2);
            for (const u of resp.results.users.data) {
                assert.ok(u instanceof User, "list items should be instanceof User");
            }
        }

        assert.equal(resp.results.org.ok, true);
        if (resp.results.org.ok && resp.results.org.data !== null) {
            assert.ok(resp.results.org.data instanceof Organization);
            assert.equal(resp.results.org.data.name, "Acme");
        }
    });

    it("create/update return hydrated instances; delete returns null", async () => {
        const { transport, adapter } = setupServer();
        adapter.stores.set(
            "organization",
            new Map([["o1", { id: "o1", name: "Acme", tier: "free" }]]),
        );

        const m = Keyma.mutation({
            made: Keyma.create(Organization, {
                name: Keyma.input("name"),
                tier: Keyma.input("tier"),
            }),
            changed: Keyma.update(
                Organization,
                { id: Keyma.input("id") },
                { tier: Keyma.input("tier") },
            ),
            gone: Keyma.delete(Organization, { id: Keyma.input("id") }),
        });

        const resp = await m.request(
            {},
            {
                inputs: {
                    made: { name: "New Co", tier: "pro" },
                    changed: { id: "o1", tier: "enterprise" },
                    gone: { id: "o1" },
                },
                transport,
            },
        );

        if (resp.results.made.ok) {
            assert.ok(resp.results.made.data instanceof Organization);
            assert.equal(resp.results.made.data.name, "New Co");
        }
        if (resp.results.changed.ok) {
            assert.ok(resp.results.changed.data instanceof Organization);
            assert.equal(resp.results.changed.data.tier, "enterprise");
        }
        if (resp.results.gone.ok) {
            assert.equal(resp.results.gone.data, null);
        }
    });

    it("template can be used with two different transports", async () => {
        const a = setupServer();
        const b = setupServer();
        a.adapter.stores.set("user", new Map([["u1", { id: "u1", email: "a@x.com", name: "Alice" }]]));
        b.adapter.stores.set("user", new Map([["u1", { id: "u1", email: "b@x.com", name: "Bob" }]]));

        const q = Keyma.query({
            user: Keyma.read(User, { id: Keyma.input("id") }),
        });

        const ra = await q.request({}, { inputs: { user: { id: "u1" } }, transport: a.transport });
        const rb = await q.request({}, { inputs: { user: { id: "u1" } }, transport: b.transport });

        if (ra.results.user.ok && ra.results.user.data !== null) {
            assert.equal(ra.results.user.data.email, "a@x.com");
        }
        if (rb.results.user.ok && rb.results.user.data !== null) {
            assert.equal(rb.results.user.data.email, "b@x.com");
        }
    });
});

describe("edges — create with node objects, read populates from/to", () => {
    function setupEdgeServer() {
        const adapter = new InMemoryAdapter();
        const server = new KeymaServer({
            schemas: [PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA],
            adapter,
        });
        adapter.stores.set("person", new Map([
            ["p1", { id: "p1", name: "Alice" }],
            ["p2", { id: "p2", name: "Bob" }],
        ]));
        return { server, adapter };
    }

    it("create extracts ids from from/to node objects; result returns { id }", async () => {
        const { server } = setupEdgeServer();
        const resp = await server.handle({
            operations: {
                c: {
                    op: "create",
                    schema: "knows",
                    data: {
                        id: "k1",
                        from: { id: "p1", name: "Alice" },
                        to: { id: "p2", name: "Bob" },
                        since: "2020",
                    },
                },
            },
        });
        const r = resp.results["c"]!;
        assert.equal(r.ok, true, JSON.stringify(r));
        if (r.ok) {
            const data = r.data as Record<string, unknown>;
            assert.deepEqual(data["from"], { id: "p1" });
            assert.deepEqual(data["to"], { id: "p2" });
            assert.equal(data["since"], "2020");
        }
    });

    it("read returns from/to as { id } by default", async () => {
        const { server } = setupEdgeServer();
        await server.handle({
            operations: {
                c: { op: "create", schema: "knows", data: { id: "k1", from: { id: "p1" }, to: { id: "p2" }, since: "2020" } },
            },
        });
        const resp = await server.handle({
            operations: { r: { op: "read", schema: "knows", where: { id: "k1" } } },
        });
        const r = resp.results["r"]!;
        assert.equal(r.ok, true, JSON.stringify(r));
        if (r.ok) {
            const data = r.data as Record<string, unknown>;
            assert.deepEqual(data["from"], { id: "p1" });
            assert.deepEqual(data["to"], { id: "p2" });
        }
    });

    it("read populates from/to node fields when the projection requests them", async () => {
        const { server } = setupEdgeServer();
        await server.handle({
            operations: {
                c: { op: "create", schema: "knows", data: { id: "k1", from: { id: "p1" }, to: { id: "p2" }, since: "2020" } },
            },
        });
        const resp = await server.handle({
            operations: {
                r: {
                    op: "read",
                    schema: "knows",
                    where: { id: "k1" },
                    project: { since: 1, from: { name: 1 }, to: 1 },
                },
            },
        });
        const r = resp.results["r"]!;
        assert.equal(r.ok, true, JSON.stringify(r));
        if (r.ok) {
            const data = r.data as Record<string, unknown>;
            assert.deepEqual(data["from"], { name: "Alice", id: "p1" });
            assert.deepEqual(data["to"], { id: "p2" });
            assert.equal(data["since"], "2020");
        }
    });
});
