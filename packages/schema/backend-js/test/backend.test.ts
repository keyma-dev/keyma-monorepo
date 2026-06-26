import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import type { KeymaIR } from "@keyma/core/ir";
import { emitJs } from "./harness.js";
import { exprToJs } from "@keyma/compiler/backend-js";
import { irTypeToTs } from "@keyma/compiler/backend-js";
import type { JsTargetConfig } from "@keyma/compiler/backend-js";
import type { IRExpression, IRType } from "@keyma/core/ir";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOTS = path.join(__dirname, "snapshots");

function snap(name: string): string {
    return readFileSync(path.join(SNAPSHOTS, name), "utf-8");
}

/** Compare against a snapshot, or (re)write it when UPDATE_SNAPSHOTS is set. */
function matchSnap(content: string, name: string): void {
    if (process.env["UPDATE_SNAPSHOTS"]) {
        writeFileSync(path.join(SNAPSHOTS, name), content);
        return;
    }
    assert.equal(content, snap(name));
}

// ─── Test IR fixtures ─────────────────────────────────────────────────────────

const SRC = { file: "schema.ts", line: 1, column: 1 };

const BASIC_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    schemas: [
        {
            id: "schema:user",
            name: "user",
            sourceName: "User",
            visibility: "public",
            fields: [
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, validators: [{ name: "required" }], formatters: [], extensions: { schema: { indexes: [{ unique: true }] } }, source: SRC },
                { name: "firstName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [{ name: "minLength", params: { value: 2 } }], formatters: [{ phase: "change", spec: { name: "trim" } }], source: SRC },
                { name: "lastName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC },
                { name: "secretNote", type: { kind: "string" }, visibility: "private", readonly: false, required: false, validators: [], formatters: [], source: SRC },
            ],
            // `fullName` is a getter behavior (a re-emitted accessor), not a schema field.
            methods: [
                {
                    name: "fullName", kind: "getter", params: [], returnType: { kind: "string" }, visibility: "public",
                    statements: [{ kind: "return", value: { kind: "template", parts: [{ kind: "field", name: "firstName" }, { kind: "literal", value: " " }, { kind: "field", name: "lastName" }] } }],
                    source: SRC,
                },
            ],
            extensions: { schema: { indexes: [{ fields: [{ name: "firstName", direction: 1 }], unique: false }] } },
            source: { file: "user.ts", line: 1, column: 1 },
        },
    ],
    validatorDeclarations: [
        { name: "required", factoryParams: [], inputType: { kind: "json" },
          body: { params: [{ name: "value", role: "value" }], statements: [{ kind: "return", value: { kind: "binary", op: "!=", left: { kind: "field", name: "value" }, right: { kind: "literal", value: null } } }] }, source: SRC },
        { name: "minLength", factoryParams: [{ name: "value" }], inputType: { kind: "string" },
          body: { params: [{ name: "raw", role: "value" }, { name: "field", role: "field" }], statements: [{ kind: "return", value: { kind: "literal", value: null } }] }, source: SRC },
    ],
    formatterDeclarations: [
        { name: "trim", factoryParams: [], inputType: { kind: "string" },
          body: { params: [{ name: "value", role: "value" }], statements: [{ kind: "return", value: { kind: "call", callee: { kind: "member", object: { kind: "field", name: "value" }, member: "trim" }, args: [] } }] }, source: SRC },
    ],
    diagnostics: [],
};

const INHERITANCE_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    schemas: [
        {
            id: "schema:person",
            name: "person",
            sourceName: "Person",
            visibility: "public",
            fields: [
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, validators: [], formatters: [], source: SRC },
                { name: "name", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC },
            ],
            source: SRC,
        },
        {
            id: "schema:employee",
            name: "employee",
            sourceName: "Employee",
            visibility: "public",
            extendsSource: "Person",
            fields: [
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, validators: [], formatters: [], source: SRC },
                { name: "name", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC },
                { name: "department", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC },
            ],
            source: { file: "employee.ts", line: 1, column: 1 },
        },
    ],
    diagnostics: [],
};

const PRIVATE_SCHEMA_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    schemas: [
        {
            id: "schema:public_user",
            name: "public_user",
            sourceName: "PublicUser",
            visibility: "public",
            fields: [{ name: "email", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC }],
            source: SRC,
        },
        {
            id: "schema:credentials",
            name: "credentials",
            sourceName: "Credentials",
            visibility: "private",
            fields: [{ name: "hash", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC }],
            source: { file: "credentials.ts", line: 1, column: 1 },
        },
    ],
    diagnostics: [],
};

const EPHEMERAL_SCHEMA_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    schemas: [
        {
            id: "schema:login_input",
            name: "login_input",
            sourceName: "LoginInput",
            visibility: "public",
            fields: [{ name: "email", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC }],
            extensions: { schema: { ephemeral: true } },
            source: { file: "login_input.ts", line: 1, column: 1 },
        },
    ],
    diagnostics: [],
};

