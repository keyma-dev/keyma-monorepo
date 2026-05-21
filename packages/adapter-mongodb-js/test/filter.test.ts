import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Binary, Decimal128, ObjectId, Long } from "mongodb";
import { translateWhere } from "../src/filter.js";
import { type SchemaMap } from "../src/record.js";
import { OIDS, ORG_SCHEMA, USER_SCHEMA } from "./fixtures.js";

const SCHEMAS: SchemaMap = new Map([
    [ORG_SCHEMA.name, ORG_SCHEMA],
    [USER_SCHEMA.name, USER_SCHEMA],
]);

describe("translateWhere — logical operators", () => {
    it("$and recurses into sub-filters (id → _id inside each branch)", () => {
        const out = translateWhere(
            {
                $and: [{ id: OIDS.u1 }, { name: "Alice" }],
            },
            USER_SCHEMA,
            SCHEMAS,
        );
        const branches = out["$and"] as Record<string, unknown>[];
        assert.equal(Array.isArray(branches), true);
        assert.equal(branches.length, 2);
        assert.ok(branches[0]!["_id"] instanceof ObjectId);
        assert.equal((branches[0]!["_id"] as ObjectId).toHexString(), OIDS.u1);
        assert.equal(branches[1]!["name"], "Alice");
        assert.equal("id" in branches[0]!, false);
    });

    it("$or recurses with typed values (BigInt → Long, reference → ObjectId)", () => {
        const out = translateWhere(
            {
                $or: [
                    { score: 42n },
                    { organization: OIDS.o1 },
                ],
            },
            USER_SCHEMA,
            SCHEMAS,
        );
        const branches = out["$or"] as Record<string, unknown>[];
        assert.equal(branches.length, 2);
        assert.ok(branches[0]!["score"] instanceof Long );
        assert.ok(branches[1]!["organization"] instanceof ObjectId);
        assert.equal(
            (branches[1]!["organization"] as ObjectId).toHexString(),
            OIDS.o1,
        );
    });

    it("$nor recurses with field-level operator objects ($gte)", () => {
        const out = translateWhere(
            {
                $nor: [{ age: { $gte: 18 } }],
            },
            USER_SCHEMA,
            SCHEMAS,
        );
        const branches = out["$nor"] as Record<string, unknown>[];
        assert.equal(branches.length, 1);
        assert.deepEqual(branches[0]!["age"], { $gte: 18 });
    });

    it("nested logical operators recurse all the way down", () => {
        const out = translateWhere(
            {
                $and: [
                    { $or: [{ id: OIDS.u1 }, { id: OIDS.u2 }] },
                    { name: "Alice" },
                ],
            },
            USER_SCHEMA,
            SCHEMAS,
        );
        const top = out["$and"] as Record<string, unknown>[];
        const orBranches = top[0]!["$or"] as Record<string, unknown>[];
        assert.equal(orBranches.length, 2);
        assert.ok(orBranches[0]!["_id"] instanceof ObjectId);
        assert.ok(orBranches[1]!["_id"] instanceof ObjectId);
        assert.equal(top[1]!["name"], "Alice");
    });

    it("logical operators mixed with sibling field clauses at the top level", () => {
        const out = translateWhere(
            {
                $or: [{ id: OIDS.u1 }, { id: OIDS.u2 }],
                name: "Alice",
            },
            USER_SCHEMA,
            SCHEMAS,
        );
        assert.equal(out["name"], "Alice");
        const branches = out["$or"] as Record<string, unknown>[];
        assert.equal(branches.length, 2);
        assert.ok(branches[0]!["_id"] instanceof ObjectId);
    });

    it("decimal values inside $and branches are converted to Decimal128", () => {
        const out = translateWhere(
            {
                $and: [{ balance: "1.50" }],
            },
            USER_SCHEMA,
            SCHEMAS,
        );
        const branches = out["$and"] as Record<string, unknown>[];
        assert.ok(branches[0]!["balance"] instanceof Decimal128);
        assert.equal((branches[0]!["balance"] as Decimal128).toString(), "1.50");
    });

    it("throws when $and value is not an array", () => {
        assert.throws(
            () =>
                translateWhere(
                    { $and: { id: OIDS.u1 } as unknown as never },
                    USER_SCHEMA,
                    SCHEMAS,
                ),
            /\$and expects an array of sub-filters/,
        );
    });

    it("throws when $or contains a non-object element", () => {
        assert.throws(
            () =>
                translateWhere(
                    { $or: [{ id: OIDS.u1 }, "not-a-filter" as unknown as never] },
                    USER_SCHEMA,
                    SCHEMAS,
                ),
            /\$or sub-filter must be an object/,
        );
    });

    it("throws when $nor contains an array element", () => {
        assert.throws(
            () =>
                translateWhere(
                    { $nor: [[{ id: OIDS.u1 }] as unknown as never] },
                    USER_SCHEMA,
                    SCHEMAS,
                ),
            /\$nor sub-filter must be an object/,
        );
    });
});
