import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    external, typeVar, instanceType, fnType, arrayType, param,
    literal, field, ident, member, call, newExpr, obj, arrayExpr, template,
    binary, unary, conditional, intrinsic, arrowExpr, arrowBlock,
    ret, constDecl, exprStmt, assign, ifStmt, method, staticMember, funcDecl,
    checkType, checkExpression, checkStatement,
} from "@keyma/core/ir";

const SRC = { file: "src/x.ts", line: 1, column: 0 };

// Every builder must be valid-by-construction: the matching core node validator returns
// zero errors for its output. Helpers below assert that contract per node category.
const typeOK = (t: ReturnType<typeof external>) => assert.deepEqual(checkType(t, "t"), []);
const exprOK = (x: ReturnType<typeof literal>) => assert.deepEqual(checkExpression(x, "e"), []);
const stmtOK = (s: ReturnType<typeof ret>) => assert.deepEqual(checkStatement(s, "s"), []);

describe("ir builders — types", () => {
    it("external / typeVar / instance build {kind,name} and validate", () => {
        assert.deepEqual(external("ValidationError"), { kind: "external", name: "ValidationError" });
        assert.deepEqual(typeVar("T"), { kind: "typeVar", name: "T" });
        assert.deepEqual(instanceType("User"), { kind: "instance", name: "User" });
        typeOK(external("ValidationError")); typeOK(typeVar("T")); typeOK(instanceType("User"));
    });

    it("fnType omits `returns` when absent, attaches it when given", () => {
        assert.deepEqual(fnType([param("v", { kind: "string" })]), { kind: "function", params: [{ name: "v", type: { kind: "string" } }] });
        assert.deepEqual(
            fnType([param("v", typeVar("T"), true)], { kind: "json" }),
            { kind: "function", params: [{ name: "v", type: { kind: "typeVar", name: "T" }, optional: true }], returns: { kind: "json" } },
        );
        typeOK(fnType([param("v", { kind: "string" })]));
    });

    it("arrayType attaches elementNullable only when truthy", () => {
        assert.deepEqual(arrayType({ kind: "string" }), { kind: "array", of: { kind: "string" } });
        assert.deepEqual(arrayType({ kind: "string" }, true), { kind: "array", of: { kind: "string" }, elementNullable: true });
        typeOK(arrayType(external("X"), true));
    });
});

describe("ir builders — expressions", () => {
    it("literal / field / member / template / binary / unary / conditional", () => {
        exprOK(literal(null)); exprOK(literal("s")); exprOK(literal(3)); exprOK(literal(true));
        exprOK(field("name"));
        exprOK(member(field("created"), "year"));
        exprOK(template([field("a"), literal(" "), field("b")]));
        exprOK(binary("+", literal(1), literal(2)));
        exprOK(unary("!", field("active")));
        exprOK(conditional(field("x"), literal("a"), literal("b")));
    });

    it("ident attaches typeArgs only when given (function-value reference)", () => {
        assert.deepEqual(ident("required"), { kind: "identifier", name: "required" });
        assert.deepEqual(ident("required", { T: { kind: "id" } }), { kind: "identifier", name: "required", typeArgs: { T: { kind: "id" } } });
        exprOK(ident("required")); exprOK(ident("required", { T: instanceType("User") }));
    });

    it("call attaches typeArgs only when given", () => {
        assert.deepEqual(call(ident("f")), { kind: "call", callee: { kind: "identifier", name: "f" }, args: [] });
        assert.deepEqual(
            call(ident("minLength"), [literal(2)], { T: { kind: "string" } }),
            { kind: "call", callee: { kind: "identifier", name: "minLength" }, args: [{ kind: "literal", value: 2 }], typeArgs: { T: { kind: "string" } } },
        );
        exprOK(call(ident("minLength"), [literal(2)], { T: { kind: "string" } }));
    });

    it("newExpr / intrinsic build and validate", () => {
        exprOK(newExpr(ident("Date"), [field("ts")]));
        exprOK(intrinsic("string.trim", field("name"), []));
        exprOK(intrinsic("math.round", null, [field("n")]));
    });

    it("obj builds an ordered object literal from a record", () => {
        assert.deepEqual(
            obj({ code: literal("type_error"), field: literal("name") }),
            { kind: "object", properties: [{ key: "code", value: { kind: "literal", value: "type_error" } }, { key: "field", value: { kind: "literal", value: "name" } }] },
        );
        exprOK(obj({ a: literal(1), b: field("x") }));
    });

    it("arrayExpr builds an ordered array literal and validates (incl. nested objects)", () => {
        assert.deepEqual(
            arrayExpr([literal(1), field("x")]),
            { kind: "array", elements: [{ kind: "literal", value: 1 }, { kind: "field", name: "x" }] },
        );
        assert.deepEqual(arrayExpr([]), { kind: "array", elements: [] });
        exprOK(arrayExpr([]));
        exprOK(arrayExpr([obj({ name: literal("id") }), obj({ name: literal("email") })]));
    });

    it("arrowExpr / arrowBlock are mutually exclusive on body/statements", () => {
        const e = arrowExpr(["v"], binary(">", ident("v"), literal(0)), { kind: "boolean" });
        assert.equal("body" in e && !("statements" in e), true);
        exprOK(e);
        const b = arrowBlock([param("v", { kind: "string" })], [ret(ident("v"))]);
        assert.equal("statements" in b && !("body" in b), true);
        exprOK(b);
    });
});