const REFS_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    schemas: [
        {
            id: "schema:address",
            name: "address",
            sourceName: "Address",
            visibility: "public",
            fields: [
                { name: "line1", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC },
            ],
            source: { file: "address.ts", line: 1, column: 1 },
        },
        {
            id: "schema:customer",
            name: "customer",
            sourceName: "Customer",
            visibility: "public",
            fields: [
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, validators: [], formatters: [], source: SRC },
                { name: "home", type: { kind: "embedded", schema: "address" }, visibility: "public", readonly: false, required: false, validators: [], formatters: [], source: SRC },
            ],
            source: { file: "customer.ts", line: 1, column: 1 },
        },
    ],
    diagnostics: [],
};

const VALIDATORS_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    schemas: [
        {
            id: "schema:item",
            name: "item",
            sourceName: "Item",
            visibility: "public",
            fields: [
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, validators: [{ name: "required" }], formatters: [], source: SRC },
            ],
            source: { file: "item.ts", line: 1, column: 1 },
        },
    ],
    validatorDeclarations: [
        {
            name: "required",
            factoryParams: [],
            inputType: { kind: "string" },
            body: {
                params: [{ name: "value", role: "value" }],
                statements: [{ kind: "return", value: { kind: "binary", op: "!=", left: { kind: "field", name: "value" }, right: { kind: "literal", value: null } } }],
            },
            source: SRC,
        },
    ],
    diagnostics: [],
};

const FORMATTERS_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    schemas: [
        {
            id: "schema:item",
            name: "item",
            sourceName: "Item",
            visibility: "public",
            fields: [
                { name: "name", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [{ phase: "change", spec: { name: "trim" } }], source: SRC },
            ],
            source: { file: "item.ts", line: 1, column: 1 },
        },
    ],
    formatterDeclarations: [
        {
            name: "trim",
            factoryParams: [],
            inputType: { kind: "string" },
            body: {
                params: [{ name: "value", role: "value" }],
                statements: [{ kind: "return", value: { kind: "call", callee: { kind: "member", object: { kind: "field", name: "value" }, member: "trim" }, args: [] } }],
            },
            source: SRC,
        },
    ],
    diagnostics: [],
};

// ─── Target config helpers ────────────────────────────────────────────────────

function clientOnlyTarget(outDir = "dist/js"): JsTargetConfig {
    return { language: "js", outDir, client: true, server: false };
}

function serverOnlyTarget(outDir = "dist/js"): JsTargetConfig {
    return { language: "js", outDir, client: false, server: true };
}

function bothTarget(outDir = "dist/js"): JsTargetConfig {
    return { language: "js", outDir };
}

function libraryTarget(outDir = "dist/js"): JsTargetConfig {
    return { language: "js", outDir, library: true };
}

const RESOLVED_CONFIG = {
    source: [], outDir: "dist", schemaPrefix: "", targets: [],
};

function fileContent(files: { path: string; content: string | Uint8Array }[], filePath: string): string {
    const f = files.find((f) => f.path === filePath);
    assert.ok(f !== undefined, `File not found: ${filePath}. Available: ${files.map((f) => f.path).join(", ")}`);
    return f.content as string;
}

// ─── exprToJs unit tests ─────────────────────────────────────────────────────

