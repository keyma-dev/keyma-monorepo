import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileVirtual } from "./harness.js";
import * as CODES from "../../src/frontend-ts/diagnostics.js";

// Decision 12: validators/formatters are synthesized into plain synchronous methods, so an
// `async` factory or inner function is rejected at the frontend (KEYMA026).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

function cv(sources: Record<string, string>) {
    return compileVirtual(sources, { baseDir: VIRTUAL_BASE });
}
function hasError(result: ReturnType<typeof cv>, code: string): boolean {
    return result.diagnostics.some((d) => d.code === code && d.severity === "error");
}

describe("async validators/formatters are rejected (decision 12)", () => {
    it("rejects an async inner validator function", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Validate } from "@keyma/schema/dsl";
                import type { ValidatorFn } from "@keyma/schema/dsl";
                export function asyncInner(): ValidatorFn<string> {
                    return async (value, field) => value.includes("@") ? null : { field: field, code: "x", message: "x" };
                }
                @Schema() class Foo {
                    @Validate(asyncInner())
                    declare x: string;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA026), JSON.stringify(result.diagnostics));
    });

    it("rejects an async validator factory", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Validate } from "@keyma/schema/dsl";
                import type { ValidatorFn } from "@keyma/schema/dsl";
                export async function asyncFactory(): ValidatorFn<string> {
                    return (value, field) => null;
                }
                @Schema() class Foo {
                    @Validate(asyncFactory())
                    declare x: string;
                }
            `,
        });
        assert.ok(hasError(result, CODES.KEYMA026), JSON.stringify(result.diagnostics));
    });

    it("accepts a synchronous validator (no KEYMA026)", () => {
        const result = cv({
            "schema.ts": `
                import { Schema, Validate } from "@keyma/schema/dsl";
                import type { ValidatorFn } from "@keyma/schema/dsl";
                export function syncValidator(): ValidatorFn<string> {
                    return (value, field) => value.includes("@") ? null : { field: field, code: "x", message: "x" };
                }
                @Schema() class Foo {
                    @Validate(syncValidator())
                    declare x: string;
                }
            `,
        });
        assert.equal(hasError(result, CODES.KEYMA026), false, JSON.stringify(result.diagnostics));
    });
});
