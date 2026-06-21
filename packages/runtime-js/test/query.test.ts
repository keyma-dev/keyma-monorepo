import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keyma, Input } from "../src/query.js";
import { User, Organization, Address, UserWithRefs } from "./fixtures.js";

describe("Keyma builders — leaf shape", () => {
    it("Keyma.list produces a list leaf with the schema class", () => {
        const leaf = Keyma.list(User);
        assert.equal(leaf.op, "list");
        assert.equal(leaf.schemaClass, User);
        assert.equal(leaf.project, undefined);
    });

    it("Keyma.list accepts a project arg and stores it", () => {
        const leaf = Keyma.list(User, undefined, { id: 1, email: 1 });
        assert.deepEqual(leaf.project, { id: 1, email: 1 });
    });

    it("Keyma.list accepts a where arg with Input placeholders", () => {
        const leaf = Keyma.list(User, { email: Keyma.input("emailSearch") });
        assert.equal(leaf.op, "list");
        const where = leaf.where!;
        assert.ok(where["email"] instanceof Input);
        assert.equal((where["email"] as Input).name, "emailSearch");
    });

    it("Keyma.read stores where with Input placeholders intact", () => {
        const leaf = Keyma.read(User, { id: Keyma.input("id") });
        assert.equal(leaf.op, "read");
        const where = leaf.where!;
        assert.ok(where["id"] instanceof Input);
        assert.equal((where["id"] as Input).name, "id");
    });

    it("Keyma.create stores data with Input placeholders intact", () => {
        const leaf = Keyma.create(User, {
            email: Keyma.input("email"),
            name: Keyma.input("name"),
        });
        assert.equal(leaf.op, "create");
        const data = leaf.data!;
        assert.equal((data["email"] as Input).name, "email");
        assert.equal((data["name"] as Input).name, "name");
    });

    it("Keyma.update stores both where and data", () => {
        const leaf = Keyma.update(
            User,
            { id: Keyma.input("id") },
            { name: Keyma.input("newName") },
        );
        assert.equal(leaf.op, "update");
        assert.equal((leaf.where!["id"] as Input).name, "id");
        assert.equal((leaf.data!["name"] as Input).name, "newName");
    });

    it("Keyma.delete stores where only", () => {
        const leaf = Keyma.delete(User, { id: Keyma.input("id") });
        assert.equal(leaf.op, "delete");
        assert.equal(leaf.data, undefined);
    });

    it("Keyma.input returns a placeholder with the given name", () => {
        const placeholder = Keyma.input("myParam");
        assert.ok(placeholder instanceof Input);
        assert.equal(placeholder.name, "myParam");
    });
});