describe("exprToJs", () => {
    it("lowers a literal string", () => {
        const expr: IRExpression = { kind: "literal", value: "hello" };
        assert.equal(exprToJs(expr), `"hello"`);
    });

    it("lowers a literal number", () => {
        assert.equal(exprToJs({ kind: "literal", value: 42 }), "42");
    });

    it("lowers a literal null", () => {
        assert.equal(exprToJs({ kind: "literal", value: null }), "null");
    });

    it("lowers a field reference", () => {
        assert.equal(exprToJs({ kind: "field", name: "price" }), "this.price");
    });

    it("lowers a member access", () => {
        const expr: IRExpression = { kind: "member", object: { kind: "field", name: "tags" }, member: "length" };
        assert.equal(exprToJs(expr), "this.tags.length");
    });

    it("lowers a template literal with multiple parts", () => {
        const expr: IRExpression = {
            kind: "template",
            parts: [{ kind: "field", name: "first" }, { kind: "literal", value: " " }, { kind: "field", name: "last" }],
        };
        assert.equal(exprToJs(expr), "`${this.first} ${this.last}`");
    });

    it("wraps binary right-child in parens when nested", () => {
        const expr: IRExpression = {
            kind: "binary", op: "*",
            left: { kind: "field", name: "price" },
            right: { kind: "binary", op: "+", left: { kind: "literal", value: 1 }, right: { kind: "field", name: "tax" } },
        };
        assert.equal(exprToJs(expr), "this.price * (1 + this.tax)");
    });

    it("lowers a unary not expression", () => {
        const expr: IRExpression = { kind: "unary", op: "!", operand: { kind: "field", name: "active" } };
        assert.equal(exprToJs(expr), "!this.active");
    });

    it("lowers a conditional expression", () => {
        const expr: IRExpression = {
            kind: "conditional",
            condition: { kind: "field", name: "expensive" },
            whenTrue: { kind: "literal", value: "premium" },
            whenFalse: { kind: "literal", value: "budget" },
        };
        assert.equal(exprToJs(expr), `this.expensive ? "premium" : "budget"`);
    });

    it("emits Date accessor intrinsics as identical JS method calls", () => {
        const intrinsic = (op: string): IRExpression => ({
            kind: "intrinsic", op, receiver: { kind: "field", name: "created" }, args: [],
        });
        assert.equal(exprToJs(intrinsic("date.getMonth")), "this.created.getMonth()");
        assert.equal(exprToJs(intrinsic("date.getTime")), "this.created.getTime()");
        assert.equal(exprToJs(intrinsic("date.toISOString")), "this.created.toISOString()");
    });

    it("emits the static `date.now` intrinsic as Date.now()", () => {
        assert.equal(exprToJs({ kind: "intrinsic", op: "date.now", receiver: null, args: [] }), "Date.now()");
    });

    it("re-emits `new Date(...)` verbatim", () => {
        const expr: IRExpression = {
            kind: "new", callee: { kind: "identifier", name: "Date" },
            args: [{ kind: "field", name: "ts" }],
        };
        assert.equal(exprToJs(expr), "new Date(this.ts)");
    });

    it("emits Math.*, String()/Number(), and array.map intrinsics natively", () => {
        assert.equal(
            exprToJs({ kind: "intrinsic", op: "math.round", receiver: null, args: [{ kind: "field", name: "n" }] }),
            "Math.round(this.n)",
        );
        assert.equal(
            exprToJs({ kind: "intrinsic", op: "math.min", receiver: null, args: [{ kind: "field", name: "a" }, { kind: "literal", value: 0 }] }),
            "Math.min(this.a, 0)",
        );
        assert.equal(
            exprToJs({ kind: "intrinsic", op: "to-string", receiver: null, args: [{ kind: "field", name: "n" }] }),
            "String(this.n)",
        );
        assert.equal(
            exprToJs({ kind: "intrinsic", op: "to-number", receiver: null, args: [{ kind: "field", name: "s" }] }),
            "Number(this.s)",
        );
        const mapExpr: IRExpression = {
            kind: "intrinsic", op: "array.map", receiver: { kind: "field", name: "tags" },
            args: [{ kind: "arrow", params: ["t"], body: { kind: "intrinsic", op: "string.length", receiver: { kind: "identifier", name: "t" }, args: [] } }],
        };
        assert.equal(exprToJs(mapExpr), "this.tags.map((t) => t.length)");
    });

    it("emits a block-body arrow as a native block lambda", () => {
        const arrow: IRExpression = {
            kind: "arrow", params: ["n"],
            statements: [
                { kind: "const", name: "x", init: { kind: "binary", op: "*", left: { kind: "identifier", name: "n" }, right: { kind: "literal", value: 2 } } },
                { kind: "return", value: { kind: "binary", op: ">", left: { kind: "identifier", name: "x" }, right: { kind: "literal", value: 10 } } },
            ],
            returnType: { kind: "boolean" }, // ignored by JS
        };
        assert.equal(exprToJs(arrow), "(n) => { const x = n * 2; return x > 10; }");
    });
});

// ─── irTypeToTs unit tests ────────────────────────────────────────────────────

describe("irTypeToTs", () => {
    const cases: [IRType, string][] = [
        [{ kind: "string" }, "string"],
        [{ kind: "number" }, "number"],
        [{ kind: "number", bits: 32 }, "number"],          // width has no JS representation
        [{ kind: "number", bits: 64 }, "number"],
        [{ kind: "integer" }, "number"],
        [{ kind: "integer", bits: 8 }, "number"],
        [{ kind: "integer", bits: 32, unsigned: true }, "number"],
        [{ kind: "integer", unsigned: true }, "number"],
        [{ kind: "bigint" }, "bigint"],
        [{ kind: "boolean" }, "boolean"],
        [{ kind: "decimal" }, "string"],
        [{ kind: "bytes" }, "Uint8Array"],
        [{ kind: "date" }, "string"],
        [{ kind: "dateTime" }, "Date"],
        [{ kind: "time" }, "string"],
        [{ kind: "id" }, "string"],
        [{ kind: "json" }, "unknown"],
        [{ kind: "reference", schema: "user" }, "user"],
    ];

    for (const [type, expected] of cases) {
        it(`maps ${type.kind} to ${expected}`, () => {
            assert.equal(irTypeToTs(type), expected);
        });
    }

    it("maps enum to a union of string literals", () => {
        assert.equal(irTypeToTs({ kind: "enum", values: ["a", "b", "c"] }), `"a" | "b" | "c"`);
    });

    it("maps a nullable array element to (T | null)[]", () => {
        assert.equal(irTypeToTs({ kind: "array", of: { kind: "string" }, elementNullable: true }), "(string | null)[]");
    });

    it("maps embedded using the class name", () => {
        const names = new Map([["address", "Address"]]);
        assert.equal(irTypeToTs({ kind: "embedded", schema: "address" }, names), "Address");
    });
});

