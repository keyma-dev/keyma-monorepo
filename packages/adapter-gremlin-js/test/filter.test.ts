import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyOrder, applyWhere, translateSort } from "../src/filter.js";
import { USER_SCHEMA, schemaMap, ORG_SCHEMA, ADDRESS_SCHEMA } from "./fixtures.js";
import { bytecodeSource, translate } from "./setup.js";

const SCHEMAS = schemaMap(USER_SCHEMA, ORG_SCHEMA, ADDRESS_SCHEMA);

function whereStr(where: Record<string, unknown>): string {
    const g = bytecodeSource();
    const trav = applyWhere(g.V().hasLabel("user"), where, USER_SCHEMA, SCHEMAS);
    return translate(trav);
}

describe("filter — applyWhere → Gremlin", () => {
    it("literal equality compiles to has(key, eq(...))", () => {
        assert.match(whereStr({ email: "a@x" }), /has\('email',\s*eq\('a@x'\)\)/);
    });

    it("id compiles to hasId", () => {
        assert.match(whereStr({ id: "u1" }), /hasId\(eq\('u1'\)\)/);
    });

    it("comparison operators map to P.gt/gte/lt/lte/neq", () => {
        assert.match(whereStr({ age: { $gte: 18 } }), /has\('age',\s*gte\(18\)\)/);
        assert.match(whereStr({ age: { $lt: 65 } }), /has\('age',\s*lt\(65\)\)/);
        assert.match(whereStr({ name: { $ne: "Admin" } }), /has\('name',\s*neq\('Admin'\)\)/);
    });

    it("$in / $nin map to within / without", () => {
        assert.match(whereStr({ id: { $in: ["a", "b"] } }), /hasId\(within\('a','b'\)\)/);
        assert.match(whereStr({ name: { $nin: ["x", "y"] } }), /has\('name',\s*without\('x','y'\)\)/);
    });

    it("bigint literals are coerced to their stored string form", () => {
        assert.match(whereStr({ score: { $eq: 5n } }), /has\('score',\s*eq\('5'\)\)/);
    });

    it("dotted embedded keys are queryable directly", () => {
        assert.match(whereStr({ "address.city": "PDX" } as Record<string, unknown>), /has\('address\.city',\s*eq\('PDX'\)\)/);
    });

    it("$or builds an or(...) of sub-traversals", () => {
        const s = whereStr({ $or: [{ name: "x" }, { age: { $gt: 40 } }] });
        assert.match(s, /\.or\(/);
        assert.match(s, /has\('name',\s*eq\('x'\)\)/);
        assert.match(s, /has\('age',\s*gt\(40\)\)/);
    });

    it("$nor builds not(or(...))", () => {
        const s = whereStr({ $nor: [{ name: "x" }] });
        assert.match(s, /\.not\(__\.or\(/);
    });

    it("multiple fields chain as implicit AND", () => {
        const s = whereStr({ name: "x", age: { $gte: 18 } });
        assert.match(s, /has\('name',\s*eq\('x'\)\)\.has\('age',\s*gte\(18\)\)/);
    });
});

describe("filter — sort", () => {
    it("translateSort maps directions and flags id", () => {
        assert.deepEqual(translateSort({ age: -1, name: 1 }), [
            { key: "age", desc: true },
            { key: "name", desc: false },
        ]);
    });

    it("applyOrder emits order().by(...) with asc/desc and T.id for id", () => {
        const g = bytecodeSource();
        const s = translate(applyOrder(g.V(), [{ key: "age", desc: true }, { key: "id", desc: false }]));
        assert.match(s, /order\(\)/);
        assert.match(s, /by\('age',\s*desc\)/);
        assert.match(s, /by\(id,\s*asc\)/);
    });
});
