import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serialize } from "../src/serialize.js";
import { deserialize } from "../src/deserialize.js";
import type { ClassMeta, ClassRef } from "../src/fields.js";
import { defineClass } from "./helpers.js";

describe("serialize — JSON wire codec (target-free, visibility-blind)", () => {
    const USER: ClassMeta = {
        name: "user",
        fields: [
            { name: "id", type: { kind: "id" } },
            { name: "email", type: { kind: "string" } },
            // A private field is NOT stripped — visibility is purely the compile-time bundle split.
            { name: "secret", type: { kind: "string" } },
        ],
    };

    it("encodes every present field (no target / no visibility filtering)", () => {
        const out = serialize(USER, { id: "u1", email: "a@b.com", secret: "x" });
        assert.deepEqual(out, { id: "u1", email: "a@b.com", secret: "x" });
    });

    it("omits keys absent from the value", () => {
        assert.deepEqual(serialize(USER, { id: "u1" }), { id: "u1" });
    });

    it("encodes dateTime as epoch-ms and bytes as base64 on the wire", () => {
        const wire: ClassMeta = {
            name: "wire",
            fields: [
                { name: "when", type: { kind: "dateTime" } },
                { name: "blob", type: { kind: "bytes" } },
            ],
        };
        const out = serialize(wire, {
            when: new Date("2024-01-02T03:04:05.000Z"),
            blob: new Uint8Array([0, 1, 2, 253, 254, 255]),
        });
        assert.equal(out["when"], 1704164645000);
        assert.equal(out["blob"], "AAEC/f7/");
    });

    it("round-trips dateTime/bytes/array through deserialize", () => {
        const meta: ClassMeta = {
            name: "rt",
            fields: [
                { name: "when", type: { kind: "dateTime" } },
                { name: "blob", type: { kind: "bytes" } },
                { name: "tags", type: { kind: "array", of: { kind: "string" } } },
            ],
        };
        const record = {
            when: new Date("2024-01-02T03:04:05.000Z"),
            blob: new Uint8Array([9, 8, 7]),
            tags: ["a", "b"],
        };
        const decoded = deserialize(meta, serialize(meta, record));
        assert.ok(decoded["when"] instanceof Date);
        assert.equal((decoded["when"] as Date).getTime(), record.when.getTime());
        assert.deepEqual(Array.from(decoded["blob"] as Uint8Array), [9, 8, 7]);
        assert.deepEqual(decoded["tags"], ["a", "b"]);
    });

    it("recurses into embedded classes via refs (target key + .metadata)", () => {
        const address: ClassRef = defineClass({
            name: "Address",
            fields: [
                { name: "street", type: { kind: "string" } },
                { name: "when", type: { kind: "dateTime" } },
            ],
        });
        const outer: ClassMeta = {
            name: "outer",
            fields: [
                { name: "id", type: { kind: "id" } },
                { name: "address", type: { kind: "embedded", target: "Address" } },
            ],
            refs: new Map([["Address", address]]),
        };
        const out = serialize(outer, {
            id: "o1",
            address: { street: "1 Main", when: new Date("2024-01-02T03:04:05.000Z") },
        });
        assert.deepEqual(out["address"], { street: "1 Main", when: 1704164645000 });

        // deserialize hydrates the embedded instance via the class's fromValue factory.
        const back = deserialize(outer, out as Record<string, unknown>);
        const addr = back["address"] as Record<string, unknown>;
        assert.ok(addr instanceof (address as unknown as new () => object));
        assert.ok(addr["when"] instanceof Date);
    });
});
