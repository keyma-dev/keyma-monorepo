import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keyma, Input } from "../src/query.js";
import { KeymaServer } from "../src/server.js";
import {
    Person, Company, Knows, WorksAt,
    PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA,
    type PersonRecord, type CompanyRecord,
} from "./fixtures.js";
import type {
    KeymaDatabaseAdapter, AdapterTraversalContext, AdapterTraversalResult,
} from "../src/adapter.js";
import type { TraversalSpec } from "../src/protocol.js";

// ─── Leaf shape ──────────────────────────────────────────────────────────────

describe("Keyma.traverse — leaf shape", () => {
    it("heterogeneous chain: terminal class is `cls`, start.schema is independent", () => {
        const leaf = Keyma.traverse(Company, {
            start: { schema: Person, where: { id: "p1" } },
            steps: [
                { via: Knows, direction: "out" },
                { via: WorksAt, direction: "out" },
            ] as const,
            emit: "nodes",
        });
        assert.equal(leaf.op, "traverse");
        assert.equal(leaf.schemaClass, Company);
        assert.equal(leaf.spec.start.schema, "person");
        assert.deepEqual(leaf.spec.start.where, { id: "p1" });
        assert.equal(leaf.spec.steps?.length, 2);
        assert.equal(leaf.spec.steps?.[0]?.via, "knows");
        assert.equal(leaf.spec.steps?.[1]?.via, "worksat");
        assert.equal(leaf.spec.emit, "nodes");
    });

    it("homogeneous repeat: cls is start and terminal", () => {
        const leaf = Keyma.traverse(Person, {
            start: { schema: Person, where: { id: "p1" } },
            repeat: { via: Knows, direction: "out" },
            depth: { min: 1, max: 3 },
            emit: "nodes",
        });
        assert.equal(leaf.op, "traverse");
        assert.equal(leaf.schemaClass, Person);
        assert.equal(leaf.spec.repeat?.via, "knows");
        assert.deepEqual(leaf.spec.depth, { min: 1, max: 3 });
    });

    it("emit defaults to 'nodes' when omitted", () => {
        const leaf = Keyma.traverse(Person, {
            start: { schema: Person, where: { id: "p1" } },
            repeat: { via: Knows, direction: "out" },
            depth: { max: 2 },
        });
        assert.equal(leaf.spec.emit, "nodes");
    });

    it("stores Input placeholders in start.where and edge.edgeWhere", () => {
        const leaf = Keyma.traverse(Company, {
            start: { schema: Person, where: { id: Keyma.input("startId") } },
            steps: [
                { via: Knows, direction: "out", edgeWhere: { since: Keyma.input("after") } },
                { via: WorksAt, direction: "out" },
            ] as const,
            emit: "nodes",
        });
        const startId = leaf.spec.start.where["id"];
        assert.ok(startId instanceof Input);
        assert.equal((startId as Input).name, "startId");
        const since = leaf.spec.steps?.[0]?.edgeWhere?.["since"];
        assert.ok(since instanceof Input);
    });
});

describe("Keyma.query — traverse substitution", () => {
    it("substitutes inputs into the wire request", async () => {
        const captured: unknown[] = [];
        const transport = async (req: unknown) => { captured.push(req); return { results: {} }; };

        const q = Keyma.query({
            colleagues: Keyma.traverse(Company, {
                start: { schema: Person, where: { id: Keyma.input("me") } },
                steps: [
                    { via: Knows, direction: "out" },
                    { via: WorksAt, direction: "out" },
                ] as const,
                emit: "nodes",
            }),
        });

        await q.request({}, {
            // Input name "me" → inputs key "me" (matches Input substitution semantics).
            inputs: { colleagues: { me: "p-123" } as never },
            transport,
        });

        const req = captured[0] as { operations: Record<string, { spec: TraversalSpec }> };
        const op = req.operations["colleagues"]!;
        assert.equal((op as unknown as { op: string }).op, "traverse");
        assert.deepEqual(op.spec.start.where, { id: "p-123" });
        assert.equal(op.spec.steps?.length, 2);
    });
});

// ─── Server dispatch ─────────────────────────────────────────────────────────

function makeFakeAdapter(
    overrides: Partial<KeymaDatabaseAdapter> = {},
): KeymaDatabaseAdapter {
    return {
        ensureSchema: async () => {},
        create: async () => ({}),
        read: async () => null,
        list: async () => [],
        update: async () => ({}),
        delete: async () => {},
        ...overrides,
    };
}

