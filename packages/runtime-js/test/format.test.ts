import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { format } from "../src/format.js";
import type { SchemaMetadata, FormatterFn } from "../src/types.js";

function schemaWithFormatter(fieldName: string, phase: string, fn: FormatterFn): SchemaMetadata {
    return {
        name: "test",
        sourceName: "Test",
        fields: [{ name: fieldName, type: { kind: "string" }, required: false, formatters: [{ phase, fn }] }],
    };
}

const reverse: FormatterFn = (v) => (typeof v === "string" ? v.split("").reverse().join("") : v);
const lower: FormatterFn = (v) => (typeof v === "string" ? v.toLowerCase() : v);
const upper: FormatterFn = (v) => (typeof v === "string" ? v.toUpperCase() : v);

describe("format — direct-ref formatters", () => {
    it("runs a formatter attached directly to the field metadata", async () => {
        const s = schemaWithFormatter("v", "save", reverse);
        const value: Record<string, unknown> = { v: "abc" };
        await format(s, value, "save");
        assert.equal(value["v"], "cba");
    });

    it("fields without formatters are no-ops", async () => {
        const s: SchemaMetadata = {
            name: "t", sourceName: "T",
            fields: [{ name: "v", type: { kind: "string" }, required: false }],
        };
        const value: Record<string, unknown> = { v: "  hi  " };
        await format(s, value, "save");
        assert.equal(value["v"], "  hi  ");
    });

    it("phase filtering: only applies formatters with matching phase", async () => {
        const s: SchemaMetadata = {
            name: "t", sourceName: "T",
            fields: [{
                name: "v", type: { kind: "string" }, required: false,
                formatters: [{ phase: "save", fn: lower }, { phase: "change", fn: upper }],
            }],
        };
        const v1: Record<string, unknown> = { v: "AbC" };
        await format(s, v1, "save");
        assert.equal(v1["v"], "abc");

        const v2: Record<string, unknown> = { v: "AbC" };
        await format(s, v2, "change");
        assert.equal(v2["v"], "ABC");
    });

    it("a parameterized formatter factory closes over its params", async () => {
        const truncate = (max: number): FormatterFn => (v) => (typeof v === "string" && v.length > max ? v.slice(0, max) : v);
        const s = schemaWithFormatter("v", "save", truncate(3));
        const value: Record<string, unknown> = { v: "abcdef" };
        await format(s, value, "save");
        assert.equal(value["v"], "abc");
    });

    it("awaits async formatters", async () => {
        const asyncUpper: FormatterFn = async (v) => (typeof v === "string" ? v.toUpperCase() : v);
        const s = schemaWithFormatter("v", "save", asyncUpper);
        const value: Record<string, unknown> = { v: "ab" };
        await format(s, value, "save");
        assert.equal(value["v"], "AB");
    });
});
