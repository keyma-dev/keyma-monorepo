import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "./harness.js";
import * as CODES from "../../src/frontend-ts/diagnostics.js";
import type { IRService } from "@keyma/core/ir";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}

function errorCodes(result: ReturnType<typeof cv>): string[] {
    return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

function hasError(result: ReturnType<typeof cv>, code: string): boolean {
    return result.diagnostics.some((d) => d.code === code && d.severity === "error");
}

function serviceOf(result: ReturnType<typeof cv>, sourceName: string): IRService {
    const s = (result.ir.services ?? []).find((s) => s.sourceName === sourceName);
    assert.ok(s !== undefined, `service ${sourceName} not found`);
    return s!;
}

describe("services — remote call contracts", () => {
    it("lowers abstract method signatures (params, return, void, Promise peeled)", () => {
        const result = cv({
            "svc.ts": `
                import { Schema, Service } from "@keyma/schema/dsl";
                @Schema({ ephemeral: true }) export class In { declare name: string; }
                @Schema({ ephemeral: true }) export class Out { declare msg: string; }
                @Service()
                export abstract class Greeter {
                    abstract greet(input: In): Out;
                    abstract shout(text: string): Promise<string>;
                    abstract ping(): void;
                    abstract list(): Out[];
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const svc = serviceOf(result, "Greeter");
        assert.equal(svc.name, "Greeter");
        assert.equal(svc.visibility, "public");
        assert.equal(svc.methods.length, 4);

        const greet = svc.methods.find((m) => m.name === "greet")!;
        assert.deepEqual(greet.params, [{ name: "input", type: { kind: "reference", schema: "in" } }]);
        assert.deepEqual(greet.returnType, { kind: "reference", schema: "out" });

        const shout = svc.methods.find((m) => m.name === "shout")!;
        assert.deepEqual(shout.params, [{ name: "text", type: { kind: "string" } }]);
        assert.deepEqual(shout.returnType, { kind: "string" }); // Promise<string> peeled

        const ping = svc.methods.find((m) => m.name === "ping")!;
        assert.equal(ping.returnType, undefined); // void → no return type

        const list = svc.methods.find((m) => m.name === "list")!;
        assert.deepEqual(list.returnType, { kind: "array", of: { kind: "reference", schema: "out" } });
    });

    it("allows async-shaped contracts (no KEYMA082)", () => {
        const result = cv({
            "svc.ts": `
                import { Service } from "@keyma/schema/dsl";
                @Service() export abstract class S { abstract work(n: number): Promise<number>; }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        assert.equal(hasError(result, CODES.KEYMA082), false);
    });

    it("honours @Service options (name, private) and method visibility", () => {
        const result = cv({
            "svc.ts": `
                import { Service } from "@keyma/schema/dsl";
                @Service({ name: "Billing", private: true })
                export abstract class BillingService {
                    abstract charge(amount: number): boolean;
                    protected abstract internalReconcile(): void;
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const svc = serviceOf(result, "BillingService");
        assert.equal(svc.name, "Billing");
        assert.equal(svc.visibility, "private");
        assert.equal(svc.methods.find((m) => m.name === "charge")!.visibility, "public");
        assert.equal(svc.methods.find((m) => m.name === "internalReconcile")!.visibility, "private");
    });

    it("KEYMA093 — rejects a concrete (non-abstract) method", () => {
        const result = cv({
            "svc.ts": `
                import { Service } from "@keyma/schema/dsl";
                @Service() export abstract class S {
                    abstract ok(): void;
                    greet(): string { return "hi"; }
                }
            `,
        });
        assert.equal(hasError(result, CODES.KEYMA093), true);
    });

    it("KEYMA092 — requires explicit parameter/return types", () => {
        const result = cv({
            "svc.ts": `
                import { Service } from "@keyma/schema/dsl";
                @Service() export abstract class S { abstract bad(p): string; }
            `,
        });
        assert.equal(hasError(result, CODES.KEYMA092), true);
    });

    it("KEYMA095 — rejects @Service combined with @Schema", () => {
        const result = cv({
            "svc.ts": `
                import { Schema, Service } from "@keyma/schema/dsl";
                @Service() @Schema() export abstract class S { abstract go(): void; }
            `,
        });
        assert.equal(hasError(result, CODES.KEYMA095), true);
    });

    it("KEYMA096 — public service must not expose a private schema", () => {
        const result = cv({
            "svc.ts": `
                import { Schema, Service } from "@keyma/schema/dsl";
                @Schema({ private: true }) export class Secret { declare token: string; }
                @Service() export abstract class S { abstract leak(s: Secret): void; }
            `,
        });
        assert.equal(hasError(result, CODES.KEYMA096), true);
    });

    it("KEYMA097 — rejects a service name colliding with a schema name", () => {
        const result = cv({
            "svc.ts": `
                import { Schema, Service } from "@keyma/schema/dsl";
                @Schema({ name: "Billing" }) export class Bill { declare id: string; }
                @Service({ name: "Billing" }) export abstract class BillingService { abstract go(): void; }
            `,
        });
        assert.equal(hasError(result, CODES.KEYMA097), true);
    });

    it("emits no services key when there are none", () => {
        const result = cv({
            "schema.ts": `import { Schema } from "@keyma/schema/dsl"; @Schema() export class A { declare id: string; }`,
        });
        assert.equal(result.ir.services, undefined);
    });
});
