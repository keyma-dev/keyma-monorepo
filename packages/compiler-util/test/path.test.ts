import { test } from "node:test";
import assert from "node:assert/strict";
import path, { dirname, basename, isAbsolute, resolve, relative, join, sep, posix } from "../src/path.js";
import { moduleOf, isLocal, identitySanitizer } from "../src/module-path.js";

test("sep is POSIX and posix === self", () => {
    assert.equal(sep, "/");
    assert.equal(posix.sep, "/");
    assert.equal(path.sep, "/");
    assert.equal(path.posix.join("a", "b"), "a/b");
});

test("dirname", () => {
    assert.equal(dirname("/a/b/c.ts"), "/a/b");
    assert.equal(dirname("/a"), "/");
    assert.equal(dirname("a"), ".");
    assert.equal(dirname("a/b"), "a");
    assert.equal(dirname(""), ".");
});

test("basename", () => {
    assert.equal(basename("/a/b/c.ts"), "c.ts");
    assert.equal(basename("c.ts"), "c.ts");
    assert.equal(basename("/a/b/"), "b");
    assert.equal(basename("/"), "");
});

test("isAbsolute", () => {
    assert.equal(isAbsolute("/a/b"), true);
    assert.equal(isAbsolute("a/b"), false);
    assert.equal(isAbsolute(""), false);
});

test("resolve anchors on the first absolute segment", () => {
    assert.equal(resolve("/root/src", "user.ts"), "/root/src/user.ts");
    assert.equal(resolve("/root/src", "../a/b.ts"), "/root/a/b.ts");
    assert.equal(resolve("/a/b/c"), "/a/b/c");
});

test("relative mirrors node:path.posix.relative", () => {
    assert.equal(relative("/r/a", "/r/a/b"), "b");
    assert.equal(relative("/r", "/x"), "../x");
    assert.equal(relative("/a/b", "/a/b"), "");
    // The shape relModuleSpecifier depends on: from a bundle module's dir to a sibling.
    assert.equal(relative(dirname("models/user"), "types"), "../types");
    assert.equal(relative(dirname("models/user/user"), "validators"), "../../validators");
});

test("join", () => {
    assert.equal(join("models", "user"), "models/user");
    assert.equal(join("/a", "b", "c.js"), "/a/b/c.js");
    assert.equal(join("a", "..", "b"), "b");
});

test("backslash inputs are normalized to POSIX", () => {
    assert.equal(dirname("\\proj\\src\\user.ts"), "/proj/src");
    assert.equal(relative("/r\\a", "/r\\a\\b"), "b");
    assert.equal(basename("a\\b\\c.ts"), "c.ts");
    assert.equal(moduleOf("/root\\auth\\user.ts", "/root", identitySanitizer), "auth/user");
});

test("moduleOf derives a sanitized POSIX module path from the source stem", () => {
    assert.equal(moduleOf("/root/auth/user.ts", "/root", identitySanitizer), "auth/user");
    assert.equal(moduleOf("/root/user.ts", "/root", identitySanitizer), "user");
    assert.equal(moduleOf("/root/x.ts", undefined, identitySanitizer), "x");
    assert.equal(moduleOf("/root/a/b/c.ts", "/root", (s) => s.replace(/-/g, "_")), "a/b/c");
});

test("isLocal", () => {
    assert.equal(isLocal("/root/auth/user.ts", "/root"), true);
    assert.equal(isLocal("/elsewhere/lib.ts", "/root"), false);
    assert.equal(isLocal("/anything.ts", undefined), true);
});
