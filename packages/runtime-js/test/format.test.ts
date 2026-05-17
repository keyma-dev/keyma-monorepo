import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    format,
    createDefaultFormatterRegistry,
    type FormatterRegistry,
} from "../src/format.js";
import type { SchemaMetadata } from "../src/types.js";

function schemaWithFormatter(
    fieldName: string,
    phase: string,
    kind: string,
    extra: Record<string, unknown> = {},
): SchemaMetadata {
    return {
        name: "test",
        sourceName: "Test",
        fields: [
            {
                name: fieldName,
                type: { kind: "string" },
                required: false,
                formatters: [{ phase, spec: { kind, ...extra } }],
            },
        ],
    };
}

describe("format — default registry", () => {
    it("trim", async () => {
        const s = schemaWithFormatter("v", "save", "trim");
        const value: Record<string, unknown> = { v: "  hi  " };
        await format(s, value, "save");
        assert.equal(value["v"], "hi");
    });

    it("lowercase / uppercase / capitalize / titleCase", async () => {
        const cases: Array<[string, string, string]> = [
            ["lowercase", "ABC", "abc"],
            ["uppercase", "abc", "ABC"],
            ["capitalize", "alice", "Alice"],
            ["titleCase", "hello world", "Hello World"],
        ];
        for (const [kind, input, expected] of cases) {
            const s = schemaWithFormatter("v", "save", kind);
            const value: Record<string, unknown> = { v: input };
            await format(s, value, "save");
            assert.equal(value["v"], expected, `${kind} failed`);
        }
    });

    it("normalizeEmail and normalizeWhitespace", async () => {
        const e = schemaWithFormatter("v", "save", "normalizeEmail");
        const v1: Record<string, unknown> = { v: "  User@Example.COM  " };
        await format(e, v1, "save");
        assert.equal(v1["v"], "user@example.com");

        const w = schemaWithFormatter("v", "save", "normalizeWhitespace");
        const v2: Record<string, unknown> = { v: "  hello   world  " };
        await format(w, v2, "save");
        assert.equal(v2["v"], "hello world");
    });

    it("truncate respects maxLength from spec", async () => {
        const s = schemaWithFormatter("v", "save", "truncate", { maxLength: 3 });
        const value: Record<string, unknown> = { v: "abcdef" };
        await format(s, value, "save");
        assert.equal(value["v"], "abc");
    });

    it("slugify", async () => {
        const s = schemaWithFormatter("v", "save", "slugify");
        const value: Record<string, unknown> = { v: "Hello World!" };
        await format(s, value, "save");
        assert.equal(value["v"], "hello-world");
    });

    it("phase filtering: only applies formatters with matching phase", async () => {
        const s: SchemaMetadata = {
            name: "t",
            sourceName: "T",
            fields: [
                {
                    name: "v",
                    type: { kind: "string" },
                    required: false,
                    formatters: [
                        { phase: "save", spec: { kind: "lowercase" } },
                        { phase: "change", spec: { kind: "uppercase" } },
                    ],
                },
            ],
        };
        const v1: Record<string, unknown> = { v: "AbC" };
        await format(s, v1, "save");
        assert.equal(v1["v"], "abc");

        const v2: Record<string, unknown> = { v: "AbC" };
        await format(s, v2, "change");
        assert.equal(v2["v"], "ABC");
    });

    it("non-string values are passed through unchanged", async () => {
        const s = schemaWithFormatter("v", "save", "trim");
        const value: Record<string, unknown> = { v: 42 };
        await format(s, value, "save");
        assert.equal(value["v"], 42);
    });
});

describe("format — custom registry", () => {
    it("registered formatter runs by kind", async () => {
        const registry: FormatterRegistry = createDefaultFormatterRegistry();
        registry.set("reverse", (v, _spec, _context) =>
            typeof v === "string" ? v.split("").reverse().join("") : v,
        );
        const s = schemaWithFormatter("v", "save", "reverse");
        const value: Record<string, unknown> = { v: "abc" };
        await format(s, value, "save", registry);
        assert.equal(value["v"], "cba");
    });

    it("unknown kinds are silently skipped", async () => {
        const s = schemaWithFormatter("v", "save", "doesNotExist");
        const value: Record<string, unknown> = { v: "abc" };
        await format(s, value, "save");
        assert.equal(value["v"], "abc");
    });
});
