import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { KeymaIR } from "@keyma/ir";
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
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, validators: [{ name: "required" }], formatters: [], indexes: [{ unique: true }], source: SRC },
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
            source: SRC,
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
                    indexes: [], source: SRC,
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
                    source: SRC,
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
