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

    it("lowers f-strings", () => {
        const expr = {
            kind: "template" as const,
            parts: [{ kind: "field" as const, name: "first" }, { kind: "literal" as const, value: " " }, { kind: "field" as const, name: "last" }],
        };
        assert.equal(exprToPython(expr), `f"{self.first} {self.last}"`);
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

    it("maps nullable to Optional", () => {
        assert.equal(irTypeToPython({ kind: "nullable", of: { kind: "string" } }), "Optional[str]");
    });

    it("maps array to List", () => {
        assert.equal(irTypeToPython({ kind: "array", of: { kind: "string" } }), "List[str]");
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
        assert.ok(content.includes("return f\"{self.firstName} {self.lastName}\""), "Wrong property expression");
        assert.ok(content.includes("User.schema = {"), "Missing schema metadata");
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
});