// ─── Client model ─────────────────────────────────────────────────────────────

describe("emitJs — client model", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(BASIC_IR, clientOnlyTarget(), RESOLVED_CONFIG);
        files = result.files;
    });

    it("emits the client model .js file", () => {
        const content = fileContent(files, "dist/js/client/models/user.js");
        assert.ok(content.includes("export class User {"), "missing class declaration");
    });

    it("client model assigns public fields in constructor", () => {
        const content = fileContent(files, "dist/js/client/models/user.js");
        assert.ok(content.includes("this.id = value.id"), "missing id assignment");
        assert.ok(content.includes("this.firstName = value.firstName"), "missing firstName");
        assert.ok(content.includes("this.lastName = value.lastName"), "missing lastName");
    });

    it("client model excludes private fields from constructor", () => {
        const content = fileContent(files, "dist/js/client/models/user.js");
        assert.ok(!content.includes("secretNote"), "private field should be excluded");
    });

    it("client model includes the getter accessor (behavior)", () => {
        const content = fileContent(files, "dist/js/client/models/user.js");
        assert.ok(content.includes("get fullName()"), "missing getter accessor");
        assert.ok(content.includes("`${this.firstName} ${this.lastName}`"), "wrong getter expression");
    });

    it("client model .js snapshot", () => {
        const content = fileContent(files, "dist/js/client/models/user.js");
        matchSnap(content, "client-model-user.js");
    });

    it("client model .d.ts snapshot", () => {
        const content = fileContent(files, "dist/js/client/models/user.d.ts");
        matchSnap(content, "client-model-user.d.ts");
    });

    it("client model attaches schema as a frozen static", () => {
        const content = fileContent(files, "dist/js/client/models/user.js");
        assert.ok(content.includes("User.schema = Object.freeze({"), "missing inline schema literal");
    });

    it("client schema literal excludes private fields", () => {
        const content = fileContent(files, "dist/js/client/models/user.js");
        // secretNote should not appear in the constructor *or* the schema metadata
        assert.ok(!content.includes("secretNote"), "private field should be excluded from client model");
    });

    it("client schema literal excludes index metadata", () => {
        const content = fileContent(files, "dist/js/client/models/user.js");
        const data = content.match(/\"indexes\":\s*\[([^\]]*)\]/g) ?? [];
        for (const indexStr of data) {
            assert.ok(!indexStr.includes("{"), `client schema should have no index entries: ${indexStr}`);
        }
    });

    it("client model does not emit materializer", () => {
        const content = fileContent(files, "dist/js/client/models/user.js");
        assert.ok(!content.includes("function materialize"), "client should not have materializers");
    });

    it("client index.js re-exports model only", () => {
        const content = fileContent(files, "dist/js/client/index.js");
        assert.ok(content.includes(`from "./models/user.js"`), "missing model export");
        assert.ok(content.includes("User"), "missing User export");
        assert.ok(!content.includes("materialize"), "client index should not export materializers");
    });
});

// ─── Server model ─────────────────────────────────────────────────────────────

describe("emitJs — server model", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(BASIC_IR, serverOnlyTarget(), RESOLVED_CONFIG);
        files = result.files;
    });

    it("server model .js snapshot", () => {
        const content = fileContent(files, "dist/js/server/models/user.js");
        matchSnap(content, "server-model-user.js");
    });

    it("server model .d.ts snapshot", () => {
        const content = fileContent(files, "dist/js/server/models/user.d.ts");
        matchSnap(content, "server-model-user.d.ts");
    });

    it("server model includes private field in constructor", () => {
        const content = fileContent(files, "dist/js/server/models/user.js");
        assert.ok(content.includes("this.secretNote = value.secretNote"), "private field missing from server model");
    });

    it("server schema literal includes all fields", () => {
        const content = fileContent(files, "dist/js/server/models/user.js");
        assert.ok(content.includes("secretNote"), "private field should appear in server schema metadata");
    });

    it("server schema literal includes field-level index metadata", () => {
        const content = fileContent(files, "dist/js/server/models/user.js");
        assert.ok(content.includes('"unique": true'), "unique index missing from server schema");
    });

    it("server schema literal includes schema-level index metadata", () => {
        const content = fileContent(files, "dist/js/server/models/user.js");
        assert.ok(content.includes('"direction": 1'), "schema index missing from server");
    });

    it("server model emits the getter accessor and NO materializer", () => {
        const content = fileContent(files, "dist/js/server/models/user.js");
        assert.ok(content.includes("get fullName()"), "getter accessor missing from server model");
        assert.ok(!content.includes("function materialize"), "materializers are removed — none should be emitted");
    });

    it("server schema metadata does not include the getter as a field", () => {
        const content = fileContent(files, "dist/js/server/models/user.js");
        const literal = content.slice(content.indexOf("User.schema = Object.freeze("));
        assert.ok(!literal.includes(`"name": "fullName"`), "getter must not appear as a schema field");
        assert.ok(!literal.includes('"computed"'), "no computed flag in schema metadata");
    });

    it("server index.js does not export a materializer", () => {
        const content = fileContent(files, "dist/js/server/index.js");
        assert.ok(!content.includes("materialize"), "materializers are removed — server index must not export one");
        assert.ok(content.includes(`from "./models/user.js"`), "model should still be re-exported");
    });
});

