import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { KeymaIR, IRExpression } from "@keyma/ir";
import { emitPython } from "../src/backend.js";
import { exprToPython } from "../src/emit-expression.js";
import { irTypeToPython } from "../src/ir-type-to-python.js";
import type { PythonTargetConfig } from "../src/types.js";

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
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, validators: [], formatters: [], indexes: [{ unique: true }], source: SRC },
                { name: "firstName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], indexes: [], source: SRC },
                { name: "lastName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], indexes: [], source: SRC },
                {
                    name: "fullName", type: { kind: "string" }, visibility: "public", readonly: true, required: true,
                    validators: [], formatters: [], indexes: [],
                    computed: {
                        expression: { kind: "template", parts: [{ kind: "field", name: "firstName" }, { kind: "literal", value: " " }, { kind: "field", name: "lastName" }] },
                    },
                    source: SRC,
                },
            ],
            indexes: [],
            source: { file: "user.ts", line: 1, column: 1 },
        },
    ],
    diagnostics: [],
};

const RESOLVED_CONFIG = {
    source: [], outDir: "dist", targets: [],
};

function fileContent(files: { path: string; content: string | Uint8Array }[], filePath: string): string {
    const f = files.find((f) => f.path === filePath);
    assert.ok(f !== undefined, `File not found: ${filePath}`);
    return f.content as string;
}

describe("exprToPython", () => {
    it("lowers a literal string", () => {
        assert.equal(exprToPython({ kind: "literal", value: "hello" }), `"hello"`);
    });

    it("lowers True/False/None", () => {
        assert.equal(exprToPython({ kind: "literal", value: true }), "True");
        assert.equal(exprToPython({ kind: "literal", value: false }), "False");
        assert.equal(exprToPython({ kind: "literal", value: null }), "None");
    });

    it("lowers template literals to string concatenation", () => {
        const expr = {
            kind: "template" as const,
            parts: [{ kind: "field" as const, name: "first" }, { kind: "literal" as const, value: " " }, { kind: "field" as const, name: "last" }],
        };
        assert.equal(exprToPython(expr), `(str(self.first) + " " + str(self.last))`);
    });

    it("lowers conditional", () => {
        const expr = {
            kind: "conditional" as const,
            condition: { kind: "field" as const, name: "ok" },
            whenTrue: { kind: "literal" as const, value: 1 },
            whenFalse: { kind: "literal" as const, value: 0 },
        };
        assert.equal(exprToPython(expr), "1 if self.ok else 0");
    });
});

describe("exprToPython — Date", () => {
    const dateNew = (...args: IRExpression[]): IRExpression => ({
        kind: "new", callee: { kind: "identifier", name: "Date" }, args,
    });
    const num = (value: number): IRExpression => ({ kind: "literal", value });
    const dateIntrinsic = (op: string): IRExpression => ({
        kind: "intrinsic", op, receiver: { kind: "field", name: "created" }, args: [],
    });

    it("`new Date()` → datetime.now()", () => {
        assert.equal(exprToPython(dateNew()), "datetime.now()");
    });

    it("`new Date(2020, 0, 1)` → datetime with 1-based month and default day", () => {
        assert.equal(exprToPython(dateNew(num(2020), num(0), num(1))), "datetime(2020, 1, 1)");
        // 2 args: day defaults to 1 (Python requires it).
        assert.equal(exprToPython(dateNew(num(2020), num(0))), "datetime(2020, 1, 1)");
    });

    it("`new Date(y, m, d, h, min, s, ms)` → ms folded to microseconds", () => {
        assert.equal(
            exprToPython(dateNew(num(2020), num(0), num(1), num(13), num(30), num(15), num(500))),
            "datetime(2020, 1, 1, 13, 30, 15, 500000)",
        );
    });

    it("`new Date(<number literal>)` → datetime.fromtimestamp(n / 1000)", () => {
        assert.equal(exprToPython(dateNew(num(1700000000000))), "datetime.fromtimestamp(1700000000000 / 1000)");
    });

    it("`new Date(<string literal>)` → datetime.fromisoformat(s)", () => {
        assert.equal(
            exprToPython(dateNew({ kind: "literal", value: "2020-01-02T03:04:05Z" })),
            `datetime.fromisoformat("2020-01-02T03:04:05Z")`,
        );
    });

    it("`new Date(<dynamic>)` → single-eval runtime disambiguation", () => {
        assert.equal(
            exprToPython(dateNew({ kind: "identifier", name: "value" })),
            "(datetime.fromisoformat(_x) if isinstance((_x := value), str) else datetime.fromtimestamp(_x / 1000))",
        );
    });

    it("maps Date accessors to naive-local datetime equivalents", () => {
        assert.equal(exprToPython(dateIntrinsic("date.getFullYear")), "self.created.year");
        assert.equal(exprToPython(dateIntrinsic("date.getMonth")), "(self.created.month - 1)");
        assert.equal(exprToPython(dateIntrinsic("date.getDate")), "self.created.day");
        assert.equal(exprToPython(dateIntrinsic("date.getDay")), "((self.created.weekday() + 1) % 7)");
        assert.equal(exprToPython(dateIntrinsic("date.getHours")), "self.created.hour");
        assert.equal(exprToPython(dateIntrinsic("date.getMilliseconds")), "(self.created.microsecond // 1000)");
        assert.equal(
            exprToPython(dateIntrinsic("date.getTime")),
            "(int(self.created.timestamp()) * 1000 + self.created.microsecond // 1000)",
        );
        assert.equal(
            exprToPython(dateIntrinsic("date.toISOString")),
            `self.created.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")`,
        );
    });

    it("maps the static `Date.now()` (receiver null) to epoch milliseconds", () => {
        assert.equal(
            exprToPython({ kind: "intrinsic", op: "date.now", receiver: null, args: [] }),
            "int(datetime.now().timestamp() * 1000)",
        );
    });

    it("self-parenthesizes a compound Date accessor inside a binary expression", () => {
        // Guards the precedence footgun: `d.getMonth() * 2` must not emit `self.x.month - 1 * 2`.
        const expr: IRExpression = {
            kind: "binary", op: "*",
            left: dateIntrinsic("date.getMonth"),
            right: num(2),
        };
        assert.equal(exprToPython(expr), "(self.created.month - 1) * 2");
    });
});

