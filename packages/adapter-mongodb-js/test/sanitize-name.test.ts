import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCollectionName } from "../src/sanitize-name.js";

describe("sanitizeCollectionName", () => {
    it("preserves a valid, case-sensitive name verbatim", () => {
        assert.equal(sanitizeCollectionName("user"), "user");
        assert.equal(sanitizeCollectionName("blog_user"), "blog_user");
        assert.equal(sanitizeCollectionName("Orders"), "Orders");
    });

    it("replaces $, ., and whitespace (reserved/illegal in collection names)", () => {
        assert.equal(sanitizeCollectionName("Order$Item"), "Order_Item");
        assert.equal(sanitizeCollectionName("a.b"), "a_b");
        assert.equal(sanitizeCollectionName("a b"), "a_b");
        // "system." prefix is neutralized because "." is replaced.
        assert.equal(sanitizeCollectionName("system.users"), "system_users");
    });

    it("is deterministic", () => {
        assert.equal(sanitizeCollectionName("x$y"), sanitizeCollectionName("x$y"));
    });
});
