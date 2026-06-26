/**
 * Validation pipeline — end-to-end through the server create flow and via the
 * low-level `validate()` runtime helper.
 *
 * The E2E half drives `Keyma.mutation(...).request(...)` through `makeHarness()`'s
 * direct transport: a create that breaks exactly one field must come back as a
 * per-leaf failure carrying `code: "VALIDATION_FAILED"` and an `.errors` array of
 * `{ field, code, message }` entries.
 *
 * The direct half calls `validate(schema, value)` straight against the generated
 * schema metadata (and one synthetic schema) to probe the skip/required rules.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keyma, validate, applyDefaults } from "@keyma/runtime/schema";
import {
    makeHarness,
    validAuthor,
    validPost,
    validComment,
    validShowcase,
    validSignupInput,
    Author,
    Post,
    Comment,
    Showcase,
    SignupInput,
    AccountService,
} from "./setup.ts";

type Failure = { ok: false; code?: string; errors?: Array<{ field: string; code: string; message?: string }> };

/** Assert a leaf failed validation and that `.errors` carries the expected pair. */
function assertValidationError(
    leaf: { ok: boolean } & Record<string, unknown>,
    field: string,
    code: string,
): void {
    assert.equal(leaf.ok, false, `expected leaf to fail; got ${JSON.stringify(leaf)}`);
    const f = leaf as unknown as Failure;
    assert.equal(f.code, "VALIDATION_FAILED", `expected VALIDATION_FAILED; got ${JSON.stringify(f)}`);
    assert.ok(Array.isArray(f.errors), `failure should carry .errors; got ${JSON.stringify(f)}`);
    const hit = f.errors!.some((e) => e.field === field && e.code === code);
    assert.ok(
        hit,
        `expected error {field:"${field}", code:"${code}"} in ${JSON.stringify(f.errors)}`,
    );
}

/** Create a single record through the server and return its leaf result. */
async function create(Cls: unknown, data: Record<string, unknown>) {
    const { transport } = makeHarness();
    const resp = await Keyma.mutation({
        x: Keyma.create(Cls as any, data),
    }).request({}, { inputs: {}, transport });
    return resp.results.x;
}

describe("validation — e2e create → VALIDATION_FAILED with .errors", () => {
    it("a fully-valid create succeeds", async () => {
        const r = await create(Author, validAuthor());
        assert.equal(r.ok, true, JSON.stringify(r));
    });

    it("Author email — isEmail → emailAddress", async () => {
        const r = await create(Author, validAuthor({ email: "not-an-email" }));
        assertValidationError(r, "email", "emailAddress");
    });

    it("Author firstName too short — minLength", async () => {
        const r = await create(Author, validAuthor({ firstName: "A" }));
        assertValidationError(r, "firstName", "minLength");
    });

    it("Author username reserved value — notReserved → reserved", async () => {
        const r = await create(Author, validAuthor({ username: "admin" }));
        assertValidationError(r, "username", "reserved");
    });

    it("Author username bad pattern — pattern", async () => {
        // Uppercase + punctuation violate ^[a-z0-9_]+$; length (3..20) still ok.
        const r = await create(Author, validAuthor({ username: "Bad!Name" }));
        assertValidationError(r, "username", "pattern");
    });

    it("Post tags duplicated — hasUniqueItems → uniqueItems", async () => {
        const r = await create(
            Post,
            validPost({ tags: ["dup", "dup"], rating: 0, views: 0 }),
        );
        assertValidationError(r, "tags", "uniqueItems");
    });

    it("Post price bad format — pattern", async () => {
        const r = await create(Post, validPost({ price: "9.999", rating: 0, views: 0 }));
        assertValidationError(r, "price", "pattern");
    });

    it("Post rating out of range — max", async () => {
        // 7 is a multiple of 0.5 so only the max(5) rule should trip.
        const r = await create(Post, validPost({ rating: 7 }));
        assertValidationError(r, "rating", "max");
    });

    it("Post rating not a multiple of 0.5 — multipleOf", async () => {
        // 2.3 is in [0,5] but not a multiple of 0.5.
        const r = await create(Post, validPost({ rating: 2.3 }));
        assertValidationError(r, "rating", "multipleOf");
    });

    it("Post views non-integer — isInteger → integer", async () => {
        const r = await create(Post, validPost({ views: 1.5 }));
        assertValidationError(r, "views", "integer");
    });

    it("Comment authorIp bad — isIpAddress → ipAddress", async () => {
        const r = await create(Comment, validComment({ authorIp: "999.999.999.999" }));
        assertValidationError(r, "authorIp", "ipAddress");
    });

    it("Comment countryCode wrong length — length", async () => {
        const r = await create(Comment, validComment({ countryCode: "USA" }));
        assertValidationError(r, "countryCode", "length");
    });

    it("Showcase adjustment not negative — isNegative → negative", async () => {
        const r = await create(Showcase, validShowcase({ adjustment: 5 }));
        assertValidationError(r, "adjustment", "negative");
    });

    it("Showcase balance positive — isNonPositive → nonPositive", async () => {
        const r = await create(Showcase, validShowcase({ balance: 1 }));
        assertValidationError(r, "balance", "nonPositive");
    });

    it("Showcase ipv6 invalid — isIpAddress('v6') → ipAddress", async () => {
        const r = await create(Showcase, validShowcase({ ipv6: "not-an-ip" }));
        assertValidationError(r, "ipv6", "ipAddress");
    });
});

