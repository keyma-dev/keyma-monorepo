import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Schema, Validate, Indexed, Format } from "../src/decorators.js";
import {
    isRequired, minLength, maxLength, min, max, isEmailAddress,
    isUrl, isUuid, isPhoneNumber, isInteger, oneOf, pattern,
    minItems, maxItems, uniqueItems, customValidator,
} from "../src/validators.js";
import {
    trim, lowercase, normalizeEmail, normalizePhone, truncate,
    slugify, customFormatter,
} from "../src/formatters.js";

describe("@keyma/dsl decorators", () => {
    it("Schema is a no-op class decorator factory", () => {
        const decorator = Schema({ name: "user", private: false });
        assert.equal(typeof decorator, "function");
        // Applying it returns undefined
        assert.equal(decorator(class {}), undefined);
    });

    it("Schema works with no options", () => {
        const decorator = Schema();
        assert.equal(typeof decorator, "function");
    });

    it("Validate is a no-op property decorator factory", () => {
        const decorator = Validate(isRequired, minLength(2));
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
        const decorator = Format("change", trim, lowercase);
        assert.equal(typeof decorator, "function");
    });
});

describe("validator markers", () => {
    it("parameterless markers have a __validatorKind property", () => {
        const markers = [isRequired, isEmailAddress, isInteger, uniqueItems];
        for (const m of markers) {
            assert.ok("__validatorKind" in m, `${JSON.stringify(m)} missing __validatorKind`);
        }
    });

    it("parameterized markers carry their arguments", () => {
        const ml = minLength(3) as Record<string, unknown>;
        assert.equal(ml["__validatorKind"], "minLength");
        assert.equal(ml["value"], 3);

        const mx = maxLength(50) as Record<string, unknown>;
        assert.equal(mx["__validatorKind"], "maxLength");
        assert.equal(mx["value"], 50);

        const mn = min(0) as Record<string, unknown>;
        assert.equal(mn["__validatorKind"], "min");
        assert.equal(mn["value"], 0);

        const mx2 = max(100) as Record<string, unknown>;
        assert.equal(mx2["__validatorKind"], "max");
        assert.equal(mx2["value"], 100);
    });

    it("isUrl carries protocols when provided", () => {
        const v = isUrl({ protocols: ["https"] }) as Record<string, unknown>;
        assert.equal(v["__validatorKind"], "url");
        assert.deepEqual(v["protocols"], ["https"]);
    });

    it("isUrl has no protocols when not provided", () => {
        const v = isUrl() as Record<string, unknown>;
        assert.equal(v["__validatorKind"], "url");
        assert.equal("protocols" in v, false);
    });

    it("isUuid is a pattern validator", () => {
        const v = isUuid as Record<string, unknown>;
        assert.equal(v["__validatorKind"], "pattern");
        assert.ok(typeof v["pattern"] === "string");
    });

    it("isPhoneNumber carries region when provided", () => {
        const v = isPhoneNumber({ region: "US" }) as Record<string, unknown>;
        assert.equal(v["__validatorKind"], "phoneNumber");
        assert.equal(v["region"], "US");
    });

    it("oneOf carries values", () => {
        const v = oneOf(["draft", "published"]) as Record<string, unknown>;
        assert.equal(v["__validatorKind"], "oneOf");
        assert.deepEqual(v["values"], ["draft", "published"]);
    });

    it("pattern accepts a RegExp", () => {
        const v = pattern(/^\d+$/) as Record<string, unknown>;
        assert.equal(v["__validatorKind"], "pattern");
        assert.equal(v["pattern"], "^\\d+$");
    });

    it("pattern accepts a string", () => {
        const v = pattern("^\\d+$") as Record<string, unknown>;
        assert.equal(v["__validatorKind"], "pattern");
        assert.equal(v["pattern"], "^\\d+$");
    });

    it("minItems and maxItems carry value", () => {
        assert.equal((minItems(1) as Record<string, unknown>)["value"], 1);
        assert.equal((maxItems(10) as Record<string, unknown>)["value"], 10);
    });

    it("customValidator carries name", () => {
        const v = customValidator("myCheck") as Record<string, unknown>;
        assert.equal(v["__validatorKind"], "custom");
        assert.equal(v["name"], "myCheck");
    });
});

describe("formatter markers", () => {
    it("scalar formatters have a __formatterKind property", () => {
        const markers = [trim, lowercase, normalizeEmail, slugify];
        for (const m of markers) {
            assert.ok("__formatterKind" in m, `${JSON.stringify(m)} missing __formatterKind`);
        }
    });

    it("normalizePhone carries region when provided", () => {
        const f = normalizePhone({ region: "US" }) as Record<string, unknown>;
        assert.equal(f["__formatterKind"], "normalizePhone");
        assert.equal(f["region"], "US");
    });

    it("normalizePhone has no region when not provided", () => {
        const f = normalizePhone() as Record<string, unknown>;
        assert.equal(f["__formatterKind"], "normalizePhone");
        assert.equal("region" in f, false);
    });

    it("truncate carries maxLength", () => {
        const f = truncate(80) as Record<string, unknown>;
        assert.equal(f["__formatterKind"], "truncate");
        assert.equal(f["maxLength"], 80);
    });

    it("customFormatter carries name", () => {
        const f = customFormatter("myFormatter") as Record<string, unknown>;
        assert.equal(f["__formatterKind"], "custom");
        assert.equal(f["name"], "myFormatter");
    });
});

describe("DSL usage example", () => {
    it("composes decorators without runtime errors", () => {
        // This test verifies that the DSL can be used in a realistic way without
        // throwing at runtime. The actual semantics are enforced by the compiler.
        assert.doesNotThrow(() => {
            @Schema({ name: "user" })
            class User {
                @Validate(isRequired)
                @Indexed({ unique: true })
                declare id: string;

                @Validate(isRequired, minLength(2), maxLength(64))
                @Format("change", trim)
                @Format("save", normalizeEmail)
                declare email: string;

                @Validate(isRequired, min(0), max(150))
                declare age: number;

                @Validate(oneOf(["admin", "member"]))
                declare role: string;
            }

            // Force reference to suppress unused-variable warnings
            return User;
        });
    });
});
