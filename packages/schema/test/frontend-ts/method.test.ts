import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "./harness.js";
import * as CODES from "../../src/frontend-ts/diagnostics.js";

// Generic method/setter behavior lowering (params/return/visibility/void, KEYMA092, setter assign
// bodies, async) is domain-neutral and now lives in @keyma/compiler's frontend-ts/method.test.ts
// (and async.test.ts). What remains here is schema-specific: assignment is gated OUT of a
// validator/formatter body (the portable subset for those is read-only).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}
function hasError(result: ReturnType<typeof cv>, code: string): boolean {
    return result.diagnostics.some((d) => d.code === code && d.severity === "error");
}

describe("assignment is gated to behavior bodies", () => {
    it("rejects assignment inside a validator body", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Validate } from "@keyma/schema/dsl";
                import type { ValidatorFn } from "@keyma/schema/dsl";
                export function mutate(): ValidatorFn<string> {
                    return (value, field, ctx) => {
                        value = "x";
                        return null;
                    };
                }
                @Schema() class Foo {
                    @Validate(mutate())
                    declare x: string;
                }
            `,
        });
        // Assignment is not part of the validator/formatter portable subset.
        assert.ok(hasError(result, CODES.KEYMA082), JSON.stringify(result.diagnostics));
    });
});
