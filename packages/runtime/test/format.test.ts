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
    it("runs a formatter attached directly to the field metadata", () => {
        const s = schemaWithFormatter("v", "save", reverse);
        const value: Record<string, unknown> = { v: "abc" };
        format(s, value, "save");
        assert.equal(value["v"], "cba");
    });

    it("fields without formatters are no-ops", () => {
        const s: SchemaMetadata = {
            name: "t", sourceName: "T",
            fields: [{ name: "v", type: { kind: "string" }, required: false }],
        };
        const value: Record<string, unknown> = { v: "  hi  " };
        format(s, value, "save");
        assert.equal(value["v"], "  hi  ");
    });

    it("absent values are skipped", () => {
        const s = schemaWithFormatter("v", "save", upper);
        const value: Record<string, unknown> = {};
        format(s, value, "save");
        assert.equal("v" in value, false);
    });

    it("phase filtering: only applies formatters with matching phase", () => {
        const s: SchemaMetadata = {
            name: "t", sourceName: "T",
            fields: [{
                name: "v", type: { kind: "string" }, required: false,
                formatters: [{ phase: "save", fn: lower }, { phase: "change", fn: upper }],
            }],
        };
        const v1: Record<string, unknown> = { v: "AbC" };
        format(s, v1, "save");
        assert.equal(v1["v"], "abc");

        const v2: Record<string, unknown> = { v: "AbC" };
        format(s, v2, "change");
        assert.equal(v2["v"], "ABC");
    });

    it("a parameterized formatter factory closes over its params", () => {
        const truncate = (max: number): FormatterFn => (v) => (typeof v === "string" && v.length > max ? v.slice(0, max) : v);
        const s = schemaWithFormatter("v", "save", truncate(3));
        const value: Record<string, unknown> = { v: "abcdef" };
        format(s, value, "save");
        assert.equal(value["v"], "abc");
    });

    it("formats inherited fields by walking the base chain", () => {
        const base: SchemaMetadata = {
            name: "base", sourceName: "Base",
            fields: [{ name: "name", type: { kind: "string" }, required: false, formatters: [{ phase: "save", fn: upper }] }],
        };
        const leaf: SchemaMetadata = {
            name: "leaf", sourceName: "Leaf", base,
            fields: [{ name: "nick", type: { kind: "string" }, required: false, formatters: [{ phase: "save", fn: lower }] }],
        };
        const value: Record<string, unknown> = { name: "ab", nick: "CD" };
        format(leaf, value, "save");
        assert.equal(value["name"], "AB");
        assert.equal(value["nick"], "cd");
    });
});
