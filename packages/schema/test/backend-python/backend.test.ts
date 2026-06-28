import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { KeymaIR, IRExpression, IRStatement } from "@keyma/core/ir";
import { emitPython } from "./harness.js";
import { exprToPython } from "@keyma/compiler/backend-python";
import { renderStatements } from "@keyma/compiler/backend-python";
import { irTypeToPython } from "@keyma/compiler/backend-python";
import type { PythonTargetConfig } from "@keyma/compiler/backend-python";

const SRC = { file: "schema.ts", line: 1, column: 1 };

const BASIC_IR: KeymaIR = {
    irVersion: "1.0.0",
    compilerVersion: "0.1.0",
    classes: [
        {
            name: "user",
            sourceName: "User",
            visibility: "public",
            fields: [
                { name: "id", type: { kind: "id" }, visibility: "public", readonly: true, required: true, extensions: { schema: { indexes: [{ unique: true }] } }, source: SRC },
                { name: "firstName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, source: SRC },
                { name: "lastName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, source: SRC },
            ],
            // `fullName` is a getter behavior (a re-emitted accessor), not a schema field.
            methods: [
                {
                    name: "fullName", kind: "getter", params: [], returnType: { kind: "string" }, visibility: "public",
                    statements: [{ kind: "return", value: { kind: "template", parts: [{ kind: "field", name: "firstName" }, { kind: "literal", value: " " }, { kind: "field", name: "lastName" }] } }],
                    source: SRC,
                },
            ],
            source: { file: "user.ts", line: 1, column: 1 },
        },
    ],
    diagnostics: [],
};

const RESOLVED_CONFIG = {
    source: [], outDir: "dist", namePrefix: "", targets: [],
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

describe("exprToPython — new intrinsics (Math, coercion, map/some/every)", () => {
    const field = (name: string): IRExpression => ({ kind: "field", name });
    const intr = (op: string, args: IRExpression[]): IRExpression => ({ kind: "intrinsic", op, receiver: null, args });

    it("Math.floor/ceil/sqrt → math module; round/trunc/sign → JS-semantics shims", () => {
        assert.equal(exprToPython(intr("math.floor", [field("n")])), "math.floor(self.n)");
        assert.equal(exprToPython(intr("math.sqrt", [field("n")])), "math.sqrt(self.n)");
        assert.equal(exprToPython(intr("math.round", [field("n")])), "math_round(self.n)");
        assert.equal(exprToPython(intr("math.sign", [field("n")])), "math_sign(self.n)");
        assert.equal(exprToPython(intr("math.min", [field("a"), field("b")])), "min(self.a, self.b)");
    });

    it("String()/Number() → keyma.runtime coercion helpers", () => {
        assert.equal(exprToPython(intr("to-string", [field("n")])), "to_string(self.n)");
        assert.equal(exprToPython(intr("to-number", [field("s")])), "to_number(self.s)");
    });

    it("array.map/some/every with an expression arrow → comprehension / any / all", () => {
        const arrow = (body: IRExpression): IRExpression => ({ kind: "arrow", params: ["x"], body });
        const mk = (op: string, body: IRExpression): IRExpression => ({ kind: "intrinsic", op, receiver: field("xs"), args: [arrow(body)] });
        assert.equal(
            exprToPython(mk("array.map", { kind: "binary", op: "*", left: { kind: "identifier", name: "x" }, right: { kind: "literal", value: 2 } })),
            "[x * 2 for x in self.xs]",
        );
        assert.equal(
            exprToPython(mk("array.some", { kind: "binary", op: ">", left: { kind: "identifier", name: "x" }, right: { kind: "literal", value: 0 } })),
            "any(x > 0 for x in self.xs)",
        );
        assert.equal(
            exprToPython(mk("array.every", { kind: "binary", op: ">", left: { kind: "identifier", name: "x" }, right: { kind: "literal", value: 0 } })),
            "all(x > 0 for x in self.xs)",
        );
    });
});

describe("renderStatements — block-arrow hoisting", () => {
    it("hoists a block-arrow filter predicate to a nested def + list(filter(...))", () => {
        const blockArrow: IRExpression = {
            kind: "arrow", params: ["n"],
            statements: [
                { kind: "const", name: "x", init: { kind: "binary", op: "*", left: { kind: "identifier", name: "n" }, right: { kind: "literal", value: 2 } } },
                { kind: "return", value: { kind: "binary", op: ">", left: { kind: "identifier", name: "x" }, right: { kind: "literal", value: 10 } } },
            ],
        };
        const stmt: IRStatement = {
            kind: "return",
            value: { kind: "intrinsic", op: "array.filter", receiver: { kind: "field", name: "items" }, args: [blockArrow] },
        };
        assert.equal(renderStatements([stmt], ""), [
            "def _arrow0(n):",
            "    x = n * 2",
            "    return x > 10",
            "return list(filter(_arrow0, self.items))",
        ].join("\n"));
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

    it("ignores numeric width/sign — Python int/float are width-agnostic", () => {
        assert.equal(irTypeToPython({ kind: "integer", bits: 8 }), "int");
        assert.equal(irTypeToPython({ kind: "integer", bits: 32, unsigned: true }), "int");
        assert.equal(irTypeToPython({ kind: "integer", unsigned: true }), "int");
        assert.equal(irTypeToPython({ kind: "number", bits: 32 }), "float");
        assert.equal(irTypeToPython({ kind: "number", bits: 64 }), "float");
    });

    it("maps reference to the schema name", () => {
        assert.equal(irTypeToPython({ kind: "reference", target: "User" }), "User");
    });

    it("maps embedded to the schema name", () => {
        assert.equal(irTypeToPython({ kind: "embedded", target: "Address" }), "Address");
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
        const content = fileContent(result.files, "dist/python/src/user.py");

        assert.ok(content.includes("class User:"), "Missing class declaration");
        assert.ok(content.includes("def from_value(cls, value: Dict[str, Any] = None):"), "Missing from_value constructor");
        assert.ok(content.includes("def _hydrate(self, value: Dict[str, Any] = None):"), "Missing _hydrate");
        assert.ok(content.includes("self.firstName: str = value.get(\"firstName\")"), "Missing field assignment");
        assert.ok(content.includes("@property"), "Missing property decorator");
        assert.ok(content.includes("def fullName(self) -> str:"), "Missing property getter");
        assert.ok(content.includes("return (str(self.firstName) + \" \" + str(self.lastName))"), "Wrong property expression");
        assert.ok(content.includes("User.metadata = {"), "Missing schema metadata");
        assert.ok(content.includes("from datetime import datetime, timezone"), "Missing timezone import (needed by toISOString)");
    });

    it("renders a nullable field as Optional via field.nullable", async () => {
        const NULLABLE_IR: KeymaIR = {
            irVersion: "1.0.0", compilerVersion: "0.1.0",
            classes: [
                {
                    name: "thing", sourceName: "Thing", visibility: "public",
                    fields: [
                        { name: "nickname", type: { kind: "string" }, nullable: true, visibility: "public", readonly: false, required: true, source: SRC },
                    ],
                    source: { file: "thing.ts", line: 1, column: 1 },
                },
            ],
            diagnostics: [],
        };
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(NULLABLE_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/src/thing.py");

        assert.ok(content.includes("self.nickname: Optional[str] = value.get(\"nickname\")"), "Nullable field not rendered as Optional");
    });

    it("emits index.py with re-exports", async () => {
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(BASIC_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/index.py");

        assert.ok(content.includes("from .src.user import User"), "Missing re-export");
    });

    it("emits schema with fields and refs", async () => {
        const REF_IR: KeymaIR = {
            irVersion: "1.0.0", compilerVersion: "0.1.0", sourceRoot: ".",
            classes: [
                { name: "u", sourceName: "U", visibility: "public", fields: [], source: { file: "u.ts", line: 1, column: 1 } },
                {
                    name: "p", sourceName: "P", visibility: "public",
                    fields: [{ name: "a", type: { kind: "reference", target: "u" }, visibility: "public", readonly: false, required: true, source: SRC }],
                    source: { file: "p.ts", line: 1, column: 1 }
                }
            ],
            diagnostics: [],
        };
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(REF_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/src/p.py");
        
        assert.ok(content.includes('"fields":'), "Missing fields in schema");
        assert.ok(content.includes('"refs": {"u": U}'), "Missing refs in schema");

        // Verify comma: should have '],' then newline then whitespace then '"refs":'
        assert.ok(/\],\n\s+"refs":/.test(content), "Missing comma before refs");
    });

    it("emits methods and both setter forms as Python class members", async () => {
        const BEHAVIORS_IR: KeymaIR = {
            irVersion: "2.0.0", compilerVersion: "0.1.0",
            classes: [
                {
                    name: "user", sourceName: "User", visibility: "public",
                    fields: [
                        { name: "firstName", type: { kind: "string" }, visibility: "public", readonly: false, required: true, source: SRC },
                        { name: "email", type: { kind: "string" }, visibility: "public", readonly: false, required: true, source: SRC },
                    ],
                    methods: [
                        {
                            // A getter behavior — a re-emitted accessor, not a schema field.
                            name: "fullName", kind: "getter", params: [], returnType: { kind: "string" },
                            statements: [{ kind: "return", value: { kind: "field", name: "firstName" } }],
                            visibility: "public", source: SRC,
                        },
                        {
                            name: "greeting", kind: "method",
                            params: [{ name: "prefix", type: { kind: "string" } }],
                            returnType: { kind: "string" },
                            statements: [{ kind: "return", value: { kind: "intrinsic", op: "string.toUpperCase", receiver: { kind: "field", name: "firstName" }, args: [] } }],
                            visibility: "public", source: SRC,
                        },
                        {
                            // Paired with the `fullName` getter behavior → @fullName.setter form.
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
        const content = fileContent(result.files, "dist/python/src/user.py");

        assert.ok(content.includes("def greeting(self, prefix):"), "method def missing");
        assert.ok(content.includes("return self.firstName.upper()"), "method body wrong");
        assert.ok(content.includes("@fullName.setter"), "paired setter form missing");
        assert.ok(content.includes("self.firstName = value"), "paired setter body wrong");
        assert.ok(content.includes("def _set_primaryEmail(self, value):"), "standalone setter helper missing");
        assert.ok(content.includes("self.email = value.strip()"), "standalone setter body wrong");
        assert.ok(content.includes("primaryEmail = property(None, _set_primaryEmail)"), "property wiring missing");
    });
});

describe("emitPython — validators co-located in their source module", () => {
    const VALIDATORS_IR: KeymaIR = {
        irVersion: "1.0.0", compilerVersion: "0.1.0",
        classes: [
            {
                name: "item", sourceName: "Item", visibility: "public",
                fields: [{ name: "name", type: { kind: "string" }, visibility: "public", readonly: false, required: true, extensions: { schema: { validators: [{ name: "minLength", params: { value: 2 } }] } }, source: SRC }],
                source: SRC,
            },
        ],
        functionDeclarations: [
            {
                name: "minLength", params: [{ name: "value", type: { kind: "integer" } }],
                returnType: { kind: "function", params: [{ name: "raw", type: { kind: "string" } }, { name: "field", type: { kind: "string" } }], returns: { kind: "json" } },
                statements: [{ kind: "return", value: {
                    kind: "arrow",
                    params: [{ name: "raw", type: { kind: "string" } }, "field"],
                    statements: [{ kind: "return", value: { kind: "literal", value: null } }],
                } }],
                source: SRC,
            },
        ],
        diagnostics: [],
    };

    it("emits the factory WITHOUT an injected type-guard (typed-only, decision 6)", async () => {
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(VALIDATORS_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/src/schema.py");
        // The validator→function collapse drops the per-factory runtime type-guard: the synthesized
        // typed methods (and construction) own type-correctness, so no `type_error` branch is injected.
        assert.ok(!content.includes(`"type_error"`), "no injected type-guard / type_error branch");
        assert.ok(content.includes(`def minLength(`), "factory emitted as a plain def");
    });

    const CTX_VALIDATOR_IR: KeymaIR = {
        irVersion: "1.0.0", compilerVersion: "0.1.0",
        classes: [
            {
                name: "signup", sourceName: "Signup", visibility: "public",
                fields: [
                    { name: "password", type: { kind: "string" }, visibility: "public", readonly: false, required: true, source: SRC },
                    { name: "confirm", type: { kind: "string" }, visibility: "public", readonly: false, required: true, extensions: { schema: { validators: [{ name: "matchesPassword", params: {} }] } }, source: SRC },
                ],
                source: SRC,
            },
        ],
        functionDeclarations: [
            {
                name: "matchesPassword", params: [],
                returnType: { kind: "function", params: [{ name: "value", type: { kind: "json" } }, { name: "field", type: { kind: "string" } }, { name: "ctx", type: { kind: "json" } }], returns: { kind: "json" } },
                statements: [{ kind: "return", value: {
                    kind: "arrow",
                    params: [{ name: "value", type: { kind: "json" } }, "field", "ctx"],
                    statements: [
                        {
                            kind: "return",
                            value: {
                                kind: "member",
                                object: { kind: "member", object: { kind: "identifier", name: "ctx" }, member: "object" },
                                member: "password",
                            },
                        },
                    ],
                } }],
                source: SRC,
            },
        ],
        diagnostics: [],
    };

    it("emits the (value, field, ctx) signature as a plain factory (ctx.object is the instance, B path)", async () => {
        const target: PythonTargetConfig = { language: "python", outDir: "dist/python", library: true };
        const result = await emitPython(CTX_VALIDATOR_IR, target, RESOLVED_CONFIG);
        const content = fileContent(result.files, "dist/python/src/schema.py");
        // The factory is now a plain function (the inner arrow hoists to a nested `def`) over the
        // uniform `(value, field, ctx)` signature. Under method-driven synthesis `ctx.object` is the
        // INSTANCE, so cross-field access stays member access `ctx.object.<field>` (the legacy
        // dict-lookup rewrite is retired — §11.5; the A oracle's dict ctx is a deferred latent gap).
        assert.ok(/def _arrow\d+\(value, field, ctx\):/.test(content), "must emit the 3-arg (value, field, ctx) inner signature");
        assert.ok(content.includes("ctx.object.password"), "ctx.object.<field> stays member access (instance, not dict)");
    });
});
