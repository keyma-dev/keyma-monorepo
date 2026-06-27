// Real-inheritance codec behavior: a class's metadata carries OWN fields only plus a `base`
// pointer; the codec assembles the full field/ref set by walking the chain (allFields/allRefs).
// These lock in that serialize/deserialize/binary all see inherited fields, that an inherited
// reference target hydrates, and that a child field override wins over the inherited one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { allFields, allRefs } from "../src/fields.js";
import { serialize } from "../src/serialize.js";
import { deserialize } from "../src/deserialize.js";
import { encodeBinary, decodeBinary } from "../src/binary.js";
import type { ClassMeta } from "../src/fields.js";
import { defineClass } from "./helpers.js";

// Department — an inherited reference target.
const department = defineClass({
    name: "Department",
    fields: [
        { name: "id", type: { kind: "id" }, tag: 1 },
        { name: "name", type: { kind: "string" }, tag: 2 },
    ],
});

// Person (root) → Employee (subclass): Employee adds `salary` and overrides `title`.
const personMeta: ClassMeta = {
    name: "Person",
    fields: [
        { name: "id", type: { kind: "id" }, tag: 1 },
        { name: "title", type: { kind: "string" }, tag: 2 },
        { name: "dept", type: { kind: "reference", target: "Department", idType: { kind: "id" } }, tag: 3 },
    ],
    refs: new Map([["Department", department]]),
};
const employeeMeta: ClassMeta = {
    name: "Employee",
    base: personMeta,
    fields: [
        // Override `title` (same name) — keeps the ancestor's position, supplies the new def.
        { name: "title", type: { kind: "string" }, tag: 2 },
        { name: "salary", type: { kind: "integer" }, tag: 4 },
    ],
};

describe("inheritance — full field/ref assembly", () => {
    it("allFields walks the base chain, root-first, an override keeping position", () => {
        const names = allFields(employeeMeta).map((f) => f.name);
        assert.deepEqual(names, ["id", "title", "dept", "salary"]);
    });

    it("allRefs resolves an inherited reference target from the base", () => {
        assert.equal(allRefs(employeeMeta).get("Department"), department);
    });
});

describe("inheritance — codec sees inherited fields", () => {
    const record = { id: "e1", title: "Engineer", dept: { id: "d1", name: "R&D" }, salary: 120000 };

    it("serialize includes inherited + own fields (JSON passes a reference object through)", () => {
        const out = serialize(employeeMeta, record);
        assert.equal(out["id"], "e1");
        assert.equal(out["title"], "Engineer");
        assert.equal(out["salary"], 120000);
        assert.deepEqual(out["dept"], { id: "d1", name: "R&D" });
    });

    it("binary round-trips inherited + own fields and collapses the inherited reference to its id", () => {
        const decoded = decodeBinary(employeeMeta, encodeBinary(employeeMeta, record));
        assert.equal(decoded["id"], "e1");
        assert.equal(decoded["title"], "Engineer");
        assert.equal(decoded["salary"], 120000);
        assert.equal(decoded["dept"], "d1");
    });

    it("deserialize hydrates an inherited reference target into a Department instance", () => {
        const back = deserialize(employeeMeta, { id: "e1", title: "Engineer", dept: "d1", salary: 120000 });
        assert.ok(back["dept"] instanceof (department as unknown as new () => object));
        assert.equal((back["dept"] as Record<string, unknown>)["id"], "d1");
    });
});