// ─── Inheritance ──────────────────────────────────────────────────────────────

describe("emitJs — inheritance", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(INHERITANCE_IR, bothTarget(), RESOLVED_CONFIG);
        files = result.files;
    });

    it("Employee model is a flat class (no extends/super after flattening)", () => {
        const content = fileContent(files, "dist/js/client/models/employee.js");
        assert.ok(content.includes("export class Employee {"), "expected a flat class declaration");
        assert.ok(!content.includes("extends Person"), "must not re-emit an extends clause");
        assert.ok(!content.includes("super(value)"), "must not call super — fields are flattened");
    });

    it("Employee assigns each inherited field exactly once", () => {
        const content = fileContent(files, "dist/js/client/models/employee.js");
        const count = (needle: string) => content.split(needle).length - 1;
        assert.equal(count("this.id = value.id;"), 1);
        assert.equal(count("this.name = value.name;"), 1);
        assert.equal(count("this.department = value.department;"), 1);
    });

    it("Employee .d.ts is a flat class", () => {
        const content = fileContent(files, "dist/js/client/models/employee.d.ts");
        assert.ok(content.includes("export declare class Employee {"), "expected a flat declared class");
        assert.ok(!content.includes("extends Person"), "must not re-emit extends in .d.ts");
    });
});

// ─── Private schema visibility ────────────────────────────────────────────────

describe("emitJs — private schema visibility", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(PRIVATE_SCHEMA_IR, bothTarget(), RESOLVED_CONFIG);
        files = result.files;
    });

    it("private schema is excluded from client bundle models", () => {
        const clientPaths = files.filter((f) => f.path.includes("client/")).map((f) => f.path);
        assert.ok(!clientPaths.some((p) => p.includes("credentials")), "private schema model should not be in client");
    });

    it("private schema is excluded from client index.js", () => {
        const content = fileContent(files, "dist/js/client/index.js");
        assert.ok(!content.includes("Credentials"), "private schema should not appear in client index");
    });

    it("private schema is included in server bundle", () => {
        const serverPaths = files.filter((f) => f.path.includes("server/")).map((f) => f.path);
        assert.ok(serverPaths.some((p) => p.includes("credentials")), "private schema model should be in server");
    });

    it("private schema metadata appears in server model file", () => {
        const content = fileContent(files, "dist/js/server/models/credentials.js");
        assert.ok(content.includes("Credentials.schema = Object.freeze("), "private schema metadata missing from server");
    });

    it("private schema metadata carries visibility flag in server model file", () => {
        const content = fileContent(files, "dist/js/server/models/credentials.js");
        assert.match(
            content,
            /"visibility":\s*"private"/,
            "server-emitted private schema must include visibility: private so the runtime can refuse public access",
        );
    });

    it("public schema metadata does not carry a schema-level visibility flag", () => {
        const result = emitJs(BASIC_IR, serverOnlyTarget(), RESOLVED_CONFIG);
        return result.then((r) => {
            const content = fileContent(r.files, "dist/js/server/models/user.js");
            // The field-level visibility for `secretNote` is allowed; the schema literal itself
            // must not declare visibility for a public schema.
            const schemaBlock = content.slice(content.indexOf("User.schema = Object.freeze("));
            const topLevel = schemaBlock.slice(0, schemaBlock.indexOf('"fields"'));
            assert.ok(
                !/"visibility"/.test(topLevel),
                "public schemas should omit the schema-level visibility key",
            );
        });
    });

    it("private schema model is not emitted in client bundle", () => {
        const clientPaths = files.filter((f) => f.path.startsWith("dist/js/client/")).map((f) => f.path);
        assert.ok(!clientPaths.includes("dist/js/client/models/credentials.js"), "private schema should not appear in client");
    });
});

// ─── Ephemeral schemas ───────────────────────────────────────────────────────