describe("validation — direct validate()", () => {
    it("skips absent OPTIONAL fields on an otherwise-complete record", async () => {
        // Build a record the way the create flow does (defaults + id), with every
        // OPTIONAL validated field (username/website/phone/bio/...) left absent.
        // Those are required:false, so they are skipped — no validator errors.
        const record = applyDefaults(Author.schema, {
            id: "a1",
            email: "good@x.com",
            firstName: "Al",
            lastName: "Ng",
        });
        const errs = await validate(Author.schema, record);
        assert.deepEqual(errs, []);
    });

    it("absent REQUIRED fields fail with code 'required' (required by default)", async () => {
        const errs = await validate(Author.schema, { email: "good@x.com" });
        // firstName/lastName carry no required:false -> required -> absent -> error.
        assert.ok(errs.some((e) => e.field === "firstName" && e.code === "required"), JSON.stringify(errs));
        assert.ok(errs.some((e) => e.field === "lastName" && e.code === "required"), JSON.stringify(errs));
        // optional fields are NOT reported as required.
        assert.ok(!errs.some((e) => e.field === "username"), JSON.stringify(errs));
    });

    it("reports the emailAddress error for a present bad email", async () => {
        const errs = await validate(Author.schema, validAuthor({ email: "bad" }));
        assert.ok(
            errs.some((e) => e.field === "email" && e.code === "emailAddress"),
            JSON.stringify(errs),
        );
    });

    it("custom notReserved fires on a present reserved username", async () => {
        const errs = await validate(Author.schema, validAuthor({ username: "admin" }));
        assert.ok(
            errs.some((e) => e.field === "username" && e.code === "reserved"),
            JSON.stringify(errs),
        );
    });

    it("cross-field matchesPassword fails when confirmPassword differs", async () => {
        const errs = await validate(SignupInput.schema, {
            email: "a@b.com",
            password: "abcdefgh",
            confirmPassword: "different",
        });
        assert.ok(
            errs.some((e) => e.field === "confirmPassword" && e.code === "password_mismatch"),
            JSON.stringify(errs),
        );
    });

    it("cross-field matchesPassword passes when confirmPassword matches", async () => {
        const errs = await validate(SignupInput.schema, {
            email: "a@b.com",
            password: "abcdefgh",
            confirmPassword: "abcdefgh",
        });
        assert.ok(
            !errs.some((e) => e.code === "password_mismatch"),
            JSON.stringify(errs),
        );
    });

    it("required is the default; only required:false fields are optional", async () => {
        // The JS backend omits the flag for required fields and emits required:false
        // for `?` fields. validate() treats anything that is not required:false as
        // required: an absent one fails with code "required", an absent optional is skipped.
        const synthetic = {
            name: "t",
            sourceName: "T",
            fields: [
                { name: "req", type: { kind: "string" } }, // required (no flag)
                { name: "opt", type: { kind: "string" }, required: false }, // optional
            ],
        } as never;

        const missing = await validate(synthetic, {});
        assert.equal(missing.length, 1, JSON.stringify(missing));
        assert.equal(missing[0]!.field, "req");
        assert.equal(missing[0]!.code, "required");

        const present = await validate(synthetic, { req: "v" });
        assert.deepEqual(present, []);
    });
});

describe("validation — cross-field validated as a service arg", () => {
    it("signup with mismatched confirmPassword fails VALIDATION_FAILED", async () => {
        const { transport } = makeHarness();
        const resp = await Keyma.mutation({
            x: Keyma.call(AccountService, "signup", {
                input: validSignupInput({ confirmPassword: "nope" }),
            }),
        }).request({}, { inputs: {}, transport });
        assertValidationError(resp.results.x, "confirmPassword", "password_mismatch");
    });

    it("signup with matching confirmPassword succeeds", async () => {
        const { transport } = makeHarness();
        const resp = await Keyma.mutation({
            x: Keyma.call(AccountService, "signup", { input: validSignupInput() }),
        }).request({}, { inputs: {}, transport });
        assert.equal(resp.results.x.ok, true, JSON.stringify(resp.results.x));
    });
});
