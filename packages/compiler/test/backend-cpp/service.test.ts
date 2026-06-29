import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IRService, IRSourceLocation, IRType } from "@keyma/core/ir";
import { emitServicesCpp, type ServiceEmitDeps } from "../../src/backend-cpp/emit-service.js";
import { emitServiceClientCpp, type ServiceClientEmitDeps } from "../../src/backend-cpp/emit-service-client.js";

// The C++ @Service/RPC emission: the server abstract base (meta + dispatch over both encodings) and
// the typed client (task<result<T, error>>). Mirrors the JS/Python backend-service tests' intent —
// asserts the generated shape — and additionally COMPILES + RUNS generated code against the real
// @keyma/runtime-cpp headers (skipped cleanly when no C++23 compiler is available).

const loc = (): IRSourceLocation => ({ file: "src/calc.ts", line: 1, column: 1 });
const i = (): IRType => ({ kind: "integer" });

function deps(binary: boolean): ServiceEmitDeps & ServiceClientEmitDeps {
    return {
        includePrivate: true,
        nsRoot: "app",
        runtimeInclude: "<keyma/runtime.hpp>",
        binary,
        classModule: new Map(),
        classNameByName: new Map(),
        cppTypeByName: new Map(),
        enumTypeByName: new Map(),
        enumModuleByName: new Map(),
    };
}

// A scalar-only service (no model headers needed → the generated headers depend on the umbrella
// only, so the compile-smoke is self-contained).
const CALC: IRService = {
    id: "Calc",
    name: "Calc",
    sourceName: "Calc",
    visibility: "public",
    methods: [
        { name: "add", params: [{ name: "x", type: i() }, { name: "y", type: i() }], returnType: i(), visibility: "public", source: loc() },
        { name: "noop", params: [], visibility: "public", source: loc() },
        { name: "secret", params: [], returnType: i(), visibility: "private", source: loc() },
    ],
    source: loc(),
};

