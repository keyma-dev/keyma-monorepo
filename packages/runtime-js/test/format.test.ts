import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    format,
    type FormatterRegistry,
} from "../src/format.js";
import type { SchemaMetadata } from "../src/types.js";

function schemaWithFormatter(
    fieldName: string,
    phase: string,
    formatterName: string,
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
                formatters: [{ phase, spec: { name: formatterName, ...extra } }],
            },
        ],
    };
}

describe("format — custom registry", () => {
    it("registered formatter runs by name", async () => {
        const registry: FormatterRegistry = new Map();
        registry.set("reverse", (v, _spec, _context) =>
            typeof v === "string" ? v.split("").reverse().join("") : v,
        );
        const s = schemaWithFormatter("v", "save", "reverse");
        const value: Record<string, unknown> = { v: "abc" };
        await format(s, value, "save", registry);
        assert.equal(value["v"], "cba");
    });

    it("unknown names are silently skipped", async () => {
        const s = schemaWithFormatter("v", "save", "doesNotExist");
        const value: Record<string, unknown> = { v: "abc" };
        await format(s, value, "save", new Map());
        assert.equal(value["v"], "abc");
    });

    it("default registry is empty — formatters are no-ops without an explicit registry", async () => {
        const s = schemaWithFormatter("v", "save", "trim");
        const value: Record<string, unknown> = { v: "  hi  " };
        await format(s, value, "save");
        assert.equal(value["v"], "  hi  ");
    });

    it("phase filtering: only applies formatters with matching phase", async () => {
        const registry: FormatterRegistry = new Map();
        registry.set("lower", (v) => typeof v === "string" ? v.toLowerCase() : v);
        registry.set("upper", (v) => typeof v === "string" ? v.toUpperCase() : v);
        const s: SchemaMetadata = {
            name: "t",
            sourceName: "T",
            fields: [
                {
                    name: "v",
                    type: { kind: "string" },
                    required: false,
                    formatters: [
                        { phase: "save", spec: { name: "lower" } },
                        { phase: "change", spec: { name: "upper" } },
                    ],
                },
            ],
        };
        const v1: Record<string, unknown> = { v: "AbC" };
        await format(s, v1, "save", registry);
        assert.equal(v1["v"], "abc");

        const v2: Record<string, unknown> = { v: "AbC" };
        await format(s, v2, "change", registry);
        assert.equal(v2["v"], "ABC");
    });

    it("flattenParams: params nested under params key are spread into spec for registry fn", async () => {
        const registry: FormatterRegistry = new Map();
        registry.set("truncate", (v, spec) => {
            const max = typeof spec["maxLength"] === "number" ? spec["maxLength"] : Infinity;
            return typeof v === "string" && v.length > max ? v.slice(0, max) : v;
        });
        const s = schemaWithFormatter("v", "save", "truncate", { params: { maxLength: 3 } });
        const value: Record<string, unknown> = { v: "abcdef" };
        await format(s, value, "save", registry);
        assert.equal(value["v"], "abc");
    });
});