describe("ir builders — statements", () => {
    it("ret defaults to a bare return (value:null)", () => {
        assert.deepEqual(ret(), { kind: "return", value: null });
        assert.deepEqual(ret(field("x")), { kind: "return", value: { kind: "field", name: "x" } });
        stmtOK(ret()); stmtOK(ret(literal(1)));
    });

    it("constDecl / exprStmt / assign / ifStmt build and validate", () => {
        stmtOK(constDecl("x", literal(1)));
        stmtOK(exprStmt(call(ident("f"))));
        stmtOK(assign(field("email"), ident("value")));
        stmtOK(ifStmt(field("x"), [ret(literal(true))]));
        stmtOK(ifStmt(field("x"), [ret(literal(true))], [ret(literal(false))]));
    });

    it("ifStmt attaches alternate only when given", () => {
        const noElse = ifStmt(field("x"), [ret()]);
        assert.equal("alternate" in noElse, false);
    });
});

describe("ir builders — members / declarations", () => {
    it("method attaches returnType/async/bodyAudience only when given", () => {
        const m = method({ name: "m", kind: "method", params: [param("p", { kind: "string" })], returnType: { kind: "string" }, statements: [ret(field("p"))], visibility: "public", source: SRC });
        assert.equal(m.returnType !== undefined, true);
        assert.equal("async" in m, false);
        assert.equal("bodyAudience" in m, false);

        const gated = method({
            name: "formatSave", kind: "method", params: [param("value", { kind: "string" })], returnType: { kind: "string" },
            statements: [ret(ident("value"))], visibility: "public", source: SRC,
            bodyAudience: { audiences: ["server", "library"], fallback: [ret(ident("value"))] },
        });
        assert.deepEqual(gated.bodyAudience, { audiences: ["server", "library"], fallback: [{ kind: "return", value: { kind: "identifier", name: "value" } }] });
    });

    it("staticMember attaches type/audience only when given; value validates as an expression", () => {
        const plain = staticMember({ name: "metadata", value: obj({ name: literal("user") }) });
        assert.equal("type" in plain, false);
        assert.equal("audience" in plain, false);
        assert.deepEqual(plain, { name: "metadata", value: { kind: "object", properties: [{ key: "name", value: { kind: "literal", value: "user" } }] } });
        exprOK(plain.value);

        const gated = staticMember({
            name: "metadata", value: arrayExpr([literal(1)]), type: external("SchemaMetadata"),
            audience: { audiences: ["server", "library"], fallback: arrayExpr([]) },
        });
        assert.deepEqual(gated.type, { kind: "external", name: "SchemaMetadata" });
        assert.deepEqual(gated.audience, { audiences: ["server", "library"], fallback: { kind: "array", elements: [] } });
    });

    it("funcDecl attaches typeParams/async only when given", () => {
        const f = funcDecl({ name: "f", params: [param("x", { kind: "string" })], returnType: { kind: "boolean" }, statements: [ret(literal(true))], source: SRC });
        assert.equal("typeParams" in f, false);
        assert.equal("async" in f, false);

        const generic = funcDecl({ name: "required", typeParams: ["T"], returnType: fnType([param("v", typeVar("T"))], { kind: "json" }), statements: [ret(arrowExpr([param("v", typeVar("T"))], binary("!=", ident("v"), literal(null))))], source: SRC });
        assert.deepEqual(generic.typeParams, ["T"]);
    });
});