describe("irTypeToPython", () => {
    it("maps basic types", () => {
        assert.equal(irTypeToPython({ kind: "string" }), "str");
        assert.equal(irTypeToPython({ kind: "number" }), "float");
        assert.equal(irTypeToPython({ kind: "integer" }), "int");
        assert.equal(irTypeToPython({ kind: "boolean" }), "bool");
    });

    it("maps reference to the schema name", () => {
        assert.equal(irTypeToPython({ kind: "reference", schema: "User" }), "User");
    });

    it("maps embedded to the schema name", () => {
        assert.equal(irTypeToPython({ kind: "embedded", schema: "Address" }), "Address");
    });

    it("maps array to List", () => {
        assert.equal(irTypeToPython({ kind: "array", of: { kind: "string" } }), "List[str]");
    });

    it("maps array with nullable elements to List[Optional[...]]", () => {
        assert.equal(
            irTypeToPython({ kind: "array", of: { kind: "string" }, elementNullable: true }),
            "List[Optional[str]]",
        );
    });
});

describe("emitPython", () => {
    it("emits a model with class and schema", async () => {
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(BASIC_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/models/user.py");
        
        assert.ok(content.includes("class User:"), "Missing class declaration");
        assert.ok(content.includes("def __init__(self, value: Dict[str, Any] = None):"), "Missing constructor");
        assert.ok(content.includes("self.firstName: str = value.get(\"firstName\")"), "Missing field assignment");
        assert.ok(content.includes("@property"), "Missing property decorator");
        assert.ok(content.includes("def fullName(self) -> str:"), "Missing property getter");
        assert.ok(content.includes("return (str(self.firstName) + \" \" + str(self.lastName))"), "Wrong property expression");
        assert.ok(content.includes("User.schema = {"), "Missing schema metadata");
        assert.ok(content.includes("from datetime import datetime, timezone"), "Missing timezone import (needed by toISOString)");
    });

    it("renders a nullable field as Optional via field.nullable", async () => {
        const NULLABLE_IR: KeymaIR = {
            irVersion: "1.0.0", compilerVersion: "0.1.0",
            schemas: [
                {
                    id: "schema:thing", name: "thing", sourceName: "Thing", visibility: "public",
                    fields: [
                        { name: "nickname", type: { kind: "string" }, nullable: true, visibility: "public", readonly: false, required: true, validators: [], formatters: [], indexes: [], source: SRC },
                    ],
                    indexes: [], source: { file: "thing.ts", line: 1, column: 1 },
                },
            ],
            diagnostics: [],
        };
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(NULLABLE_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/models/thing.py");

        assert.ok(content.includes("self.nickname: Optional[str] = value.get(\"nickname\")"), "Nullable field not rendered as Optional");
    });

    it("emits index.py with re-exports", async () => {
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(BASIC_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/index.py");
        
        assert.ok(content.includes("from .models.user import User"), "Missing re-export");
    });

    it("emits schema with fields and refs", async () => {
        const REF_IR: KeymaIR = {
            irVersion: "1.0.0", compilerVersion: "0.1.0", sourceRoot: ".",
            schemas: [
                { id: "s1", name: "u", sourceName: "U", visibility: "public", fields: [], indexes: [], source: { file: "u.ts", line: 1, column: 1 } },
                {
                    id: "s2", name: "p", sourceName: "P", visibility: "public",
                    fields: [{ name: "a", type: { kind: "reference", schema: "U" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], indexes: [], source: SRC }],
                    indexes: [], source: { file: "p.ts", line: 1, column: 1 }
                }
            ],
            diagnostics: [],
        };
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(REF_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/models/p.py");
        
        assert.ok(content.includes('"fields":'), "Missing fields in schema");
        assert.ok(content.includes('"refs": {"U": U}'), "Missing refs in schema");

        // Verify comma: should have '],' then newline then whitespace then '"refs":'
        assert.ok(/\],\n\s+"refs":/.test(content), "Missing comma before refs");
    });

    it("emits methods and both setter forms as Python class members", async () => {
        const BEHAVIORS_IR: KeymaIR = {
            irVersion: "2.0.0", compilerVersion: "0.1.0",
            schemas: [
                {
                    id: "schema:user", name: "user", sourceName: "User", visibility: "public",
                    fields: [
                        { name: "firstName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], indexes: [], source: SRC },
                        { name: "email", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [], formatters: [], indexes: [], source: SRC },
                        {
                            name: "fullName", type: { kind: "string" }, visibility: "public", readonly: true, required: true,
                            validators: [], formatters: [], indexes: [],
                            computed: { expression: { kind: "field", name: "firstName" } },
                            source: SRC,
                        },
                    ],
                    indexes: [],
                    methods: [
                        {
                            name: "greeting", kind: "method",
                            params: [{ name: "prefix", type: { kind: "string" } }],
                            returnType: { kind: "string" },
                            statements: [{ kind: "return", value: { kind: "intrinsic", op: "string.toUpperCase", receiver: { kind: "field", name: "firstName" }, args: [] } }],
                            visibility: "public", source: SRC,
                        },
                        {
                            // Paired with the `fullName` computed getter → @fullName.setter form.
                            name: "fullName", kind: "setter",
                            params: [{ name: "value", type: { kind: "string" } }],
                            statements: [{ kind: "assign", target: { kind: "field", name: "firstName" }, value: { kind: "identifier", name: "value" } }],
                            visibility: "public", source: SRC,
                        },
                        {
                            // No matching getter → property(None, ...) form.
                            name: "primaryEmail", kind: "setter",
                            params: [{ name: "value", type: { kind: "string" } }],
                            statements: [{ kind: "assign", target: { kind: "field", name: "email" }, value: { kind: "intrinsic", op: "string.trim", receiver: { kind: "identifier", name: "value" }, args: [] } }],
                            visibility: "public", source: SRC,
                        },
                    ],
                    source: { file: "user.ts", line: 1, column: 1 },
                },
            ],
            diagnostics: [],
        };
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(BEHAVIORS_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/models/user.py");

        assert.ok(content.includes("def greeting(self, prefix):"), "method def missing");
        assert.ok(content.includes("return self.firstName.upper()"), "method body wrong");
        assert.ok(content.includes("@fullName.setter"), "paired setter form missing");
        assert.ok(content.includes("self.firstName = value"), "paired setter body wrong");
        assert.ok(content.includes("def _set_primaryEmail(self, value):"), "standalone setter helper missing");
        assert.ok(content.includes("self.email = value.strip()"), "standalone setter body wrong");
        assert.ok(content.includes("primaryEmail = property(None, _set_primaryEmail)"), "property wiring missing");
    });
});

describe("emitPython — validators module", () => {
    const VALIDATORS_IR: KeymaIR = {
        irVersion: "1.0.0", compilerVersion: "0.1.0",
        schemas: [
            {
                id: "schema:item", name: "item", sourceName: "Item", visibility: "public",
                fields: [{ name: "name", type: { kind: "string" }, visibility: "public", readonly: false, required: true, validators: [{ name: "minLength", params: { value: 2 } }], formatters: [], indexes: [], source: SRC }],
                indexes: [], source: SRC,
            },
        ],
        validatorDeclarations: [
            {
                name: "minLength", factoryParams: [{ name: "value" }], inputType: { kind: "string" },
                body: {
                    params: [{ name: "raw", role: "value" }, { name: "field", role: "field" }],
                    statements: [{ kind: "return", value: { kind: "literal", value: null } }],
                },
                source: SRC,
            },
        ],
        diagnostics: [],
    };

    it("the injected type-guard returns a ValidationError dict, not a string", async () => {
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(VALIDATORS_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/validators.py");
        assert.ok(
            content.includes(`return {"field": field, "code": "type_error", "message": "expected string"}`),
            "type-guard must return a ValidationError dict",
        );
        assert.ok(!content.includes(`return "expected string"`), "must not return a bare string");
    });
});
