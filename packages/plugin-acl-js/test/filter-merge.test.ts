import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    combineAnd,
    combineNor,
    combineOr,
    substituteFilter,
    substitutePlaceholders,
} from "../src/filter-merge.js";

describe("substitutePlaceholders", () => {
    it("$self resolves to ctx.identity.id", () => {
        const r = substitutePlaceholders("$self", { identity: { id: "u1" } });
        assert.deepEqual(r, { ok: true, value: "u1" });
    });

    it("$self unresolvable when identity missing", () => {
        const r = substitutePlaceholders("$self", {});
        assert.deepEqual(r, { ok: false });
    });

    it("$ctx.tenant resolves via dotted path", () => {
        const r = substitutePlaceholders("$ctx.tenant", { tenant: "t1" });
        assert.deepEqual(r, { ok: true, value: "t1" });
    });

    it("nested object is walked", () => {
        const r = substitutePlaceholders(
            { author: { $eq: "$self" }, tenant: "$ctx.tenant" },
            { identity: { id: "u1" }, tenant: "t1" },
        );
        assert.deepEqual(r, {
            ok: true,
            value: { author: { $eq: "u1" }, tenant: "t1" },
        });
    });

    it("array of placeholders", () => {
        const r = substitutePlaceholders(
            { author: { $in: ["$self", "shared"] } },
            { identity: { id: "u1" } },
        );
        assert.deepEqual(r, {
            ok: true,
            value: { author: { $in: ["u1", "shared"] } },
        });
    });

    it("unresolvable anywhere in the tree fails the whole filter", () => {
        const r = substituteFilter(
            { author: "$self", tenant: "$ctx.tenant" },
            { tenant: "t1" }, // no identity
        );
        assert.equal(r, undefined);
    });

    it("non-placeholder strings pass through unchanged", () => {
        const r = substitutePlaceholders(
            { status: "active", count: 5, flag: true },
            {},
        );
        assert.deepEqual(r, {
            ok: true,
            value: { status: "active", count: 5, flag: true },
        });
    });
});

describe("combineAnd", () => {
    it("empty list → match all", () => {
        assert.deepEqual(combineAnd([]), {});
    });

    it("single filter → unwrapped", () => {
        assert.deepEqual(combineAnd([{ a: 1 }]), { a: 1 });
    });

    it("multiple → $and", () => {
        assert.deepEqual(combineAnd([{ a: 1 }, { b: 2 }]), {
            $and: [{ a: 1 }, { b: 2 }],
        });
    });

    it("empty filter ({} = match all) is dropped", () => {
        assert.deepEqual(combineAnd([{ a: 1 }, {}, { b: 2 }]), {
            $and: [{ a: 1 }, { b: 2 }],
        });
    });

    it("undefined entries are dropped", () => {
        assert.deepEqual(combineAnd([{ a: 1 }, undefined, { b: 2 }]), {
            $and: [{ a: 1 }, { b: 2 }],
        });
    });
});

describe("combineOr", () => {
    it("any matches-all collapses to {}", () => {
        assert.deepEqual(combineOr([{ a: 1 }, {}]), {});
    });

    it("single → unwrapped", () => {
        assert.deepEqual(combineOr([{ a: 1 }]), { a: 1 });
    });

    it("multiple → $or", () => {
        assert.deepEqual(combineOr([{ a: 1 }, { b: 2 }]), {
            $or: [{ a: 1 }, { b: 2 }],
        });
    });
});

describe("combineNor", () => {
    it("empty → matches all ({})", () => {
        assert.deepEqual(combineNor([]), {});
    });

    it("non-empty → $nor", () => {
        assert.deepEqual(combineNor([{ banned: true }]), {
            $nor: [{ banned: true }],
        });
    });
});

describe("combined merge — ACL pipeline shape", () => {
    it("user filter AND allow-OR with $self substituted", () => {
        const ctx = { identity: { id: "alice" } };
        const allow1 = substituteFilter({ author: "$self" }, ctx);
        const allow2 = substituteFilter({ public: true }, ctx);
        const allowOr = combineOr([allow1!, allow2!]);
        const merged = combineAnd([{ archived: false }, allowOr]);
        assert.deepEqual(merged, {
            $and: [
                { archived: false },
                { $or: [{ author: "alice" }, { public: true }] },
            ],
        });
    });

    it("with denies → AND(user, allowOr, NOR(denies))", () => {
        const ctx = { identity: { id: "alice" } };
        const allow = substituteFilter({ author: "$self" }, ctx);
        const deny = substituteFilter({ flagged: true }, ctx);
        const allowOr = combineOr([allow!]);
        const denyNor = combineNor([deny!]);
        const merged = combineAnd([{ archived: false }, allowOr, denyNor]);
        assert.deepEqual(merged, {
            $and: [
                { archived: false },
                { author: "alice" },
                { $nor: [{ flagged: true }] },
            ],
        });
    });

    it("unresolved $self drops that allow rule from the OR", () => {
        const ctx = {}; // anon
        const allow1 = substituteFilter({ author: "$self" }, ctx);
        const allow2 = substituteFilter({ public: true }, ctx);
        // allow1 unresolvable → undefined
        const allowFilters = [allow1, allow2].filter(
            (f): f is Record<string, unknown> => f !== undefined,
        );
        const allowOr = combineOr(allowFilters);
        assert.deepEqual(allowOr, { public: true });
    });
});
