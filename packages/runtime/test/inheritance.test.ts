// Real-inheritance runtime behavior: the schema metadata carries OWN fields only plus a `base`
// pointer; the runtime assembles the full field/ref set by walking the chain (allFields/allRefs).
// These tests lock in that serialize/deserialize/binary/validate/defaults all see inherited
// fields, that private/ephemeral filtering still applies across the chain, that inherited
// reference targets hydrate, and that a child field override wins over the inherited one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { allFields, allRefs } from "../src/fields.js";
import { serialize } from "../src/serialize.js";
import { deserialize } from "../src/deserialize.js";
import { encodeBinary, decodeBinary } from "../src/binary.js";
import { validate } from "../src/validate.js";
import { applyDefaults } from "../src/defaults.js";
import { brandSchema } from "../src/testing.js";
import type { SchemaMetadata, SchemaClass, ValidatorFn } from "../src/types.js";

const required: ValidatorFn = (value, field) =>
    value !== undefined && value !== null && value !== "" ? null : { field, code: "required", message: `${field} is required` };

// ── Department (inherited reference target) ──────────────────────────────────

interface DepartmentRecord { id: string; name: string }
const DEPARTMENT_SCHEMA: SchemaMetadata = {
    name: "department",
    sourceName: "Department",
    fields: [
        { name: "id", type: { kind: "id" }, tag: 1, readonly: true },
        { name: "name", type: { kind: "string" }, tag: 2 },
    ],
};
class DepartmentCtor {
    declare id: string;
    declare name: string;
    constructor(value?: Partial<DepartmentRecord>) { if (value) Object.assign(this, value); }
}
const Department: SchemaClass<DepartmentRecord> = brandSchema(
    DepartmentCtor as new (v?: Partial<DepartmentRecord>) => DepartmentRecord, DEPARTMENT_SCHEMA,
);

// ── Person (base) ────────────────────────────────────────────────────────────
// id, name, an inherited private `ssn`, and a literal-default `active` flag.

const PERSON_SCHEMA: SchemaMetadata = {
    name: "person",
    sourceName: "Person",
    fields: [
        { name: "id", type: { kind: "id" }, tag: 1, readonly: true, validators: [required] },
        { name: "name", type: { kind: "string" }, tag: 2, validators: [required] },
        { name: "ssn", type: { kind: "string" }, tag: 3, visibility: "private", required: false },
        { name: "active", type: { kind: "boolean" }, tag: 4, required: false, default: { kind: "literal", value: true } },
    ],
    // Parent expression-default initializer: stamp a `kind` discriminator when absent.
    applyDefaults(data: Record<string, unknown>) {
        if (data["kind"] === undefined) data["kind"] = "person";
    },
};
class PersonCtor {
    declare id: string;
    declare name: string;
    declare ssn?: string;
    declare active?: boolean;
    constructor(value?: Record<string, unknown>) { if (value) Object.assign(this, value); }
}
const Person: SchemaClass = brandSchema(PersonCtor, PERSON_SCHEMA);

// ── Employee extends Person ──────────────────────────────────────────────────
// Own fields: department (inherited-target reference), salary. Chain-unique tags continue
// past the parent's max (4 → 5, 6).

const EMPLOYEE_SCHEMA: SchemaMetadata = {
    name: "employee",
    sourceName: "Employee",
    base: PERSON_SCHEMA,
    fields: [
        { name: "department", type: { kind: "reference", schema: "department", idType: { kind: "id" } }, tag: 5, required: false },
        { name: "salary", type: { kind: "integer" }, tag: 6, required: false },
    ],
    refs: new Map<string, SchemaClass>([["department", Department]]),
};

describe("inheritance — allFields / allRefs walk the base chain", () => {
    it("allFields returns own + inherited, parent-first, with chain-unique tags", () => {
        const names = allFields(EMPLOYEE_SCHEMA).map((f) => f.name);
        assert.deepEqual(names, ["id", "name", "ssn", "active", "department", "salary"]);
        const tags = allFields(EMPLOYEE_SCHEMA).map((f) => f.tag);
        assert.deepEqual(tags, [1, 2, 3, 4, 5, 6]);
    });

    it("a root schema's allFields is just its own fields", () => {
        assert.deepEqual(allFields(PERSON_SCHEMA).map((f) => f.name), ["id", "name", "ssn", "active"]);
    });

    it("allRefs resolves an inherited-target reference declared on the child", () => {
        assert.equal(allRefs(EMPLOYEE_SCHEMA).get("department"), Department);
    });
});

