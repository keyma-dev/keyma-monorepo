import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "@keyma/compiler";
import type { KeymaIR, IRField, IRType } from "@keyma/ir";
import { emitCpp } from "../src/backend.js";

// @keyma/runtime-cpp's header directory, resolved from this compiled test file (dist/test/).
const RUNTIME_INC = join(dirname(fileURLToPath(import.meta.url)), "../../../runtime-cpp/include");

const DOC_TS = "/proj/src/doc.ts";
const RICH_TS = "/proj/src/rich.ts";
const loc = (file: string) => ({ file, line: 1, column: 1 });

function fld(
    file: string,
    name: string,
    type: IRType,
    opts: { tag?: number; required?: boolean; nullable?: boolean } = {},
): IRField {
    return {
        name, type, visibility: "public", readonly: false,
        required: opts.required ?? true,
        ...(opts.nullable ? { nullable: true } : {}),
        validators: [], formatters: [], indexes: [],
        ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
        source: loc(file),
    };
}

/**
 * A binary-enabled IR exercising the typed-binary codegen across every framing kind. Since
 * schema-data.ts now emits the full nested wire detail (element/target/bits/unsigned/idType),
 * the dynamic codec over `schema()` is a complete byte-equality oracle for BOTH structs:
 *  - Doc: scalar / optional-only / nullable / two-axis Field / array / json / string-id reference.
 *  - Rich: embedded / int-id reference / named enum / float32 / unsigned / array-of-embedded /
 *    array-of-references.
 */
function binaryIR(): KeymaIR {
    return {
        irVersion: "7.1.0", compilerVersion: "0.1.0", sourceRoot: "/proj/src",
        schemas: [
            {
                id: "Person", name: "person", sourceName: "Person", visibility: "public",
                fields: [
                    fld(DOC_TS, "id", { kind: "id" }, { tag: 1 }),
                    fld(DOC_TS, "name", { kind: "string" }, { tag: 2 }),
                ],
                indexes: [], source: loc(DOC_TS),
            },
            {
                id: "Doc", name: "doc", sourceName: "Doc", visibility: "public",
                fields: [
                    fld(DOC_TS, "id", { kind: "id" }, { tag: 1 }),
                    fld(DOC_TS, "name", { kind: "string" }, { tag: 2 }),
                    fld(DOC_TS, "count", { kind: "bigint" }, { tag: 3 }),
                    fld(DOC_TS, "active", { kind: "boolean" }, { tag: 4 }),
                    fld(DOC_TS, "nickname", { kind: "string" }, { tag: 5, required: false }),
                    fld(DOC_TS, "bio", { kind: "string" }, { tag: 6, nullable: true }),
                    fld(DOC_TS, "alias", { kind: "string" }, { tag: 7, required: false, nullable: true }),
                    fld(DOC_TS, "tags", { kind: "array", of: { kind: "string" } }, { tag: 8 }),
                    fld(DOC_TS, "meta", { kind: "json" }, { tag: 9 }),
                    fld(DOC_TS, "owner", { kind: "reference", schema: "person", idType: { kind: "id" } }, { tag: 10 }),
                ],
                indexes: [], source: loc(DOC_TS),
            },
            {
                id: "Addr", name: "addr", sourceName: "Addr", visibility: "public",
                fields: [
                    fld(RICH_TS, "city", { kind: "string" }, { tag: 1 }),
                    fld(RICH_TS, "zip", { kind: "bigint" }, { tag: 2 }),
                ],
                indexes: [], source: loc(RICH_TS),
            },
            {
                id: "Cat", name: "cat", sourceName: "Cat", visibility: "public",
                fields: [
                    fld(RICH_TS, "id", { kind: "integer" }, { tag: 1 }),
                    fld(RICH_TS, "label", { kind: "string" }, { tag: 2 }),
                ],
                indexes: [], source: loc(RICH_TS),
            },
            {
                id: "Rich", name: "rich", sourceName: "Rich", visibility: "public",
                fields: [
                    fld(RICH_TS, "id", { kind: "id" }, { tag: 1 }),
                    fld(RICH_TS, "addr", { kind: "embedded", schema: "addr" }, { tag: 2 }),
                    fld(RICH_TS, "fav", { kind: "reference", schema: "cat", idType: { kind: "integer" } }, { tag: 3 }),
                    fld(RICH_TS, "color", { kind: "enum", values: ["red", "green"], name: "Color" }, { tag: 4 }),
                    fld(RICH_TS, "score", { kind: "number", bits: 32 }, { tag: 5 }),
                    fld(RICH_TS, "ucount", { kind: "integer", bits: 32, unsigned: true }, { tag: 6 }),
                    fld(RICH_TS, "addrs", { kind: "array", of: { kind: "embedded", schema: "addr" } }, { tag: 7 }),
                    fld(RICH_TS, "cats", { kind: "array", of: { kind: "reference", schema: "cat", idType: { kind: "integer" } } }, { tag: 8 }),
                ],
                indexes: [], source: loc(RICH_TS),
            },
        ],
        validatorDeclarations: [], formatterDeclarations: [], functionDeclarations: [],
        enums: [{ name: "Color", members: [{ name: "Red", value: "red" }, { name: "Green", value: "green" }], source: loc(RICH_TS) }],
        diagnostics: [],
    };
}

