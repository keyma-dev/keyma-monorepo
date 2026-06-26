import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compileVirtual, type CompileResult } from "./harness.js";
import { createKeymaNodeSystem } from "@keyma/compiler/frontend-ts/node";
import { fieldValidators, fieldFormatters } from "@keyma/schema/ir";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Package src dir — used only by the Node-overlay control case for real-fs dep resolution.
const VIRTUAL_BASE = path.join(__dirname, "..", "..", "..", "src", "frontend-ts");

// A schema that imports from all three Keyma authoring packages, forcing each to resolve
// through the virtual filesystem (no real fs).
const SOURCES = {
    "user.ts": `
        import { Schema, Validate, Format } from "@keyma/schema/dsl";
        import { minLength } from "@keyma/schema/validators";
        import { trim } from "@keyma/schema/formatters";
        @Schema() class User {
            declare id: string;
            @Validate(minLength(3))
            @Format("change", trim())
            declare name: string;
        }
    `,
};

function errorDiags(result: CompileResult) {
    return result.diagnostics.filter((d) => d.severity === "error");
}

describe("fully-virtual compile via @typescript/vfs", () => {
    it("compiles entirely in memory, resolving @keyma/schema/dsl + validators + formatters through the vfs, with no ts.sys fallback", () => {
        // Disk reads (lib files + @keyma sources) happen here, while building the system —
        // before the tripwire is armed.
        const system = createKeymaNodeSystem();

        const originalReadFile = ts.sys.readFile;
        const originalFileExists = ts.sys.fileExists;
        let touchedDisk = false;
        const tripwire = (): never => {
            touchedDisk = true;
            throw new Error("ts.sys was touched during a system-mode (virtual) compile");
        };
        let result: CompileResult;
        try {
            // Any fall-through to the real filesystem now trips the wire.
            ts.sys.readFile = tripwire as unknown as typeof ts.sys.readFile;
            ts.sys.fileExists = tripwire as unknown as typeof ts.sys.fileExists;
            result = compileVirtual(SOURCES, { system });
        } finally {
            ts.sys.readFile = originalReadFile;
            ts.sys.fileExists = originalFileExists;
        }

        assert.equal(touchedDisk, false, "system-mode compile must not touch ts.sys/the real filesystem");
        assert.deepEqual(
            errorDiags(result),
            [],
            `Unexpected errors: ${JSON.stringify(result.diagnostics)}`,
        );

        const user = result.ir.classes.find((s) => s.sourceName === "User");
        assert.ok(user, "User schema expected");
        const name = user.fields.find((f) => f.name === "name");
        assert.ok(name, "name field expected");
        assert.ok(fieldValidators(name).some((v) => v.name === "minLength"), "minLength validator expected");
        assert.ok(fieldFormatters(name).some((fmt) => fmt.spec.name === "trim"), "trim formatter expected");
        // The library factory bodies collapse to ordinary functions lowered into the IR.
        assert.ok(result.ir.functionDeclarations?.some((d) => d.name === "minLength"), "minLength lowered");
        assert.ok(result.ir.functionDeclarations?.some((d) => d.name === "trim"), "trim lowered");
    });

    it("the ts.sys tripwire is meaningful — the Node overlay path does touch the real filesystem", () => {
        // Control: the non-system (Node overlay) path reads lib files via ts.sys, so the
        // same tripwire must fire — proving the negative assertion above is real.
        const originalReadFile = ts.sys.readFile;
        try {
            ts.sys.readFile = (() => {
                throw new Error("disk read blocked");
            }) as unknown as typeof ts.sys.readFile;
            assert.throws(() => compileVirtual(SOURCES, { baseDir: VIRTUAL_BASE }));
        } finally {
            ts.sys.readFile = originalReadFile;
        }
    });
});
