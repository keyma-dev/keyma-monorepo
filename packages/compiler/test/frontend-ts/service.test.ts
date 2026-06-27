import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "../../src/frontend-ts/index.js";
import type { IRService } from "@keyma/core/ir";

// Resolve module specifiers (`@keyma/core/dsl`) from inside the compiler package's node_modules.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, "..", "..", "src", "frontend-ts");

function cv(sources: Record<string, string>) {
    // No domains registered: `@Service` discovery/extraction is a built-in compiler base pass,
    // so services are produced even with zero frontend domains.
    return compileVirtual(sources, { baseDir: BASE });
}

function errorCodes(result: ReturnType<typeof cv>): string[] {
    return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

function serviceOf(result: ReturnType<typeof cv>, sourceName: string): IRService {
    const s = (result.ir.services ?? []).find((x) => x.sourceName === sourceName);
    assert.ok(s !== undefined, `service ${sourceName} not found`);
    return s!;
}

describe("base @Service pass — compiler-owned, domain-agnostic", () => {
    it("discovers @Service imported directly from @keyma/core/dsl (no domains)", () => {
        const result = cv({
            "svc.ts": `
                import { Service } from "@keyma/core/dsl";
                @Service()
                export abstract class Greeter {
                    abstract greet(name: string): string;
                    abstract ping(): void;
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const svc = serviceOf(result, "Greeter");
        assert.equal(svc.name, "Greeter");
        assert.equal(svc.visibility, "public");
        assert.equal(svc.methods.length, 2);
        assert.deepEqual(svc.methods.find((m) => m.name === "greet")!.params, [
            { name: "name", type: { kind: "string" } },
        ]);
        assert.equal(svc.methods.find((m) => m.name === "ping")!.returnType, undefined);
    });

    it("discovers @Service imported through an `export *` re-export (umbrella) — by core identity", () => {
        // Mirrors how `@keyma/schema/dsl` re-exports the core `@Service`. The base pass matches
        // the decorator by resolving its alias to the `@keyma/core/dsl` declaration, so it is
        // recognized regardless of which umbrella module the author imported it through.
        const result = cv({
            "dsl.ts": `export * from "@keyma/core/dsl";`,
            "svc.ts": `
                import { Service } from "./dsl.js";
                @Service({ name: "Billing", private: true })
                export abstract class BillingService {
                    abstract charge(amount: number): boolean;
                }
            `,
        });
        assert.deepEqual(errorCodes(result), [], JSON.stringify(result.diagnostics));
        const svc = serviceOf(result, "BillingService");
        assert.equal(svc.name, "Billing");
        assert.equal(svc.visibility, "private");
        assert.equal(svc.methods.length, 1);
    });

    it("emits no services key when there are none", () => {
        const result = cv({ "empty.ts": `export const x = 1;` });
        assert.equal(result.ir.services, undefined);
    });
});
