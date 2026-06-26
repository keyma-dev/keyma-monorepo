import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Schema, Validate, Indexed, Format, Ephemeral } from "../../src/dsl/index.js";
import type { ValidatorFn, FormatterFn } from "../../src/dsl/index.js";

// ── Sample ValidatorFn / FormatterFn factories for testing ────────────────────

function required(): ValidatorFn<string> {
    return (value, field) => (value.length > 0 ? null : { field, code: "required", message: `${field} is required` });
}
function minLength(m: number): ValidatorFn<string> {
    return (value, field) => (value.length >= m ? null : { field, code: "minLength", message: `${field} too short` });
}
function trim(): FormatterFn<string> {
    return (value) => value.trim();
}
function lowercase(): FormatterFn<string> {
    return (value) => value.toLowerCase();
}

const testValidator = required();
const testValidator2 = minLength(2);
const testFormatter = trim();
const testFormatter2 = lowercase();

// ── Decorator smoke tests ─────────────────────────────────────────────────────

describe("@keyma/schema/dsl decorators", () => {
    it("Schema is a no-op class decorator factory", () => {
        const decorator = Schema({ name: "user", private: false });
        assert.equal(typeof decorator, "function");
        assert.equal(decorator(class {}), undefined);
    });

    it("Schema works with no options", () => {
        const decorator = Schema();
        assert.equal(typeof decorator, "function");
    });

    it("Validate is a no-op property decorator factory", () => {
        const decorator = Validate(testValidator, testValidator2);
        assert.equal(typeof decorator, "function");
    });

    it("Indexed is a no-op property decorator factory", () => {
        const decorator = Indexed({ unique: true });
        assert.equal(typeof decorator, "function");
    });

    it("Indexed works with no options", () => {
        assert.equal(typeof Indexed(), "function");
    });

    it("Format is a no-op property decorator factory", () => {
        const decorator = Format("change", testFormatter, testFormatter2);
        assert.equal(typeof decorator, "function");
    });

    it("Ephemeral is a no-op property decorator", () => {
        assert.equal(typeof Ephemeral, "function");
    });
});

// ── Validator / Formatter authoring tests ────────────────────────────────────

describe("validator/formatter factories", () => {
    it("a validator factory returns a ValidatorFn that produces an error or null", () => {
        const fn = minLength(2);
        assert.equal(typeof fn, "function");
        assert.equal(fn("ok", "name", { object: {} }), null);
        assert.deepEqual(fn("x", "name", { object: {} }), { field: "name", code: "minLength", message: "name too short" });
    });

    it("a formatter factory returns a FormatterFn that transforms the value", () => {
        const fn = trim();
        assert.equal(typeof fn, "function");
        assert.equal(fn("  hi  ", { object: {} }), "hi");
    });
});

// ── DSL composition test ──────────────────────────────────────────────────────

describe("DSL usage example", () => {
    it("composes decorators without runtime errors", () => {
        assert.doesNotThrow(() => {
            @Schema({ name: "user" })
            class User {
                @Validate(testValidator)
                @Indexed({ unique: true })
                declare id: string;

                @Validate(testValidator, testValidator2)
                @Format("change", testFormatter)
                @Format("save", testFormatter2)
                declare email: string;
            }

            return User;
        });
    });
});

// ── New authoring-surface API (Phase 5/6) ─────────────────────────────────────

import {
    Computed, Phase, FormField, Deprecated,
} from "../../src/dsl/index.js";

describe("@keyma/schema/dsl new authoring API", () => {
    it("Phase exposes the lifecycle constants", () => {
        assert.deepEqual(Phase, { Change: "change", Blur: "blur", Submit: "submit", Save: "save" });
    });

    it("@Computed/@FormField/@Deprecated are no-op property decorators", () => {
        for (const make of [
            () => Computed(),
            () => FormField({ title: "x" }),
            () => Deprecated("gone"),
        ]) {
            const d = make();
            assert.equal(typeof d, "function");
            assert.equal(d({}, "field"), undefined);
        }
    });
});