describe("inheritance — serialize / deserialize", () => {
    const record = { id: "e1", name: "Ada", ssn: "secret", active: true, department: { id: "d1", name: "R&D" }, salary: 100 };

    it("client serialize keeps inherited public fields and strips the inherited private one", () => {
        const out = serialize(EMPLOYEE_SCHEMA, record, { target: "client" });
        assert.equal(out["id"], "e1");
        assert.equal(out["name"], "Ada");
        assert.equal(out["salary"], 100);
        assert.ok(!("ssn" in out), "inherited private field is stripped on the client target");
    });

    it("server serialize keeps the inherited private field", () => {
        const out = serialize(EMPLOYEE_SCHEMA, record, { target: "server" });
        assert.equal(out["ssn"], "secret");
    });

    it("deserialize hydrates an inherited-target reference into its class instance", () => {
        const hydrated = deserialize(EMPLOYEE_SCHEMA, { id: "e1", name: "Ada", department: "d1", salary: 100 });
        assert.ok(hydrated["department"] instanceof DepartmentCtor, "bare id became a Department stub");
        assert.equal((hydrated["department"] as DepartmentRecord).id, "d1");
    });
});

describe("inheritance — binary round-trip", () => {
    it("preserves inherited + own fields with chain-unique tags", () => {
        const record = { id: "e1", name: "Ada", ssn: "secret", active: false, department: "d1", salary: 100 };
        const bytes = encodeBinary(EMPLOYEE_SCHEMA, record, { target: "server" });
        const back = decodeBinary(EMPLOYEE_SCHEMA, bytes);
        assert.equal(back["id"], "e1");
        assert.equal(back["name"], "Ada");
        assert.equal(back["ssn"], "secret");
        assert.equal(back["active"], false);
        assert.equal(back["department"], "d1");
        assert.equal(back["salary"], 100);
    });

    it("client binary target drops the inherited private field", () => {
        const record = { id: "e1", name: "Ada", ssn: "secret" };
        const back = decodeBinary(EMPLOYEE_SCHEMA, encodeBinary(EMPLOYEE_SCHEMA, record, { target: "client" }));
        assert.ok(!("ssn" in back), "private inherited field never reaches the client wire");
        assert.equal(back["name"], "Ada");
    });
});

describe("inheritance — validate", () => {
    it("reports inherited required fields that are absent", async () => {
        const errors = await validate(EMPLOYEE_SCHEMA, { salary: 100 });
        const fields = errors.map((e) => e.field).sort();
        assert.deepEqual(fields, ["id", "name"], "missing inherited required id/name surface as errors");
    });

    it("passes when all inherited required fields are present", async () => {
        const errors = await validate(EMPLOYEE_SCHEMA, { id: "e1", name: "Ada" });
        assert.deepEqual(errors, []);
    });
});

describe("inheritance — applyDefaults", () => {
    it("applies the inherited literal default and the parent's expression-default initializer", () => {
        const data: Record<string, unknown> = { id: "e1", name: "Ada" };
        applyDefaults(EMPLOYEE_SCHEMA, data);
        assert.equal(data["active"], true, "inherited literal default filled");
        assert.equal(data["kind"], "person", "parent's applyDefaults ran via chain walk");
    });

    it("does not overwrite a provided inherited field", () => {
        const data: Record<string, unknown> = { id: "e1", name: "Ada", active: false };
        applyDefaults(EMPLOYEE_SCHEMA, data);
        assert.equal(data["active"], false);
    });
});

describe("inheritance — child field override wins", () => {
    // A child redeclares an inherited field by the same name; allFields keeps the ancestor
    // position but takes the child's definition.
    const CHILD_OVERRIDE: SchemaMetadata = {
        name: "manager",
        sourceName: "Manager",
        base: PERSON_SCHEMA,
        fields: [
            // Override `active`: same name, but now required (child narrows the parent field).
            { name: "active", type: { kind: "boolean" }, tag: 4, validators: [required] },
        ],
    };

    it("the override appears once, in the ancestor's position, with the child's definition", () => {
        const fields = allFields(CHILD_OVERRIDE);
        const names = fields.map((f) => f.name);
        assert.deepEqual(names, ["id", "name", "ssn", "active"], "no duplicate; ancestor position kept");
        const active = fields.find((f) => f.name === "active")!;
        assert.ok((active.validators ?? []).length === 1, "child's overriding definition (with validator) wins");
    });
});