describe("emitJs — ephemeral schema", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(EPHEMERAL_SCHEMA_IR, bothTarget(), RESOLVED_CONFIG);
        files = result.files;
    });

    it("ephemeral schema is emitted into BOTH client and server bundles", () => {
        const clientPaths = files.filter((f) => f.path.includes("client/")).map((f) => f.path);
        const serverPaths = files.filter((f) => f.path.includes("server/")).map((f) => f.path);
        assert.ok(clientPaths.some((p) => p.includes("login_input")), "ephemeral schema model should be in client");
        assert.ok(serverPaths.some((p) => p.includes("login_input")), "ephemeral schema model should be in server");
    });

    it("ephemeral schema appears in the client index", () => {
        const content = fileContent(files, "dist/js/client/index.js");
        assert.ok(content.includes("LoginInput"), "ephemeral schema should appear in client index");
    });

    it("ephemeral schema metadata carries the ephemeral flag in both bundles", () => {
        for (const bundle of ["client", "server"]) {
            const content = fileContent(files, `dist/js/${bundle}/models/login_input.js`);
            assert.match(
                content,
                /"ephemeral":\s*true/,
                `${bundle}-emitted ephemeral schema must include ephemeral: true so the runtime skips persistence`,
            );
        }
    });
});

// ─── Embedded / reference refs ───────────────────────────────────────────────

describe("emitJs — refs", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(REFS_IR, bothTarget(), RESOLVED_CONFIG);
        files = result.files;
    });

    it("emits refs as a Map keyed by the referenced name", () => {
        const content = fileContent(files, "dist/js/client/models/customer.js");
        assert.ok(content.includes(`"refs": new Map([["address", Address]])`), `refs Map missing or malformed:\n${content}`);
    });

    it("model imports the referenced class so the Map entry is bound", () => {
        const content = fileContent(files, "dist/js/client/models/customer.js");
        assert.ok(content.includes(`import { Address } from "./address.js"`), "missing Address import");
    });

    it("embeds sourceName in the schema literal", () => {
        const content = fileContent(files, "dist/js/client/models/customer.js");
        assert.ok(content.includes(`"sourceName": "Customer"`), "sourceName missing from schema metadata");
    });
});

// ─── Output file structure ────────────────────────────────────────────────────

describe("emitJs — output structure", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(BASIC_IR, bothTarget("out"), RESOLVED_CONFIG);
        files = result.files;
    });

    it("emits correct set of client files", () => {
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes("out/client/models/user.js"), "client model .js");
        assert.ok(paths.includes("out/client/models/user.d.ts"), "client model .d.ts");
        assert.ok(paths.includes("out/client/index.js"), "client index.js");
        assert.ok(paths.includes("out/client/index.d.ts"), "client index.d.ts");
    });

    it("emits correct set of server files", () => {
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes("out/server/models/user.js"), "server model .js");
        assert.ok(paths.includes("out/server/models/user.d.ts"), "server model .d.ts");
        assert.ok(paths.includes("out/server/index.js"), "server index.js");
        assert.ok(paths.includes("out/server/index.d.ts"), "server index.d.ts");
    });

    it("does not emit a per-bundle schemas.js or schemas.d.ts", () => {
        const paths = files.map((f) => f.path);
        for (const p of paths) {
            assert.ok(!p.endsWith("schemas.js"), `unexpected schemas.js: ${p}`);
            assert.ok(!p.endsWith("schemas.d.ts"), `unexpected schemas.d.ts: ${p}`);
        }
    });

    it("emitted .js files have no external imports", () => {
        const jsFiles = files.filter((f) => f.path.endsWith(".js"));
        for (const file of jsFiles) {
            const content = file.content as string;
            const importLines = content.split("\n").filter((l) => l.trim().startsWith("import"));
            for (const line of importLines) {
                // Only relative imports are allowed (within the bundle)
                assert.ok(
                    line.includes(`"./`) || line.includes(`"../`),
                    `Non-relative import in ${file.path}: ${line}`
                );
            }
        }
    });

    it("returns no diagnostics", async () => {
        const result = await emitJs(BASIC_IR, bothTarget(), RESOLVED_CONFIG);
        assert.deepEqual(result.diagnostics, []);
    });
});

// ─── Validators emitted as a direct-ref module (not via the index/registry) ──

describe("emitJs — validators module", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(VALIDATORS_IR, bothTarget(), RESOLVED_CONFIG);
        files = result.files;
    });

    it("emits a validators.js with direct-ref factory exports (no registry)", () => {
        const content = fileContent(files, "dist/js/server/validators.js");
        assert.ok(content.includes(`export const required =`), "missing required factory export");
        assert.ok(!content.includes("createValidatorRegistry"), "should not emit a registry");
    });

    it("the injected type-guard returns a ValidationError object, not a string", () => {
        const content = fileContent(files, "dist/js/server/validators.js");
        // `required` declares no field param, so the field falls back to `undefined`.
        assert.ok(
            content.includes(`return { field: undefined, code: "type_error", message: "expected string" }`),
            "type-guard must return a ValidationError object",
        );
        assert.ok(!content.includes(`return "expected string"`), "must not return a bare string");
    });

    it("does not emit a registry.js", () => {
        const paths = files.map((f) => f.path);
        assert.ok(!paths.some((p) => p.endsWith("registry.js")), "registry.js should not be emitted");
    });

    it("the index does not re-export validators (they are internal)", () => {
        const content = fileContent(files, "dist/js/server/index.js");
        assert.ok(!content.includes(`from "./validators.js"`), "index must not re-export validators");
    });

    it("a field's metadata references the factory call directly", () => {
        const content = fileContent(files, "dist/js/server/models/item.js");
        assert.ok(content.includes(`import { required } from "../validators.js"`), "model should import the factory");
        assert.ok(content.includes(`"validators": [\n                required()\n            ]`) || content.includes(`required()`), "metadata should call the factory");
    });
});

