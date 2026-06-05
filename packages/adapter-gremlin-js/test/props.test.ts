import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    elementMapToPlain,
    fromProps,
    toProps,
    valueToGremlin,
    type PropEntry,
} from "../src/props.js";
import { ADDRESS_SCHEMA, ORG_SCHEMA, USER_SCHEMA, schemaMap } from "./fixtures.js";

const SCHEMAS = schemaMap(USER_SCHEMA, ORG_SCHEMA, ADDRESS_SCHEMA);

function propMap(props: PropEntry[]): Record<string, PropEntry> {
    return Object.fromEntries(props.map((p) => [p.key, p]));
}

/** Simulate what `elementMap()` would return after `toProps` was persisted. */
function toElementMap(
    data: Record<string, unknown>,
): Record<string, unknown> {
    const { id, props } = toProps(data, USER_SCHEMA, SCHEMAS, { multiProperty: true });
    const plain: Record<string, unknown> = {};
    if (id !== undefined) plain["id"] = id;
    for (const p of props) plain[p.key] = p.value;
    return plain;
}

describe("props — toProps", () => {
    it("splits id out and never emits it as a property", () => {
        const { id, props } = toProps({ id: "u1", name: "A", email: "a@x" }, USER_SCHEMA, SCHEMAS);
        assert.equal(id, "u1");
        assert.equal(props.find((p) => p.key === "id"), undefined);
    });

    it("flattens embedded documents to dotted keys", () => {
        const { props } = toProps(
            { id: "u1", email: "a@x", name: "A", address: { line1: "1 Main", city: "PDX", postalCode: "97201" } },
            USER_SCHEMA,
            SCHEMAS,
        );
        const m = propMap(props);
        assert.equal(m["address.line1"]!.value, "1 Main");
        assert.equal(m["address.city"]!.value, "PDX");
        assert.equal(m["address.postalCode"]!.value, "97201");
        assert.equal(m["address"], undefined);
    });

    it("emits arrays as list-cardinality multi-properties", () => {
        const { props } = toProps({ id: "u1", email: "a@x", name: "A", tags: ["red", "blue"] }, USER_SCHEMA, SCHEMAS);
        const tags = propMap(props)["tags"]!;
        assert.equal(tags.list, true);
        assert.deepEqual(tags.value, ["red", "blue"]);
    });

    it("coerces scalars: bigint→string, bytes→base64", () => {
        const { props } = toProps(
            { id: "u1", email: "a@x", name: "A", score: 5n, avatar: new Uint8Array([1, 2, 3]) },
            USER_SCHEMA,
            SCHEMAS,
        );
        const m = propMap(props);
        assert.equal(m["score"]!.value, "5");
        assert.equal(m["avatar"]!.value, Buffer.from([1, 2, 3]).toString("base64"));
    });

    it("records explicit nulls for clearing, omits them from props", () => {
        const { props, nulls } = toProps({ id: "u1", email: "a@x", name: "A", age: null }, USER_SCHEMA, SCHEMAS);
        assert.deepEqual(nulls, ["age"]);
        assert.equal(propMap(props)["age"], undefined);
    });

    it("encodes edge arrays as a single JSON value when multiProperty is false", () => {
        const { props } = toProps(
            { id: "u1", email: "a@x", name: "A", tags: ["x", "y"] },
            USER_SCHEMA,
            SCHEMAS,
            { multiProperty: false },
        );
        const tags = propMap(props)["tags"]!;
        assert.equal(tags.list, undefined);
        assert.equal(tags.value, JSON.stringify(["x", "y"]));
    });
});

describe("props — round-trip toProps → fromProps", () => {
    it("restores scalars, bigint, bytes, dateTime", () => {
        const when = new Date("2026-05-16T12:00:00.000Z");
        const data = {
            id: "u1", email: "a@x", name: "A", age: 30,
            balance: "12345.678901234567890123", score: 2n ** 40n + 7n,
            avatar: new Uint8Array([0xde, 0xad, 0xbe, 0xef]), createdAt: when,
        };
        const rec = fromProps(toElementMap(data), USER_SCHEMA, SCHEMAS);
        assert.equal(rec["id"], "u1");
        assert.equal(rec["age"], 30);
        assert.equal(rec["balance"], "12345.678901234567890123");
        assert.equal(rec["score"], 2n ** 40n + 7n);
        assert.ok(rec["avatar"] instanceof Uint8Array);
        assert.deepEqual(Array.from(rec["avatar"] as Uint8Array), [0xde, 0xad, 0xbe, 0xef]);
        assert.ok(rec["createdAt"] instanceof Date);
        assert.equal((rec["createdAt"] as Date).toISOString(), when.toISOString());
    });

    it("re-nests embedded documents from dotted keys", () => {
        const data = { id: "u1", email: "a@x", name: "A", address: { line1: "1 Main", city: "PDX", postalCode: "97201" } };
        const rec = fromProps(toElementMap(data), USER_SCHEMA, SCHEMAS);
        assert.deepEqual(rec["address"], { line1: "1 Main", city: "PDX", postalCode: "97201" });
    });

    it("restores arrays and tolerates single-value unwrapping", () => {
        const rec = fromProps(toElementMap({ id: "u1", email: "a@x", name: "A", tags: ["red", "blue"] }), USER_SCHEMA, SCHEMAS);
        assert.deepEqual(rec["tags"], ["red", "blue"]);
        // A single multi-property value may arrive un-arrayed.
        const single = fromProps({ id: "u1", tags: "solo" }, USER_SCHEMA, SCHEMAS);
        assert.deepEqual(single["tags"], ["solo"]);
    });

    it("keeps reference fields as id strings", () => {
        const rec = fromProps(toElementMap({ id: "u1", email: "a@x", name: "A", organization: "o1" }), USER_SCHEMA, SCHEMAS);
        assert.equal(rec["organization"], "o1");
    });
});

describe("props — elementMapToPlain", () => {
    it("normalizes EnumValue token keys (T.id/T.label) to strings", () => {
        const m = new Map<unknown, unknown>([
            [{ elementName: "id" }, "u1"],
            [{ elementName: "label" }, "user"],
            ["email", "a@x"],
        ]);
        const plain = elementMapToPlain(m);
        assert.equal(plain["id"], "u1");
        assert.equal(plain["label"], "user");
        assert.equal(plain["email"], "a@x");
    });
});

describe("props — valueToGremlin", () => {
    it("mirrors write coercion for filter literals", () => {
        assert.equal(valueToGremlin(5n, { kind: "bigint" }), "5");
        assert.equal(valueToGremlin("o1", { kind: "reference", schema: "organization" }), "o1");
        assert.equal(valueToGremlin(undefined, undefined), undefined);
    });
});
