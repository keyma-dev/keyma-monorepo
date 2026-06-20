import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeLabel } from "../src/sanitize-name.js";

describe("sanitizeLabel", () => {
    it("preserves a valid label verbatim", () => {
        assert.equal(sanitizeLabel("wrote"), "wrote");
        assert.equal(sanitizeLabel("blog_wrote"), "blog_wrote");
        assert.equal(sanitizeLabel("User"), "User"); // case preserved
    });

    it("collapses whitespace and punctuation to _", () => {
        assert.equal(sanitizeLabel("has tag"), "has_tag");
        assert.equal(sanitizeLabel("a.b$c"), "a_b_c");
    });

    it("is deterministic", () => {
        assert.equal(sanitizeLabel("x y"), sanitizeLabel("x y"));
    });
});