const BINARY_CFG = { binary: true } as ResolvedConfig;

describe("cppBackend — typed binary codec emission gating", async () => {
    const on = await emitCpp(binaryIR(), { language: "cpp", outDir: "out", library: true }, BINARY_CFG);
    const off = await emitCpp(binaryIR(), { language: "cpp", outDir: "out", library: true }, {} as ResolvedConfig);
    const file = (files: typeof on.files, suffix: string): string => {
        const c = files.find((f) => f.path.endsWith(suffix))!.content;
        return typeof c === "string" ? c : Buffer.from(c).toString("utf8");
    };

    it("emits binary_traits<T> + include + forward-decls when binary is enabled", () => {
        const doc = file(on.files, "models/doc.hpp");
        assert.ok(doc.includes("#include <keyma/binary-typed.hpp>"));
        assert.ok(doc.includes("namespace keyma { template <> struct binary_traits<app::models::doc::Doc>; }"));
        assert.ok(doc.includes("struct binary_traits<app::models::doc::Doc> {"));
        assert.ok(doc.includes("static void encode_record(keyma::ByteBuf& out, const T& x, keyma::alloc_t a)"));
        assert.ok(doc.includes("static T decode_record(keyma::binary_detail::Reader& r, keyma::alloc_t a)"));
        // reference target forward-declared as binary_traits too
        assert.ok(doc.includes("namespace keyma { template <> struct binary_traits<app::models::doc::Person>; }"));
    });

    it("frames each field per the IR required/nullable flags", () => {
        const doc = file(on.files, "models/doc.hpp");
        // required scalar → always write key + payload
        assert.ok(doc.includes("keyma::binary_detail::write_key(out, 2, keyma::binary_traits<std::pmr::string>::wiretype); keyma::encode_payload<std::pmr::string>(out, x.name, a);"));
        // optional-only → omit when absent (has_value guard, no else)
        assert.ok(doc.includes("if (x.nickname.has_value()) { keyma::binary_detail::write_key(out, 5,"));
        // nullable → WIRE_NULL when absent
        assert.ok(doc.includes("else { keyma::binary_detail::write_key(out, 6, keyma::binary_detail::WIRE_NULL); }"));
        // two-axis Field → present/value dance
        assert.ok(doc.includes("if (x.alias.present) {"));
        // json → WIRE_NULL when the Value itself is null
        assert.ok(doc.includes("if ((x.meta).is_null()) {"));
        // reference → id_wiretype + encode_id_payload
        assert.ok(doc.includes("keyma::binary_traits<app::models::doc::Person>::id_wiretype"));
        assert.ok(doc.includes("keyma::binary_traits<app::models::doc::Person>::encode_id_payload(out, *x.owner, a)"));
    });

    it("emits reference-target id helpers and enum binary_traits", () => {
        const doc = file(on.files, "models/doc.hpp");
        assert.ok(doc.includes("static constexpr std::uint8_t id_wiretype = keyma::binary_traits<std::pmr::string>::wiretype;"));
        assert.ok(doc.includes("static void decode_id_into(T& t, keyma::binary_detail::Reader& r, std::uint8_t wt, keyma::alloc_t a)"));
        const rich = file(on.files, "models/rich.hpp");
        assert.ok(rich.includes("struct binary_traits<app::models::rich::Color> {"));
        // embedded field routes through the target struct's own binary_traits leaf (which now
        // carries encode_payload/decode_payload + wiretype), folded into the scalar path
        assert.ok(rich.includes("keyma::binary_traits<app::models::rich::Addr>::wiretype"));
        assert.ok(rich.includes("keyma::encode_payload<app::models::rich::Addr>(out, x.addr, a)"));
        assert.ok(rich.includes("keyma::decode_payload<app::models::rich::Addr>(r, wt, a)"));
        // struct gets the length-windowed payload methods (so it can be embedded / an array element)
        assert.ok(rich.includes("static void encode_payload(keyma::ByteBuf& out, const T& x, keyma::alloc_t a)"));
        assert.ok(rich.includes("static T decode_payload(keyma::binary_detail::Reader& r, std::uint8_t, keyma::alloc_t a)"));
        // array-of-embedded → vector<Target>; array-of-references → vector<shared_ptr<Target>>
        assert.ok(rich.includes("keyma::encode_payload<std::pmr::vector<app::models::rich::Addr>>(out, x.addrs, a)"));
        assert.ok(rich.includes("keyma::encode_payload<std::pmr::vector<std::shared_ptr<app::models::rich::Cat>>>(out, x.cats, a)"));
        // int-id reference target gets varint id helpers
        assert.ok(rich.includes("static constexpr std::uint8_t id_wiretype = keyma::binary_traits<std::int64_t>::wiretype;"));
    });

    it("emits NOTHING binary when binary is disabled (JSON-only output unchanged)", () => {
        const doc = file(off.files, "models/doc.hpp");
        assert.ok(!doc.includes("binary-typed.hpp"), "binary header leaked into JSON-only output");
        assert.ok(!doc.includes("binary_traits"), "binary_traits leaked into JSON-only output");
        const rich = file(off.files, "models/rich.hpp");
        assert.ok(!rich.includes("binary_traits"), "enum binary_traits leaked into JSON-only output");
    });
});