// ─── Formatters emitted as a direct-ref module ───────────────────────────────

describe("emitJs — formatters module", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(FORMATTERS_IR, bothTarget(), RESOLVED_CONFIG);
        files = result.files;
    });

    it("emits a formatters.js with direct-ref factory exports (no registry)", () => {
        const content = fileContent(files, "dist/js/server/formatters.js");
        assert.ok(content.includes(`export const trim =`), "missing trim factory export");
        assert.ok(!content.includes("createFormatterRegistry"), "should not emit a formatter registry");
    });

    it("does not emit a formatter-registry.js", () => {
        const paths = files.map((f) => f.path);
        assert.ok(!paths.some((p) => p.endsWith("formatter-registry.js")), "formatter-registry.js should not be emitted");
    });

    it("a field's metadata references the formatter via { phase, fn }", () => {
        const content = fileContent(files, "dist/js/server/models/item.js");
        assert.ok(content.includes(`"fn": trim()`), "formatter should be a direct fn call");
    });
});

// ─── No validator/formatter modules when IR has none ──────────────────────────

describe("emitJs — no validator/formatter modules when IR has none", () => {
    it("does not emit validators.js/formatters.js when there are no declarations", async () => {
        const noDeclIr: KeymaIR = { ...BASIC_IR, validatorDeclarations: [], formatterDeclarations: [],
            schemas: BASIC_IR.schemas.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f, validators: [], formatters: [] })) })) };
        const result = await emitJs(noDeclIr, bothTarget(), RESOLVED_CONFIG);
        const paths = result.files.map((f) => f.path);
        assert.ok(!paths.some((p) => p.endsWith("validators.js")), "no validators.js when none declared");
        assert.ok(!paths.some((p) => p.endsWith("formatters.js")), "no formatters.js when none declared");
    });
});

// ─── Library mode ─────────────────────────────────────────────────────────────

describe("emitJs — library mode", () => {
    let files: { path: string; content: string | Uint8Array }[];

    before(async () => {
        const result = await emitJs(BASIC_IR, libraryTarget(), RESOLVED_CONFIG);
        files = result.files;
    });

    it("emits model files directly into outDir (no client/ or server/ subdirectory)", () => {
        const paths = files.map((f) => f.path);
        assert.ok(paths.includes("dist/js/models/user.js"), "library model .js missing");
        assert.ok(paths.includes("dist/js/models/user.d.ts"), "library model .d.ts missing");
        assert.ok(paths.includes("dist/js/index.js"), "library index.js missing");
        assert.ok(paths.includes("dist/js/index.d.ts"), "library index.d.ts missing");
    });

    it("does not emit client/ or server/ subdirectories", () => {
        const paths = files.map((f) => f.path);
        assert.ok(!paths.some((p) => p.includes("/client/")), "library mode should not emit client/ subdirectory");
        assert.ok(!paths.some((p) => p.includes("/server/")), "library mode should not emit server/ subdirectory");
    });

    it("includes private fields (server-like behaviour)", () => {
        const content = fileContent(files, "dist/js/models/user.js");
        assert.ok(content.includes("secretNote"), "library mode should include private fields");
    });

    it("emits the getter accessor and no materializer", () => {
        const content = fileContent(files, "dist/js/models/user.js");
        assert.ok(content.includes("get fullName()"), "library mode should emit the getter accessor");
        assert.ok(!content.includes("function materialize"), "materializers are removed");
    });

    it("index.js does not export a materializer", () => {
        const content = fileContent(files, "dist/js/index.js");
        assert.ok(!content.includes("materialize"), "library index must not export a materializer");
    });
});

