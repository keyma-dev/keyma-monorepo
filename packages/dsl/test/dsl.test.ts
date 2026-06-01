import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Schema, Validate, Indexed, Format, Validator, Formatter, Ephemeral } from "../src/decorators.js";
import type { ValidatorRef, FormatterRef } from "../src/types.js";

// ── Sample ValidatorRef and FormatterRef for testing ─────────────────────────

const testValidator: ValidatorRef = { __validatorName: "required" };
const testValidator2: ValidatorRef = { __validatorName: "minLength", params: { value: 2 } };
const testFormatter: FormatterRef = { __formatterName: "trim" };
const testFormatter2: FormatterRef = { __formatterName: "lowercase" };

// ── Decorator smoke tests ─────────────────────────────────────────────────────

describe("@keyma/dsl decorators", () => {
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

// ── Validator / Formatter function tests ─────────────────────────────────────

describe("Validator(name, fn)", () => {
    it("returns a factory function", () => {
        const minLength = Validator("minLength", (value: number) => (_raw: unknown) => null);
        assert.equal(typeof minLength, "function");
    });

    it("calling the factory returns a ValidatorRef with the registered name", () => {
        const minLength = Validator("minLength", (value: number) => (_raw: unknown) => null);
        const ref = minLength(5);
        assert.equal(ref.__validatorName, "minLength");
    });

    it("works with zero factory params", () => {
        const isRequired = Validator("required", () => (_raw: unknown) => null);
        const ref = isRequired();
        assert.equal(ref.__validatorName, "required");
    });
});

describe("Formatter(name, fn)", () => {
    it("returns a factory function", () => {
        const trim = Formatter("trim", () => (v: unknown) => v);
        assert.equal(typeof trim, "function");
    });

    it("calling the factory returns a FormatterRef with the registered name", () => {
        const trim = Formatter("trim", () => (v: unknown) => v);
        const ref = trim();
        assert.equal(ref.__formatterName, "trim");
    });

    it("works with factory params", () => {
        const maxLen = Formatter("maxLen", (limit: number) => (v: unknown) => v);
        const ref = maxLen(100);
        assert.equal(ref.__formatterName, "maxLen");
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
