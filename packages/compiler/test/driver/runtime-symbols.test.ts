import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IRType } from "@keyma/core/ir";
import { RuntimeSymbolRegistry, defaultRuntimeSymbols } from "../../src/driver/index.js";
import { irTypeToTs } from "../../src/backend-js/ir-type-to-ts.js";
import { irTypeToPython } from "../../src/backend-python/ir-type-to-python.js";
import { irTypeToCpp } from "../../src/backend-cpp/ir-type-to-cpp.js";

describe("RuntimeSymbolRegistry", () => {
    it("resolves a registered canonical name per language; unknown languages return undefined", () => {
        const reg = new RuntimeSymbolRegistry();
        reg.register("ValidationError", { js: "ValidationError", python: "ValidationError", cpp: "keyma::ValidationError" });
        assert.equal(reg.resolve("js", "ValidationError"), "ValidationError");
        assert.equal(reg.resolve("cpp", "ValidationError"), "keyma::ValidationError");
        assert.equal(reg.resolve("python", "Unregistered"), undefined);
    });

    it("registerAll seeds many entries; has() reports membership", () => {
        const reg = new RuntimeSymbolRegistry();
        reg.registerAll([["A", { js: "A" }], ["B", { cpp: "keyma::B" }]]);
        assert.equal(reg.has("A"), true);
        assert.equal(reg.has("B"), true);
        assert.equal(reg.has("C"), false);
        assert.equal(reg.resolve("cpp", "B"), "keyma::B");
    });
});

describe("external IR type emission via the runtime symbol table", () => {
    const external: IRType = { kind: "external", name: "RuntimeSymbolsTestType" };

    it("falls back to the canonical name verbatim when unregistered", () => {
        // No registration for this name → emitters echo the canonical name.
        assert.equal(irTypeToTs(external), "RuntimeSymbolsTestType");
        assert.equal(irTypeToPython(external), "RuntimeSymbolsTestType");
        assert.equal(irTypeToCpp(external), "RuntimeSymbolsTestType");
    });

    it("resolves to the per-language symbol once registered on the default table", () => {
        defaultRuntimeSymbols.register("RuntimeSymbolsTestType", {
            js: "TsSymbol",
            python: "PySymbol",
            cpp: "keyma::CppSymbol",
        });
        assert.equal(irTypeToTs(external), "TsSymbol");
        assert.equal(irTypeToPython(external), "PySymbol");
        assert.equal(irTypeToCpp(external), "keyma::CppSymbol");
    });
});
