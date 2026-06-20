/**
 * End-to-end RPC services through the generated service contracts, the
 * KeymaServer dispatch and a direct transport — the path a real client takes
 * when invoking `Keyma.call`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keyma } from "@keyma/runtime-js";
import {
    makeHarness,
    validSignupInput,
    validInviteInput,
    AccountService,
    AdminService,
} from "./setup.ts";

describe("services — public AccountService via Keyma.call", () => {
    it("signup returns a SignupResult with id and token", async () => {
        const { transport } = makeHarness();

        const resp = await Keyma.mutation({
            s: Keyma.call(AccountService, "signup", { input: validSignupInput() }),
        }).request({}, { inputs: {}, transport });

        assert.equal(resp.results.s.ok, true, JSON.stringify(resp.results.s));
        if (resp.results.s.ok) {
            const data = resp.results.s.data as { id: string; token: string };
            assert.equal(typeof data.id, "string");
            assert.equal(typeof data.token, "string");
            assert.ok(data.id.length > 0, "id is non-empty");
            assert.ok(data.token.length > 0, "token is non-empty");
        }
    });

    it("invite → resend(known) → resend(unknown) → pending() share service state", async () => {
        const { transport } = makeHarness();

        const invited = await Keyma.mutation({
            i: Keyma.call(AccountService, "invite", { input: validInviteInput() }),
        }).request({}, { inputs: {}, transport });

        assert.equal(invited.results.i.ok, true, JSON.stringify(invited.results.i));
        if (invited.results.i.ok) {
            const data = invited.results.i.data as { id: string; token: string };
            assert.equal(typeof data.id, "string");
            assert.equal(typeof data.token, "string");
        }

        // resend for the just-invited email -> true; an unknown email -> false.
        const resends = await Keyma.mutation({
            known: Keyma.call(AccountService, "resend", { email: "invitee@example.com" }),
            unknown: Keyma.call(AccountService, "resend", { email: "nobody@nowhere.com" }),
        }).request({}, { inputs: {}, transport });

        assert.equal(resends.results.known.ok, true, JSON.stringify(resends.results.known));
        assert.equal(resends.results.known.ok && resends.results.known.data, true);
        assert.equal(resends.results.unknown.ok, true, JSON.stringify(resends.results.unknown));
        assert.equal(resends.results.unknown.ok && resends.results.unknown.data, false);

        // pending() returns a non-empty array (state persisted across calls).
        const pend = await Keyma.query({
            p: Keyma.call(AccountService, "pending", {}),
        }).request({}, { inputs: {}, transport });

        assert.equal(pend.results.p.ok, true, JSON.stringify(pend.results.p));
        if (pend.results.p.ok) {
            const arr = pend.results.p.data as unknown[];
            assert.ok(Array.isArray(arr), "pending returns an array");
            assert.ok(arr.length >= 1, "pending is non-empty after one invite");
        }
    });

    it("signup with a bad email fails VALIDATION_FAILED (ephemeral input args are validated)", async () => {
        const { transport } = makeHarness();

        const resp = await Keyma.mutation({
            s: Keyma.call(AccountService, "signup", { input: validSignupInput({ email: "bad" }) }),
        }).request({}, { inputs: {}, transport });

        assert.equal(resp.results.s.ok, false, JSON.stringify(resp.results.s));
        if (!resp.results.s.ok) {
            assert.equal(resp.results.s.code, "VALIDATION_FAILED");
            assert.ok(Array.isArray(resp.results.s.errors), "carries field errors");
            assert.ok(
                resp.results.s.errors.some((e: { field: string }) => e.field === "email"),
                "email error present",
            );
        }
    });

    it("signup with a mismatched confirmPassword fails VALIDATION_FAILED", async () => {
        const { transport } = makeHarness();

        const resp = await Keyma.mutation({
            s: Keyma.call(AccountService, "signup", {
                input: validSignupInput({ confirmPassword: "different-one" }),
            }),
        }).request({}, { inputs: {}, transport });

        assert.equal(resp.results.s.ok, false, JSON.stringify(resp.results.s));
        if (!resp.results.s.ok) {
            assert.equal(resp.results.s.code, "VALIDATION_FAILED");
            assert.ok(
                resp.results.s.errors.some(
                    (e: { code: string }) => e.code === "password_mismatch",
                ),
                "confirmPassword mismatch surfaces password_mismatch",
            );
        }
    });
});

describe("services — private AdminService visibility", () => {
    it("non-system caller cannot see the private service (SERVICE_NOT_FOUND)", async () => {
        const { transport } = makeHarness();

        const resp = await Keyma.mutation({
            p: Keyma.call(AdminService, "purge", { email: "x@y.com" }),
        }).request({}, { inputs: {}, transport });

        assert.equal(resp.results.p.ok, false, JSON.stringify(resp.results.p));
        if (!resp.results.p.ok) {
            assert.equal(resp.results.p.code, "SERVICE_NOT_FOUND");
        }
    });

    it("system caller can purge and read stats", async () => {
        const { transport } = makeHarness({ identity: { isSystem: true } });

        const purged = await Keyma.mutation({
            p: Keyma.call(AdminService, "purge", { email: "x@y.com" }),
        }).request({}, { inputs: {}, transport });

        assert.equal(purged.results.p.ok, true, JSON.stringify(purged.results.p));
        assert.equal(purged.results.p.ok && purged.results.p.data, true);

        const stats = await Keyma.query({
            s: Keyma.call(AdminService, "stats", {}),
        }).request({}, { inputs: {}, transport });

        assert.equal(stats.results.s.ok, true, JSON.stringify(stats.results.s));
        if (stats.results.s.ok) {
            assert.equal(typeof stats.results.s.data, "object");
            assert.notEqual(stats.results.s.data, null, "stats returns an object");
        }
    });
});
