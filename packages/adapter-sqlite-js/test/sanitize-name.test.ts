import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTableName } from "../src/sanitize-name.js";

describe("sanitizeTableName", () => {
    it("preserves a name that is already a valid identifier", () => {
        assert.equal(sanitizeTableName("user"), "user");
        assert.equal(sanitizeTableName("blog_user"), "blog_user");
        assert.equal(sanitizeTableName("Order"), "Order"); // case preserved
    });

    it("collapses non-word characters to _", () => {
        assert.equal(sanitizeTableName("Order$Item"), "Order_Item");
        assert.equal(sanitizeTableName("a.b-c"), "a_b_c");
    });

    it("prefixes a leading digit with _", () => {
        assert.equal(sanitizeTableName("2fa"), "_2fa");
    });

    it("is deterministic", () => {
        assert.equal(sanitizeTableName("x$y"), sanitizeTableName("x$y"));
    });
});