describe("Keyma.query / Keyma.mutation — request substitution", () => {
    it("substitutes inputs into the wire request and forwards list options", async () => {
        const captured: unknown[] = [];
        const transport = async (req: unknown) => {
            captured.push(req);
            return { results: {} };
        };

        const q = Keyma.query({
            users: Keyma.list(User, undefined, { id: 1, email: 1 }),
            user: Keyma.read(User, { id: Keyma.input("id") }),
        });

        await q.request(
            { users: { skip: 5, limit: 10 } },
            { inputs: { user: { id: "u-42" } }, transport },
        );

        assert.equal(captured.length, 1);
        const req = captured[0] as {
            operations: Record<string, Record<string, unknown>>;
        };
        assert.deepEqual(req.operations["users"], {
            op: "list",
            schema: "user",
            project: { id: 1, email: 1 },
            options: { skip: 5, limit: 10 },
        });
        assert.deepEqual(req.operations["user"], {
            op: "read",
            schema: "user",
            where: { id: "u-42" },
        });
    });

    it("throws if a required input is missing from leaf inputs", async () => {
        const transport = async () => ({ results: {} });
        const q = Keyma.query({
            user: Keyma.read(User, { id: Keyma.input("id") }),
        });
        await assert.rejects(
            () => q.request({}, { inputs: {} as { user: { id: string } }, transport }),
            /Missing parameter "id"/,
        );
    });

    it("Keyma.mutation builds a mutation document; per-leaf inputs substituted", async () => {
        const captured: unknown[] = [];
        const transport = async (req: unknown) => {
            captured.push(req);
            return { results: {} };
        };

        const m = Keyma.mutation({
            createOrg: Keyma.create(Organization, {
                name: Keyma.input("name"),
                tier: Keyma.input("tier"),
            }),
            removeOrg: Keyma.delete(Organization, { id: Keyma.input("id") }),
        });

        await m.request(
            {},
            {
                inputs: {
                    createOrg: { name: "Acme", tier: "pro" },
                    removeOrg: { id: "org-99" },
                },
                transport,
            },
        );

        const req = captured[0] as {
            operations: Record<string, Record<string, unknown>>;
        };
        assert.deepEqual(req.operations["createOrg"], {
            op: "create",
            schema: "organization",
            data: { name: "Acme", tier: "pro" },
        });
        assert.deepEqual(req.operations["removeOrg"], {
            op: "delete",
            schema: "organization",
            where: { id: "org-99" },
        });
    });

    it("returns the typed results object from the transport, hydrated into class instances", async () => {
        const transport = async () => ({
            results: {
                user: { ok: true as const, data: { id: "u1", email: "a@b.com" } },
            },
        });
        const q = Keyma.query({
            user: Keyma.read(User, { id: Keyma.input("id") }),
        });
        const resp = await q.request({}, { inputs: { user: { id: "u1" } }, transport });
        assert.equal(resp.results.user.ok, true);
        if (resp.results.user.ok && resp.results.user.data !== null) {
            assert.ok(resp.results.user.data instanceof User);
            assert.equal(resp.results.user.data.id, "u1");
            assert.equal(resp.results.user.data.email, "a@b.com");
        }
    });

    it("hydrates nested embedded, reference, and dateTime fields when schema.refs is populated", async () => {
        const iso = "2024-05-16T10:00:00.000Z";
        const transport = async () => ({
            results: {
                bareRef: {
                    ok: true as const,
                    data: {
                        id: "u1",
                        email: "a@b.com",
                        name: "Alice",
                        organization: "o1",
                        address: { line1: "1 Main", city: "Springfield", postalCode: "12345" },
                        createdAt: iso,
                    },
                },
                populatedRef: {
                    ok: true as const,
                    data: {
                        id: "u2",
                        email: "b@b.com",
                        name: "Bob",
                        organization: { id: "o1", name: "Acme", tier: "pro" },
                        address: { line1: "2 Oak", city: "Shelbyville", postalCode: "67890" },
                        createdAt: iso,
                    },
                },
                listed: {
                    ok: true as const,
                    data: [
                        {
                            id: "u3",
                            email: "c@b.com",
                            name: "Carol",
                            organization: "o1",
                            address: { line1: "3 Pine", city: "Capital City", postalCode: "11111" },
                            createdAt: iso,
                        },
                    ],
                },
            },
        });

        const q = Keyma.query({
            bareRef: Keyma.read(UserWithRefs, { id: Keyma.input("id") }),
            populatedRef: Keyma.read(UserWithRefs, { id: Keyma.input("id2") }),
            listed: Keyma.list(UserWithRefs),
        });

        const resp = await q.request(
            {},
            { inputs: { bareRef: { id: "u1" }, populatedRef: { id2: "u2" } }, transport },
        );

        assert.equal(resp.results.bareRef.ok, true);
        if (resp.results.bareRef.ok && resp.results.bareRef.data !== null) {
            const u = resp.results.bareRef.data;
            assert.ok(u instanceof UserWithRefs);
            assert.ok(u.organization instanceof Organization);
            assert.equal(u.organization.id, "o1");
            assert.equal(u.organization.name, undefined);
            assert.ok(u.address instanceof Address);
            assert.equal(u.address.city, "Springfield");
            assert.ok(u.createdAt instanceof Date);
            assert.equal(u.createdAt.toISOString(), iso);
        }

        assert.equal(resp.results.populatedRef.ok, true);
        if (resp.results.populatedRef.ok && resp.results.populatedRef.data !== null) {
            const u = resp.results.populatedRef.data;
            assert.ok(u instanceof UserWithRefs);
            assert.ok(u.organization instanceof Organization);
            assert.equal(u.organization.name, "Acme");
            assert.equal(u.organization.tier, "pro");
            assert.ok(u.address instanceof Address);
            assert.ok(u.createdAt instanceof Date);
        }

        assert.equal(resp.results.listed.ok, true);
        if (resp.results.listed.ok) {
            assert.equal(resp.results.listed.data.length, 1);
            const u = resp.results.listed.data[0]!;
            assert.ok(u instanceof UserWithRefs);
            assert.ok(u.organization instanceof Organization);
            assert.ok(u.address instanceof Address);
            assert.ok(u.createdAt instanceof Date);
        }
    });
});