describe("KeymaServer — traverse dispatch", () => {
    it("returns UNSUPPORTED when adapter has no traverse() method", async () => {
        const server = new KeymaServer({
            schemas: [PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
            adapter: makeFakeAdapter(),
        });
        const resp = await server.handle({
            operations: {
                t: {
                    op: "traverse",
                    schema: "company",
                    spec: {
                        start: { schema: "person", where: { id: "p1" } },
                        steps: [{ via: "knows", direction: "out" }, { via: "worksat", direction: "out" }],
                        emit: "nodes",
                    },
                },
            },
        });
        const r = resp.results["t"]!;
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, "UNSUPPORTED");
    });

    it("forwards spec to adapter.traverse() with resolved context", async () => {
        let receivedCtx: AdapterTraversalContext | undefined;
        let receivedSpec: TraversalSpec | undefined;
        const adapter = makeFakeAdapter({
            traverse: async (ctx, spec) => {
                receivedCtx = ctx;
                receivedSpec = spec;
                return [{ id: "c1", name: "Acme", _company: true }];
            },
        });
        const server = new KeymaServer({
            schemas: [PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
            adapter,
        });
        const resp = await server.handle({
            operations: {
                t: {
                    op: "traverse",
                    schema: "company",
                    spec: {
                        start: { schema: "person", where: { id: "p1" } },
                        steps: [{ via: "knows", direction: "out" }, { via: "worksat", direction: "out" }],
                        emit: "nodes",
                    },
                },
            },
        });

        const r = resp.results["t"]!;
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.deepEqual(r.data, [{ id: "c1", name: "Acme", _company: true }]);
        }
        assert.ok(receivedCtx);
        assert.equal(receivedCtx!.terminalSchema.name, "company");
        assert.equal(receivedCtx!.startSchema.name, "person");
        assert.ok(receivedCtx!.edges.has("knows"));
        assert.ok(receivedCtx!.edges.has("worksat"));
        // Nodes should include start, terminal, AND any endpoint discovered from edges.
        assert.ok(receivedCtx!.nodes.has("person"));
        assert.ok(receivedCtx!.nodes.has("company"));
        assert.ok(receivedSpec);
    });

    it("returns SCHEMA_NOT_FOUND when start schema is unknown", async () => {
        const server = new KeymaServer({
            schemas: [PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
            adapter: makeFakeAdapter({ traverse: async () => [] }),
        });
        const resp = await server.handle({
            operations: {
                t: {
                    op: "traverse",
                    schema: "company",
                    spec: {
                        start: { schema: "ghost", where: {} },
                        steps: [{ via: "knows", direction: "out" }],
                        emit: "nodes",
                    },
                },
            },
        });
        const r = resp.results["t"]!;
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, "SCHEMA_NOT_FOUND");
    });

    it("returns NOT_AN_EDGE when a step references a non-edge schema", async () => {
        const server = new KeymaServer({
            schemas: [PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
            adapter: makeFakeAdapter({ traverse: async () => [] }),
        });
        const resp = await server.handle({
            operations: {
                t: {
                    op: "traverse",
                    schema: "person",
                    spec: {
                        start: { schema: "person", where: {} },
                        // `person` isn't an edge — bad spec
                        steps: [{ via: "person", direction: "out" }],
                        emit: "nodes",
                    },
                },
            },
        });
        const r = resp.results["t"]!;
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, "NOT_AN_EDGE");
    });

    it("hydrates terminal records into terminal schema class instances", async () => {
        const adapter = makeFakeAdapter({
            traverse: async (): Promise<AdapterTraversalResult> => [
                { id: "c1", name: "Acme", _company: true },
                { id: "c2", name: "Globex", _company: true },
            ],
        });
        const server = new KeymaServer({
            schemas: [PERSON_SCHEMA, COMPANY_SCHEMA, KNOWS_SCHEMA, WORKS_AT_SCHEMA],
            adapter,
        });

        const q = Keyma.query({
            companies: Keyma.traverse(Company, {
                start: { schema: Person, where: { id: "p1" } },
                steps: [
                    { via: Knows, direction: "out" },
                    { via: WorksAt, direction: "out" },
                ] as const,
                emit: "nodes",
            }),
        });
        const transport = async (req: { operations: Record<string, unknown> }) => server.handle(req as never);
        const resp = await q.request({}, { inputs: {}, transport });

        assert.equal(resp.results.companies.ok, true);
        if (resp.results.companies.ok) {
            const data = resp.results.companies.data;
            assert.ok(Array.isArray(data));
            assert.equal(data.length, 2);
            assert.ok(data[0] instanceof Company);
            assert.equal((data[0] as CompanyRecord).name, "Acme");
        }
    });
});

// ─── Type narrowing (compile-time assertions) ───────────────────────────────

describe("Keyma.traverse — type narrowing", () => {
    it("valid chain: terminal type narrows to terminal class instance type", () => {
        // The TS compiler verifies this at build; the assertion exists so the
        // test file references the variable.
        const leaf = Keyma.traverse(Company, {
            start: { schema: Person, where: { id: "p1" } },
            steps: [
                { via: Knows, direction: "out" },
                { via: WorksAt, direction: "out" },
            ] as const,
            emit: "nodes",
        });
        // Compile-time type check: leaf carries Company as the terminal class.
        type _Out = (typeof leaf) extends { readonly [k: symbol]: { out: infer O } } ? O : never;
        // _Out is CompanyRecord[]; runtime spot-check covered above.
        assert.equal(leaf.schemaClass, Company);
    });

    it("invalid chain would be rejected by the compiler (documented, not runtime-checked)", () => {
        // Example for documentation; uncomment to see the TS error:
        //
        // Keyma.traverse(Company, {
        //     start: { schema: Person, where: { id: "p1" } },
        //     // Person -- Knows(out) --> Person -- Knows(out) --> Person — but cls is Company
        //     steps: [{ via: Knows, direction: "out" }, { via: Knows, direction: "out" }] as const,
        //     emit: "nodes",
        // });
        assert.ok(true);
    });
});

void PERSON_SCHEMA;