describe("emitJs — library mode with validators", () => {
    it("emits a validators.js (no registry) into outDir directly", async () => {
        const result = await emitJs(VALIDATORS_IR, libraryTarget(), RESOLVED_CONFIG);
        const paths = result.files.map((f) => f.path);
        assert.ok(paths.includes("dist/js/validators.js"), "validators.js missing in library mode");
        assert.ok(!paths.some((p) => p.endsWith("registry.js")), "registry.js should not be emitted");
    });

    it("the library index does not re-export validators (internal impl)", async () => {
        const result = await emitJs(VALIDATORS_IR, libraryTarget(), RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/js/index.js");
        assert.ok(!content.includes(`from "./validators.js"`), "validators must not be re-exported from library index");
    });
});

// ─── Method / setter behaviors ─────────────────────────────────────────────────

const BEHAVIORS_IR: KeymaIR = {
    irVersion: "2.0.0",
    compilerVersion: "0.1.0",
    schemas: [
        {
            id: "schema:user",
            name: "user",
            sourceName: "User",
            visibility: "public",
            fields: [
                { name: "firstName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC },
                { name: "email", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], source: SRC },
                { name: "secret", type: { kind: "string" }, visibility: "private", readonly: false, required: false, validators: [], formatters: [], source: SRC },
            ],
            methods: [
                {
                    name: "greeting", kind: "method",
                    params: [{ name: "prefix", type: { kind: "string" } }],
                    returnType: { kind: "string" },
                    statements: [{ kind: "return", value: { kind: "template", parts: [{ kind: "identifier", name: "prefix" }, { kind: "literal", value: " " }, { kind: "field", name: "firstName" }] } }],
                    visibility: "public", source: SRC,
                },
                {
                    name: "primaryEmail", kind: "setter",
                    params: [{ name: "value", type: { kind: "string" } }],
                    statements: [{ kind: "assign", target: { kind: "field", name: "email" }, value: { kind: "intrinsic", op: "string.trim", receiver: { kind: "identifier", name: "value" }, args: [] } }],
                    visibility: "public", source: SRC,
                },
                {
                    name: "stash", kind: "method",
                    params: [{ name: "v", type: { kind: "string" } }],
                    statements: [{ kind: "assign", target: { kind: "field", name: "secret" }, value: { kind: "identifier", name: "v" } }],
                    visibility: "private", source: SRC,
                },
            ],
            source: { file: "user.ts", line: 1, column: 1 },
        },
    ],
    diagnostics: [],
};

describe("emitJs — method/setter behaviors", () => {
    let serverFiles: { path: string; content: string | Uint8Array }[];
    let clientFiles: { path: string; content: string | Uint8Array }[];

    before(async () => {
        serverFiles = (await emitJs(BEHAVIORS_IR, serverOnlyTarget(), RESOLVED_CONFIG)).files;
        clientFiles = (await emitJs(BEHAVIORS_IR, clientOnlyTarget(), RESOLVED_CONFIG)).files;
    });

    it("emits a method and setter into the server model .js", () => {
        const content = fileContent(serverFiles, "dist/js/server/models/user.js");
        assert.ok(content.includes("greeting(prefix) {"), "method missing");
        assert.ok(content.includes("return `${prefix} ${this.firstName}`;"), "method body wrong");
        assert.ok(content.includes("set primaryEmail(value) {"), "setter missing");
        assert.ok(content.includes("this.email = value.trim();"), "setter assign body wrong");
    });

    it("emits method/setter declarations into the server .d.ts", () => {
        const content = fileContent(serverFiles, "dist/js/server/models/user.d.ts");
        assert.ok(content.includes("greeting(prefix: string): string;"), "method decl missing");
        assert.ok(content.includes("set primaryEmail(value: string);"), "setter decl missing");
        assert.ok(content.includes("stash(v: string): void;"), "void method decl missing");
    });

    it("includes a private behavior in the server bundle but not the client", () => {
        assert.ok(fileContent(serverFiles, "dist/js/server/models/user.js").includes("stash(v) {"), "private method missing from server");
        const client = fileContent(clientFiles, "dist/js/client/models/user.js");
        assert.ok(!client.includes("stash"), "private method leaked into client bundle");
        // Public behaviors still appear in the client bundle.
        assert.ok(client.includes("greeting(prefix) {"), "public method missing from client");
        assert.ok(client.includes("set primaryEmail(value) {"), "public setter missing from client");
    });
});

// ─── Self-referential Reference<T> must not self-import ─────────────────────────

const SELF_REF_IR: KeymaIR = {
    irVersion: "2.0.0",
    compilerVersion: "0.1.0",
    schemas: [
        {
            id: "schema:node", name: "node", sourceName: "Node", visibility: "public",
            fields: [
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, validators: [], formatters: [], extensions: { schema: { indexes: [{ unique: true }] } }, source: SRC },
                { name: "parent", type: { kind: "reference", schema: "node", idType: { kind: "id" } }, visibility: "public", readonly: false, required: false, validators: [], formatters: [], source: SRC },
            ],
            source: { file: "node.ts", line: 1, column: 1 },
        },
    ],
    diagnostics: [],
};

describe("emitJs — self-referential reference", () => {
    it("does not emit an import of the class into its own model file", async () => {
        const files = (await emitJs(SELF_REF_IR, serverOnlyTarget(), RESOLVED_CONFIG)).files;
        const js = fileContent(files, "dist/js/server/models/node.js");
        assert.ok(!/^import \{ Node \} from/m.test(js), "model self-imports its own class");
        // The ref is still resolvable via the embedded refs map.
        assert.ok(js.includes(`["node", Node]`), "self-ref should remain in the refs map");

        const dts = fileContent(files, "dist/js/server/models/node.d.ts");
        assert.ok(!/^import type \{ Node \} from/m.test(dts), ".d.ts self-imports its own class");
    });
});
