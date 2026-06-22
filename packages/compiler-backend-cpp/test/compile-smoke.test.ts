import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "@keyma/compiler";
import { emitCpp } from "../src/backend.js";
import { sampleIR } from "./fixtures.js";

// @keyma/runtime-cpp's header directory, resolved from this compiled test file
// (dist/test/) — the default (non-vendor) bundle includes <keyma/runtime.hpp> from here.
const RUNTIME_INC = join(dirname(fileURLToPath(import.meta.url)), "../../../runtime-cpp/include");

/**
 * Probe for a C++23 compiler whose standard library actually provides the features
 * the generated code uses (notably std::move_only_function — absent from Apple
 * clang 17's libc++). Returns the compiler command, or null to skip the suite.
 */
function detectCxx23(): string | null {
    const probe = `#include <memory_resource>
#include <expected>
#include <functional>
#include <format>
#include <chrono>
int main() {
    std::move_only_function<int() const> f = [] { return 1; };
    std::expected<void, int> e{};
    std::pmr::string s{"x"};
    auto t = std::format("{}", 1);
    std::chrono::sys_days d{std::chrono::year{2020}/1/1};
    return f() + (e ? 0 : 1) + (int)s.size() + (int)t.size() + (int)d.time_since_epoch().count() * 0;
}`;
    const candidates = [process.env["KEYMA_CXX"], "g++-15", "g++-14", "g++-13", "clang++-18", "clang++-17", "g++", "clang++", "c++"].filter(Boolean) as string[];
    for (const cc of candidates) {
        try {
            execFileSync(cc, ["-std=c++23", "-x", "c++", "-fsyntax-only", "-"], { input: probe, stdio: ["pipe", "ignore", "ignore"] });
            return cc;
        } catch {
            /* try next */
        }
    }
    return null;
}

// A concrete service subclass proves the generated abstract class is implementable.
const MAIN_CPP = `#include "index.hpp"
#include <cassert>
#include <string_view>

struct AccountImpl : app::AccountService {
    std::shared_ptr<app::User> signup(const app::User&) override { return nullptr; }
    bool resend(const std::pmr::string&) override { return true; }
    std::pmr::vector<app::Tag> listTags() override { return {}; }
    bool purge() override { return false; }
};

int main() {
    std::pmr::monotonic_buffer_resource pool;
    keyma::Value::allocator_type a{&pool};

    keyma::Value rec = keyma::Value::object(a);
    rec.set("firstName", keyma::Value(std::string_view{"  Ada "}, a));
    rec.set("lastName", keyma::Value(std::string_view{"Lovelace"}, a));
    rec.set("primaryTag", keyma::Value(std::string_view{"tag-42"}, a));   // bare reference id
    rec.set("status", keyma::Value(std::string_view{"archived"}, a));     // named enum

    app::User u = app::User::from_value(rec, a);
    (void) u.fullName();
    (void) u.greet();

    // Reference id-stub: a bare id yields an allocate_shared'd target carrying the id.
    assert(u.primaryTag && u.primaryTag->id == "tag-42");
    // Named enum round-trips through the typed model and the generic conversions.
    assert(u.status == app::Status::Archived);
    assert(keyma::to_string(app::Status::Active) == "active");
    assert(keyma::from_string<app::Status>(std::string_view{"archived"}) == app::Status::Archived);

    const keyma::SchemaMeta& m = app::User::schema();
    keyma::Context ctx{rec};
    for (const auto& fld : m.fields) {
        if (fld.name == "firstName") {
            auto r = fld.validators[0](rec.at("firstName"), "firstName", ctx);
            assert(r.has_value());
            auto fmtd = fld.formatters[0].fn(rec.at("firstName"), ctx);
            assert(fmtd.as_string() == "Ada");
        }
    }
    if (m.apply_defaults) m.apply_defaults(rec, a);
    assert(rec.at("role").as_string() == "user");        // literal default applied
    app::materialize_User(rec);
    assert(rec.at("fullName").as_string() == "  Ada  Lovelace");

    // Presence matrix: a single-axis optional collapses absent and present-null to
    // nullopt; a two-axis keyma::Field<T> keeps absent / present-null / present-value distinct.
    keyma::Value rec2 = keyma::Value::object(a);
    rec2.set("firstName", keyma::Value(std::string_view{"Grace"}, a));
    rec2.set("bio", keyma::Value(nullptr, a));      // present-null nullable
    rec2.set("alias", keyma::Value(nullptr, a));    // present-null Field
    app::User u2 = app::User::from_value(rec2, a);
    assert(!u2.nickname.has_value());                // absent optional → nullopt
    assert(!u2.bio.has_value());                     // present-null nullable → nullopt
    assert(u2.alias.present && u2.alias.is_null());  // present-null Field
    app::User u3 = app::User::from_value(keyma::Value::object(a), a);
    assert(u3.alias.is_absent());                    // absent Field

    // Struct → Value round-trip (references serialize id-only).
    keyma::Value back = u.to_value(a);
    assert(back.at("firstName").as_string() == u.firstName);
    assert(back.at("primaryTag").as_string() == "tag-42");

    // Array round-trip exercises Value::push (to_value) and the vector traits (from_value).
    keyma::Value tags = keyma::Value::array(a);
    tags.push(keyma::Value(std::string_view{"x"}, a));
    tags.push(keyma::Value(std::string_view{"y"}, a));
    rec.set("tags", std::move(tags));
    app::User u4 = app::User::from_value(rec, a);
    assert(u4.tags.size() == 2);
    keyma::Value tback = u4.to_value(a);
    assert(tback.at("tags").as_array().size() == 2);

    AccountImpl svc;
    assert(svc.resend(std::pmr::string{"x", a}));
    return 0;
}`;