/** Probe for a C++23 compiler with the needed stdlib (mirrors compile-smoke.test.ts). */
function detectCxx23(): string | null {
    const probe = `#include <memory_resource>
#include <expected>
#include <format>
#include <chrono>
#include <string>
int main() {
    std::expected<void, int> e{};
    std::pmr::string s{"x"};
    auto t = std::format("{}", 1);
    std::chrono::sys_days d{std::chrono::year{2020}/1/1};
    return (e ? 0 : 1) + (int)s.size() + (int)t.size() + (int)d.time_since_epoch().count() * 0;
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

// Consumer: compiles the emitted binary codec, asserts Doc byte-equality vs the dynamic
// schema()-driven codec (the cardinal cross-path invariant) and a full struct round-trip,
// plus a Rich round-trip exercising embedded / enum / float / unsigned / int-id reference.
const CONSUMER = `#include "index.hpp"
#include <keyma/binary.hpp>
#include <cassert>
#include <iostream>
#include <span>
#include <string>
#include <string_view>

using namespace keyma;
using D = app::models::doc::Doc;
using R = app::models::rich::Rich;

static std::span<const std::byte> sp(const ByteBuf& b) { return std::span<const std::byte>(b.data(), b.size()); }
static std::string hx(std::span<const std::byte> b) {
    static const char* H = "0123456789abcdef"; std::string s;
    for (std::byte x : b) { unsigned u = std::to_integer<unsigned>(x); s.push_back(H[u >> 4]); s.push_back(H[u & 15]); }
    return s;
}

int main() {
    std::pmr::monotonic_buffer_resource pool; alloc_t a(&pool);

    // ── Doc: byte-equality vs encode_binary(Doc::schema(), v, Server) + round-trip ──
    Value v = Value::object(a);
    v.set("id", Value(std::string_view("d-1"), a));
    v.set("name", Value(std::string_view("Title"), a));
    v.set("count", Value(std::int64_t{7}, a));
    v.set("active", Value(true, a));
    // nickname absent → omitted
    v.set("bio", Value(nullptr, a));     // nullable present-null → WIRE_NULL
    v.set("alias", Value(nullptr, a));   // two-axis present-null → WIRE_NULL
    { Value arr = Value::array(a); arr.push(Value(std::string_view("x"), a)); arr.push(Value(std::string_view("y"), a)); v.set("tags", arr); }
    { Value m = Value::object(a); m.set("k", Value(std::int64_t{1}, a)); v.set("meta", m); }
    v.set("owner", Value(std::string_view("p-9"), a));   // bare reference id

    D doc = D::from_value(v, a);
    ByteBuf typed = keyma::to_binary<D>(doc, a);
    ByteBuf dyn = keyma::encode_binary(D::schema(), v, SerializeTarget::Server, a);
    if (hx(sp(typed)) != hx(sp(dyn))) {
        std::cerr << "Doc byte mismatch\\n  typed   " << hx(sp(typed)) << "\\n  dynamic " << hx(sp(dyn)) << "\\n";
        return 1;
    }

    D back = keyma::from_binary<D>(sp(typed), a);
    assert(back.id == "d-1");
    assert(back.name == "Title");
    assert(back.count == 7);
    assert(back.active == true);
    assert(!back.nickname.has_value());
    assert(!back.bio.has_value());
    assert(back.alias.present && back.alias.is_null());
    assert(back.tags.size() == 2 && back.tags[0] == "x" && back.tags[1] == "y");
    assert(back.meta.is_object() && back.meta.at("k").as_int() == 1);
    assert(back.owner && back.owner->id == "p-9");

    // ── Rich: byte-equality + round-trip (embedded, int-id reference, enum, float32,
    //    unsigned, array-of-embedded, array-of-references) ──
    Value rv = Value::object(a);
    rv.set("id", Value(std::string_view("r-1"), a));
    { Value ad = Value::object(a); ad.set("city", Value(std::string_view("NYC"), a)); ad.set("zip", Value(std::int64_t{10001}, a)); rv.set("addr", ad); }
    rv.set("fav", Value(std::int64_t{42}, a));     // bare int reference id
    rv.set("color", Value(std::string_view("green"), a));
    rv.set("score", Value(double{0.5}, a));
    rv.set("ucount", Value(std::int64_t{4000000000}, a));
    { Value arr = Value::array(a);
      { Value e = Value::object(a); e.set("city", Value(std::string_view("LA"), a)); e.set("zip", Value(std::int64_t{90001}, a)); arr.push(e); }
      { Value e = Value::object(a); e.set("city", Value(std::string_view("SF"), a)); e.set("zip", Value(std::int64_t{94016}, a)); arr.push(e); }
      rv.set("addrs", arr); }                       // array of embedded
    { Value arr = Value::array(a); arr.push(Value(std::int64_t{7}, a)); arr.push(Value(std::int64_t{8}, a)); rv.set("cats", arr); }  // array of references

    R rich = R::from_value(rv, a);
    ByteBuf rtyped = keyma::to_binary<R>(rich, a);
    ByteBuf rdyn = keyma::encode_binary(R::schema(), rv, SerializeTarget::Server, a);
    if (hx(sp(rtyped)) != hx(sp(rdyn))) {
        std::cerr << "Rich byte mismatch\\n  typed   " << hx(sp(rtyped)) << "\\n  dynamic " << hx(sp(rdyn)) << "\\n";
        return 1;
    }

    R rback = keyma::from_binary<R>(sp(rtyped), a);
    assert(rback.id == "r-1");
    assert(rback.addr.city == "NYC" && rback.addr.zip == 10001);
    assert(rback.fav && rback.fav->id == 42);
    assert(rback.color == app::models::rich::Color::Green);
    assert(rback.score == 0.5f);
    assert(rback.ucount == 4000000000u);
    assert(rback.addrs.size() == 2 && rback.addrs[0].city == "LA" && rback.addrs[0].zip == 90001 && rback.addrs[1].city == "SF");
    assert(rback.cats.size() == 2 && rback.cats[0] && rback.cats[0]->id == 7 && rback.cats[1] && rback.cats[1]->id == 8);

    std::cout << "binary integration ok\\n";
    return 0;
}`;

describe("cppBackend — generated typed binary codec compiles, byte-matches, and round-trips", () => {
    let cxx: string | null = null;
    before(() => { cxx = detectCxx23(); });

    it("emits a binary-enabled bundle and runs the codec consumer", async (t) => {
        if (cxx === null) { t.skip("no C++23 compiler found (set KEYMA_CXX to enable)"); return; }
        const dir = mkdtempSync(join(tmpdir(), "keyma-cpp-binary-"));
        try {
            const { files } = await emitCpp(binaryIR(), { language: "cpp", outDir: "out", library: true }, BINARY_CFG);
            for (const f of files) {
                const p = join(dir, f.path);
                mkdirSync(dirname(p), { recursive: true });
                writeFileSync(p, f.content);
            }
            const root = join(dir, "out");
            const main = join(dir, "main.cpp");
            const exe = join(dir, "main");
            writeFileSync(main, CONSUMER);
            execFileSync(cxx, ["-std=c++23", "-I", root, "-I", RUNTIME_INC, main, "-o", exe], { stdio: ["ignore", "ignore", "pipe"] });
            const out = execFileSync(exe, { encoding: "utf8" });
            assert.match(out, /binary integration ok/);
        } catch (err) {
            const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
            assert.fail(`generated binary codec failed:\n${e.stderr?.toString() ?? ""}${e.stdout?.toString() ?? ""}${e.message ?? err}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