describe("Keyma — reference id normalization (through the builder)", () => {
    function capturing() {
        const captured: unknown[] = [];
        const transport = async (req: unknown) => {
            captured.push(req);
            return { results: {} };
        };
        return { captured, transport };
    }
    function wireOps(captured: unknown[]): Record<string, Record<string, unknown>> {
        return (captured[0] as { operations: Record<string, Record<string, unknown>> }).operations;
    }

    it("list where: a bare reference id passes through", async () => {
        const { captured, transport } = capturing();
        await Keyma.query({ u: Keyma.list(User, { organization: "o1" }) }).request(
            {},
            { inputs: {}, transport },
        );
        assert.deepEqual(wireOps(captured)["u"]!["where"], { organization: "o1" });
    });

    it("list where: an { id } reference object collapses to the bare id", async () => {
        const { captured, transport } = capturing();
        await Keyma.query({ u: Keyma.list(User, { organization: { id: "o1" } }) }).request(
            {},
            { inputs: {}, transport },
        );
        assert.deepEqual(wireOps(captured)["u"]!["where"], { organization: "o1" });
    });

    it("create data: an { id } reference collapses; other fields untouched", async () => {
        const { captured, transport } = capturing();
        await Keyma.mutation({
            c: Keyma.create(User, { email: "a@b.com", name: "Al", organization: { id: "o1" } }),
        }).request({}, { inputs: {}, transport });
        assert.deepEqual(wireOps(captured)["c"]!["data"], {
            email: "a@b.com",
            name: "Al",
            organization: "o1",
        });
    });

    it("update data: a full instance collapses to its bare id", async () => {
        const { captured, transport } = capturing();
        await Keyma.mutation({
            u: Keyma.update(
                User,
                { id: "u1" },
                { organization: new Organization({ id: "o1", name: "Acme", tier: "pro" }) },
            ),
        }).request({}, { inputs: {}, transport });
        const op = wireOps(captured)["u"]!;
        assert.deepEqual(op["where"], { id: "u1" });
        assert.equal((op["data"] as Record<string, unknown>)["organization"], "o1");
    });

    it("list where: query operators with bare ids are preserved", async () => {
        const { captured, transport } = capturing();
        await Keyma.query({
            u: Keyma.list(User, { organization: { $in: ["o1", "o2"] } }),
        }).request({}, { inputs: {}, transport });
        assert.deepEqual(wireOps(captured)["u"]!["where"], {
            organization: { $in: ["o1", "o2"] },
        });
    });

    it("normalization runs after Input substitution (placeholder → { id } collapses)", async () => {
        const { captured, transport } = capturing();
        await Keyma.query({
            u: Keyma.read(User, { organization: Keyma.input("org") }),
        }).request({}, { inputs: { u: { org: { id: "o1" } } }, transport });
        assert.deepEqual(wireOps(captured)["u"]!["where"], { organization: "o1" });
    });

    it("embedded fields are not collapsed", async () => {
        const { captured, transport } = capturing();
        const address = { line1: "1 Main", city: "Springfield", postalCode: "12345" };
        await Keyma.mutation({
            c: Keyma.create(User, { email: "a@b.com", name: "Al", address }),
        }).request({}, { inputs: {}, transport });
        assert.deepEqual(
            (wireOps(captured)["c"]!["data"] as Record<string, unknown>)["address"],
            address,
        );
    });
});

// Type-level checks — never executed; `tsc` verifies them at build time.
function _referenceArgTypeChecks(): void {
    Keyma.list(User, { organization: "o1" });
    Keyma.list(User, { organization: { id: "o1" } });
    Keyma.create(User, { organization: "o1" });
    Keyma.create(User, { organization: { id: "o1" } });
    // @ts-expect-error — `address` is embedded (no id); a bare string is not assignable to AddressRecord
    Keyma.create(User, { address: "oops" });
}
void _referenceArgTypeChecks;
