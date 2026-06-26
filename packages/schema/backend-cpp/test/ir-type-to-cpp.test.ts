import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRField, IRType } from "@keyma/core/ir";
import { irTypeToCpp, memberType, typeTag, valueBinding, irTypeGuard } from "@keyma/compiler/backend-cpp";

const field = (type: IRType, extra: Partial<IRField> = {}): IRField => ({
    name: "x", type, visibility: "public", readonly: false, required: true, validators: [], formatters: [],
    source: { file: "x.ts", line: 1, column: 1 }, ...extra,
});

describe("irTypeToCpp — every IRType kind", () => {
    const cases: Array<[IRType, string]> = [
        [{ kind: "string" }, "std::pmr::string"],
        [{ kind: "id" }, "std::pmr::string"],
        [{ kind: "decimal" }, "std::pmr::string"],
        [{ kind: "enum", values: ["a", "b"] }, "std::pmr::string"],
        [{ kind: "number" }, "double"],
        [{ kind: "number", bits: 64 }, "double"],
        [{ kind: "number", bits: 32 }, "float"],
        [{ kind: "integer" }, "std::int64_t"],
        [{ kind: "integer", bits: 8 }, "std::int8_t"],
        [{ kind: "integer", bits: 16 }, "std::int16_t"],
        [{ kind: "integer", bits: 32 }, "std::int32_t"],
        [{ kind: "integer", bits: 64 }, "std::int64_t"],
        [{ kind: "integer", bits: 8, unsigned: true }, "std::uint8_t"],
        [{ kind: "integer", bits: 16, unsigned: true }, "std::uint16_t"],
        [{ kind: "integer", bits: 32, unsigned: true }, "std::uint32_t"],
        [{ kind: "integer", bits: 64, unsigned: true }, "std::uint64_t"],
        [{ kind: "integer", unsigned: true }, "std::uint64_t"],
        [{ kind: "bigint" }, "std::int64_t"],
        [{ kind: "boolean" }, "bool"],
        [{ kind: "bytes" }, "std::pmr::vector<std::byte>"],
        [{ kind: "json" }, "keyma::Value"],
        [{ kind: "dateTime" }, "keyma::DateTime"],
        [{ kind: "array", of: { kind: "string" } }, "std::pmr::vector<std::pmr::string>"],
        [{ kind: "array", of: { kind: "string" }, elementNullable: true }, "std::pmr::vector<std::optional<std::pmr::string>>"],
        // A reference lowers to a shared_ptr to the target (id-stub via allocate_shared);
        // without a type map the raw schema name is used.
        [{ kind: "reference", schema: "tag", idType: { kind: "id" } }, "std::shared_ptr<tag>"],
        [{ kind: "reference", schema: "tag", idType: { kind: "integer" } }, "std::shared_ptr<tag>"],
    ];
    for (const [type, expected] of cases) {
        it(`${JSON.stringify(type)} → ${expected}`, () => assert.equal(irTypeToCpp(type), expected));
    }

    it("embedded resolves via cppTypeByName", () => {
        const map = new Map([["address", "app::models::address::Address"]]);
        assert.equal(irTypeToCpp({ kind: "embedded", schema: "address" }, map), "app::models::address::Address");
    });

    it("reference resolves to shared_ptr of the target via cppTypeByName", () => {
        const map = new Map([["tag", "app::models::tag::Tag"]]);
        assert.equal(irTypeToCpp({ kind: "reference", schema: "tag", idType: { kind: "id" } }, map), "std::shared_ptr<app::models::tag::Tag>");
    });

    it("named enum resolves to its enum class via enumTypeByName; inline union stays a string", () => {
        const enums = new Map([["Status", "app::models::user::Status"]]);
        assert.equal(irTypeToCpp({ kind: "enum", values: ["a", "b"], name: "Status" }, undefined, enums), "app::models::user::Status");
        assert.equal(irTypeToCpp({ kind: "enum", values: ["a", "b"] }, undefined, enums), "std::pmr::string");
    });
});

describe("memberType — orthogonal presence × nullability", () => {
    const t: IRType = { kind: "string" };
    it("required & non-nullable → T", () => assert.equal(memberType(field(t)), "std::pmr::string"));
    it("optional → std::optional<T>", () => assert.equal(memberType(field(t, { required: false })), "std::optional<std::pmr::string>"));
    it("nullable → std::optional<T>", () => assert.equal(memberType(field(t, { nullable: true })), "std::optional<std::pmr::string>"));
    it("both → keyma::Field<T>", () => assert.equal(memberType(field(t, { required: false, nullable: true })), "keyma::Field<std::pmr::string>"));
    it("reference is never wrapped (shared_ptr already models absence)", () => {
        const ref: IRType = { kind: "reference", schema: "tag", idType: { kind: "id" } };
        const map = new Map([["tag", "app::models::tag::Tag"]]);
        assert.equal(memberType(field(ref, { required: false, nullable: true }), map), "std::shared_ptr<app::models::tag::Tag>");
    });
});

describe("typeTag / valueBinding / irTypeGuard", () => {
    it("typeTag maps each kind", () => {
        assert.equal(typeTag({ kind: "string" }), "keyma::TypeTag::String");
        assert.equal(typeTag({ kind: "embedded", schema: "a" }), "keyma::TypeTag::Embedded");
        assert.equal(typeTag({ kind: "dateTime" }), "keyma::TypeTag::DateTime");
    });

    it("valueBinding coerces from a Value to the concrete type", () => {
        assert.deepEqual(valueBinding({ kind: "string" }, "__raw"), { cppType: "const std::pmr::string&", init: "__raw.as_string()" });
        assert.deepEqual(valueBinding({ kind: "integer" }, "__raw"), { cppType: "std::int64_t", init: "__raw.as_int()" });
        assert.deepEqual(valueBinding({ kind: "json" }, "__raw"), { cppType: "const keyma::Value&", init: "__raw" });
    });

    it("irTypeGuard yields Value predicates (null when none applies)", () => {
        assert.equal(irTypeGuard({ kind: "string" }, "v"), "v.is_string()");
        assert.equal(irTypeGuard({ kind: "number" }, "v"), "v.is_number()");
        assert.equal(irTypeGuard({ kind: "json" }, "v"), null);
    });
});