describe("backend-cpp services — generated shape", () => {
    it("server base: keyma::service + typed virtuals + meta() + dispatch over both encodings", () => {
        const out = emitServicesCpp([CALC], deps(true));
        // Derives the runtime base + lives under <root>::services.
        assert.match(out, /namespace app::services \{/);
        assert.match(out, /class Calc : public keyma::service \{/);
        // Typed pure virtuals return keyma::task<Ret>, ctx injected LAST.
        assert.match(out, /virtual keyma::task<std::int64_t> add\(std::int64_t x, std::int64_t y, const keyma::RequestContext& ctx\) = 0;/);
        assert.match(out, /virtual keyma::task<void> noop\(const keyma::RequestContext& ctx\) = 0;/);
        // meta(): private method carries Private visibility (host gating).
        assert.match(out, /const keyma::service_meta& meta\(\) const override/);
        assert.match(out, /\{"secret", keyma::Visibility::Private, \{\}\}/);
        // dispatch(method, payload, ctx, encoding, a) — both branches present under binary.
        assert.match(out, /keyma::task<keyma::call_result> dispatch\(std::string_view method, const keyma::wire_payload& payload,/);
        assert.match(out, /const keyma::RequestContext& ctx, keyma::encoding enc,/);
        assert.match(out, /if \(enc == keyma::encoding::binary\)/);
        assert.match(out, /const keyma::Value& __args = std::get<keyma::Value>\(payload\);/);
        assert.match(out, /keyma::from_value<std::int64_t>\(__args\.at\("x"\), a\)/);
        assert.match(out, /co_await this->add\(__a0, __a1, ctx\)/);
        assert.match(out, /keyma::call_result::success/);
        // Exceptions never cross the boundary. A thrown KeymaRuntimeError preserves its code +
        // structured details (the opt-in VALIDATION_ERROR surface); anything else → HANDLER_ERROR.
        assert.match(out, /catch \(const keyma::KeymaRuntimeError& __e\) \{/);
        assert.match(out, /keyma::call_result::failure\(__e\.code\(\), __e\.what\(\), keyma::Value\(__e\.details\(\), a\)\)/);
        assert.match(out, /keyma::error_code::handler_error/);
    });

    it("client: per-service class bound to a transport, returning task<result<T, error>>", () => {
        const out = emitServiceClientCpp([CALC], deps(true));
        assert.match(out, /namespace app::client \{/);
        assert.match(out, /Calc\(keyma::transport& transport, keyma::alloc_t alloc = \{\}\)/);
        assert.match(out, /keyma::task<keyma::result<std::int64_t, keyma::error>> add\(std::int64_t x, std::int64_t y\) \{/);
        assert.match(out, /keyma::task<keyma::result<void, keyma::error>> noop\(\) \{/);
        assert.match(out, /keyma::encoding __enc = __tx->wire_encoding\(\);/);
        assert.match(out, /keyma::client_invoke\(\*__tx, "Calc", "add", std::move\(__args\)\)/);
        assert.match(out, /if \(!__r\.has_value\(\)\) co_return std::unexpected\(__r\.error\(\)\);/);
        // A no-arg method builds the empty payload directly.
        assert.match(out, /keyma::empty_payload\(__enc, __alloc\)/);
    });

    it("binary disabled: dispatch / client marshal JSON only (no binary_traits references)", () => {
        const srv = emitServicesCpp([CALC], deps(false));
        const cli = emitServiceClientCpp([CALC], deps(false));
        assert.ok(!srv.includes("encoding::binary"), "server must not branch on binary when disabled");
        assert.ok(!srv.includes("binary_traits"), "server must not reference binary_traits when disabled");
        assert.ok(!cli.includes("binary_traits"), "client must not reference binary_traits when disabled");
        // The JSON path still marshals.
        assert.match(srv, /keyma::from_value<std::int64_t>\(__args\.at\("x"\), a\)/);
        assert.match(cli, /keyma::to_value\(x, __alloc\)/);
    });
});

// ── compile-smoke: compile + run generated code against the real runtime headers ──

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_INCLUDE = path.resolve(here, "../../../../runtime-cpp/include");

function findCxx(): string | undefined {
    const env = process.env["KEYMA_CXX"];
    const candidates = [env, "g++-15", "g++-14", "g++-13", "clang++-18", "clang++-17", "g++", "clang++", "c++"].filter(
        (c): c is string => typeof c === "string" && c.length > 0,
    );
    for (const c of candidates) {
        try {
            execFileSync(c, ["--version"], { stdio: "ignore" });
            return c;
        } catch {
            /* not available */
        }
    }
    return undefined;
}

const MAIN = `
#include "services.hpp"
#include "service-client.hpp"
#include <cassert>
#include <memory_resource>

struct CalcImpl : app::services::Calc {
    keyma::task<std::int64_t> add(std::int64_t x, std::int64_t y, const keyma::RequestContext&) override { co_return x + y; }
    keyma::task<void> noop(const keyma::RequestContext&) override { co_return; }
    keyma::task<std::int64_t> secret(const keyma::RequestContext&) override { co_return 7; }
};

int main() {
    std::pmr::monotonic_buffer_resource pool;
    keyma::alloc_t a{&pool};
    CalcImpl impl;
    keyma::service_host host(a);
    host.add(impl);

    // JSON encoding through the direct transport.
    {
        keyma::direct_transport tx = keyma::create_direct_transport(host, keyma::encoding::json, a);
        app::client::Calc client(tx, a);
        auto r = keyma::sync_wait(client.add(2, 3));
        assert(r.has_value() && *r == 5);
        auto v = keyma::sync_wait(client.noop());
        assert(v.has_value());
        // private method hidden from a non-system caller.
        auto s = keyma::sync_wait(client.secret());
        assert(!s.has_value() && std::string_view(s.error().code) == keyma::error_code::method_not_found);
    }
    // Binary encoding (positional) through the direct transport.
    {
        keyma::direct_transport tx = keyma::create_direct_transport(host, keyma::encoding::binary, a);
        app::client::Calc client(tx, a);
        auto r = keyma::sync_wait(client.add(40, 2));
        assert(r.has_value() && *r == 42);
    }
    // System transport reaches the private method.
    {
        keyma::direct_transport tx = keyma::direct_transport::system(host, keyma::encoding::json, a);
        app::client::Calc client(tx, a);
        auto s = keyma::sync_wait(client.secret());
        assert(s.has_value() && *s == 7);
    }
    return 0;
}
`;

describe("backend-cpp services — compile-smoke against the real runtime headers", () => {
    it("generated server + client compile and run end-to-end (both encodings)", () => {
        const cxx = findCxx();
        if (cxx === undefined) {
            console.log("backend-cpp compile-smoke: skipped — no C++23 compiler found (set KEYMA_CXX)");
            return;
        }
        const dir = mkdtempSync(path.join(tmpdir(), "keyma-cpp-svc-"));
        try {
            writeFileSync(path.join(dir, "services.hpp"), emitServicesCpp([CALC], deps(true)));
            writeFileSync(path.join(dir, "service-client.hpp"), emitServiceClientCpp([CALC], deps(true)));
            writeFileSync(path.join(dir, "main.cpp"), MAIN);

            // Homebrew/MacPorts GCC vs the macOS SDK uses the C11 keyword _Alignof (rejected by
            // GCC's C++ frontend) — map the spelling through, mirroring scripts/cpp-test.sh.
            const isGccOnMac = process.platform === "darwin" && /(^|\/)(g\+\+|c\+\+)/.test(cxx) && !/clang/.test(cxx);
            const compat = isGccOnMac ? ["-D_Alignof(x)=alignof(x)"] : [];
            const bin = path.join(dir, "smoke");
            execFileSync(cxx, ["-std=c++23", ...compat, `-I${RUNTIME_INCLUDE}`, `-I${dir}`, path.join(dir, "main.cpp"), "-o", bin], {
                stdio: "pipe",
            });
            execFileSync(bin, [], { stdio: "pipe" });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