describe("compile-smoke — generated C++ compiles under -std=c++23", () => {
    let cxx: string | null = null;
    before(() => { cxx = detectCxx23(); });

    it("emits a library bundle, writes it to disk, and compiles a consumer", async (t) => {
        if (cxx === null) {
            t.skip("no C++23 compiler with std::move_only_function found (set KEYMA_CXX to enable)");
            return;
        }
        const dir = mkdtempSync(join(tmpdir(), "keyma-cpp-"));
        try {
            const { files } = await emitCpp(sampleIR(), { language: "cpp", outDir: "out", library: true }, {} as ResolvedConfig);
            for (const file of files) {
                const p = join(dir, file.path);
                mkdirSync(dirname(p), { recursive: true });
                writeFileSync(p, file.content);
            }
            const root = join(dir, "out");
            const main = join(dir, "main.cpp");
            writeFileSync(main, MAIN_CPP);
            // -fsyntax-only is enough to instantiate from_value/schema()/validators that main odr-uses.
            // The default bundle includes <keyma/runtime.hpp>, so the runtime's include/ is on -I.
            execFileSync(cxx, ["-std=c++23", "-I", root, "-I", RUNTIME_INC, "-fsyntax-only", main], { stdio: ["ignore", "ignore", "pipe"] });
        } catch (err) {
            const e = err as { stderr?: Buffer; message?: string };
            assert.fail(`generated C++ failed to compile:\n${e.stderr?.toString() ?? e.message ?? err}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("vendorRuntime emits a self-contained bundle that compiles WITHOUT the runtime -I", async (t) => {
        if (cxx === null) {
            t.skip("no C++23 compiler with std::move_only_function found (set KEYMA_CXX to enable)");
            return;
        }
        const dir = mkdtempSync(join(tmpdir(), "keyma-cpp-vendor-"));
        try {
            const { files } = await emitCpp(sampleIR(), { language: "cpp", outDir: "out", library: true, vendorRuntime: true }, {} as ResolvedConfig);
            for (const file of files) {
                const p = join(dir, file.path);
                mkdirSync(dirname(p), { recursive: true });
                writeFileSync(p, file.content);
            }
            const root = join(dir, "out");
            const main = join(dir, "main.cpp");
            writeFileSync(main, MAIN_CPP);
            // No RUNTIME_INC: the vendored keyma_runtime.hpp lives in the bundle (out/).
            execFileSync(cxx, ["-std=c++23", "-I", root, "-fsyntax-only", main], { stdio: ["ignore", "ignore", "pipe"] });
        } catch (err) {
            const e = err as { stderr?: Buffer; message?: string };
            assert.fail(`vendored C++ failed to compile:\n${e.stderr?.toString() ?? e.message ?? err}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
