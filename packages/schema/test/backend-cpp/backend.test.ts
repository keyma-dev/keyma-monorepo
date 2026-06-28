import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResolvedConfig } from "@keyma/compiler";
import type { KeymaIR, IRMember, IRType } from "@keyma/core/ir";
import { emitCpp, cppBackend } from "./harness.js";
import { emitSupportHpp } from "@keyma/compiler/backend-cpp";
import { sampleIR, fileBySuffix } from "./fixtures.js";

const CFG = {} as ResolvedConfig;

describe("cppBackend metadata", () => {
    it("targets the 'cpp' language", () => {
        assert.equal(cppBackend.target, "cpp");
        assert.equal(cppBackend.name, "@keyma/compiler/backend-cpp");
    });
});

describe("emitCpp — library bundle", async () => {
    const { files } = await emitCpp(sampleIR(), { language: "cpp", outDir: "out", library: true }, CFG);
    const paths = files.map((f) => f.path);

    it("emits the expected header set (no client/server subdir)", () => {
        for (const p of [
            "out/src/user.hpp", "out/src/address.hpp",
            "out/src/tag.hpp", "out/src/secret.hpp", "out/src/validators.hpp",
            "out/src/formatters.hpp", "out/services.hpp", "out/index.hpp",
        ]) {
            assert.ok(paths.includes(p), `missing ${p}; got ${paths.join(", ")}`);
        }
    });

    it("depends on @keyma/runtime-cpp by default (no vendored runtime header)", () => {
        assert.ok(!paths.some((p) => p.endsWith("keyma_support.hpp")), "stale keyma_support.hpp emitted");
        assert.ok(!paths.some((p) => p.endsWith("keyma_runtime.hpp")), "runtime vendored without vendorRuntime");
        const u = fileBySuffix(files, "src/user.hpp");
        assert.ok(u.includes("#include <keyma/runtime.hpp>"));
    });

    it("model struct is pmr/allocator-aware with the right member types", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        assert.ok(u.includes("namespace app::src::user"));
        assert.ok(u.includes("struct User {"));
        assert.ok(u.includes("using allocator_type = std::pmr::polymorphic_allocator<std::byte>;"));
        assert.ok(u.includes("explicit User(const allocator_type& a)"));
        assert.ok(u.includes("User(const User& o, const allocator_type& a)"));
        assert.ok(u.includes("std::pmr::string firstName;"));
        assert.ok(u.includes("std::optional<std::pmr::string> nickname;"));      // optional
        assert.ok(u.includes("keyma::Field<std::pmr::string> alias;"));          // both axes
        assert.ok(u.includes("app::src::address::Address address;"));          // embedded by value
        assert.ok(u.includes("std::shared_ptr<app::src::tag::Tag> primaryTag;")); // reference → shared_ptr
        assert.ok(u.includes("app::src::user::Status status;"));              // named enum → enum class
        assert.ok(u.includes("static_assert(std::uses_allocator_v<User"));
    });

    it("emits typed field descriptors (struct f) for the where/projection DSL", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        assert.ok(u.includes("    struct f {"), "nested struct f of descriptors");
        // a scalar string field → Ordered, Value is the member type, no ref target
        assert.ok(u.includes(
            'struct firstName_ { using Owner = User; using Value = std::pmr::string; using RefTarget = void;'
            + ' static constexpr std::string_view key() { return "firstName"; }'
            + ' static constexpr keyma::FieldKind kind = keyma::FieldKind::Ordered; };'));
        // named enum → Enum, Value is the enum class
        assert.ok(u.includes("using Value = app::src::user::Status; using RefTarget = void;"));
        assert.ok(u.includes('return "status"; } static constexpr keyma::FieldKind kind = keyma::FieldKind::Enum;'));
        // reference → Reference, Value is the target's id type, RefTarget is the target struct
        assert.ok(u.includes("using Value = std::pmr::string; using RefTarget = app::src::tag::Tag;"));
        assert.ok(u.includes('return "primaryTag"; } static constexpr keyma::FieldKind kind = keyma::FieldKind::Reference;'));
        // a constexpr instance per field so callers write User::f::firstName
        assert.ok(u.includes("static constexpr firstName_ firstName{};"));
    });

    it("named enum lowers to an enum class with keyma:: to_string/from_string specializations", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        assert.ok(u.includes("enum class Status { Active, Archived };"));
        assert.ok(u.includes("template <> inline std::string_view to_string<app::src::user::Status>"));
        assert.ok(u.includes("template <> inline app::src::user::Status from_string<app::src::user::Status>"));
        // from_value converts the dynamic string to the enum class.
        assert.ok(u.includes("keyma::from_string<app::src::user::Status>"));
    });

    it("reference fields use the generic shared_ptr id-stub via value_traits (cycle-safe)", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        // The per-field coercion is gone — from_value delegates to the runtime templates.
        assert.ok(u.includes('keyma::from_value<std::shared_ptr<app::src::tag::Tag>>(v.at("primaryTag"), a)'));
        // User is itself a reference target (Tag.owner → user), so its value_traits carries id-stub helpers.
        assert.ok(u.includes("static void set_id(T& t, const keyma::Value& idv, keyma::alloc_t a)"));
        assert.ok(u.includes("static keyma::Value id_value("));
        // The reference target is forward-declared (struct AND value_traits) and its header
        // included AFTER the structs (with #pragma once this breaks the cycle).
        assert.ok(u.includes("namespace app::src::tag { struct Tag; }"));
        assert.ok(u.includes("namespace keyma { template <> struct value_traits<app::src::tag::Tag>; }"));
        const fwdIdx = u.indexOf("struct User {");
        const incIdx = u.indexOf('#include "src/tag.hpp"');
        assert.ok(incIdx > fwdIdx, "reference target include must come after the struct definition");
    });

    it("includes private field/schema in library/server bundles", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        assert.ok(u.includes("secretNote"));
        assert.ok(paths.includes("out/src/secret.hpp"));
    });

    it("emits getter accessors, method, from_value, metadata() — and NO materializer", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        assert.ok(u.includes("auto fullName() const {"));
        assert.ok(u.includes("auto badge() const {"));
        assert.ok(u.includes("auto tagKey() const {"));
        assert.ok(u.includes("return this->primaryTag->id;")); // ref member access via ->
        assert.ok(u.includes("auto greet()"));
        assert.ok(u.includes("static User from_value(const keyma::Value& v, const allocator_type& a);"));
        assert.ok(u.includes("inline const keyma::ClassMetadata& User::metadata()"));
        assert.ok(!u.includes("materialize_User"), "materializers are removed — none should be emitted");
        // Metadata is pure introspective data — no apply_defaults fn-ptr / free function.
        assert.ok(!u.includes("apply_defaults_User"), "apply_defaults free function should not be emitted");
    });

    it("emits a thin value_traits specialization and member forwarders for serialization", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        assert.ok(u.includes("keyma::Value to_value(const allocator_type& a) const;")); // member decl
        assert.ok(u.includes("struct value_traits<app::src::user::User>"));          // the specialization
        assert.ok(u.includes('__o.firstName = keyma::from_value<std::pmr::string>(v.at("firstName"), a);'));
        assert.ok(u.includes('__o.alias = keyma::from_value_field<std::pmr::string>(v.find("alias"), a);')); // both-axes → find
        assert.ok(u.includes('__v.set("firstName", keyma::to_value(x.firstName, a));'));
        assert.ok(u.includes("inline User User::from_value(const keyma::Value& v, const allocator_type& a) { return keyma::from_value<User>(v, a); }"));
        assert.ok(u.includes("inline keyma::Value User::to_value(const allocator_type& a) const { return keyma::value_traits<User>::to_value(*this, a); }"));
    });

    it("attaches validators/formatters/refs by direct-ref factory call (no registry)", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        assert.ok(u.includes("app::src::validators::minLength(2)"));
        assert.ok(u.includes("keyma::Phase::Change, app::src::formatters::trim()"));
        assert.ok(u.includes("keyma::Phase::Save"));                              // server/library includes save phase
        assert.ok(u.includes("&app::src::address::Address::metadata"));
        assert.ok(u.includes("&app::src::tag::Tag::metadata"));
        assert.ok(!u.includes("apply_defaults"), "metadata no longer carries an apply_defaults fn-ptr");
    });

    it("applies both literal and expression defaults at construction (value_traits::from_value)", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        // Defaults now apply at construction: an absent key takes the field default, round-tripped
        // through a keyma::Value so every default kind flows through the same typed from_value.
        assert.ok(u.includes('v.at("role").is_null() ?'));                            // role takes its default when absent
        assert.ok(u.includes('keyma::to_value("user", a)'));                          // literal default
        assert.ok(u.includes('keyma::to_value("active", a)'));                        // enum literal default
        assert.ok(u.includes('v.at("created").is_null() ?'));                         // expression default (new Date())
    });

    it("emits services as abstract classes with pure virtual functions", () => {
        const s = fileBySuffix(files, "services.hpp");
        assert.ok(s.includes("namespace app::services {"));
        assert.ok(s.includes("class AccountService {"));
        assert.ok(s.includes("virtual ~AccountService() = default;"));
        assert.ok(s.includes("virtual std::shared_ptr<app::src::user::User> signup(const app::src::user::User& user) = 0;"));
        assert.ok(s.includes("virtual bool resend(const std::pmr::string& email) = 0;"));
        assert.ok(s.includes("virtual std::pmr::vector<app::src::tag::Tag> listTags() = 0;"));
        assert.ok(s.includes("virtual bool purge() = 0;"));                        // private method present in server/library
        assert.ok(s.includes('#include "src/user.hpp"'));
        assert.ok(s.includes('#include "src/tag.hpp"'));
    });

    it("emits typed service-call client stubs (CallLeaf builders) as an opt-in header", () => {
        const c = fileBySuffix(files, "service-client.hpp");
        assert.ok(c.includes("#include <keyma/client.hpp>"));                       // depends on the client runtime
        assert.ok(c.includes("namespace app::client {"));
        assert.ok(c.includes("struct AccountService {"));
        // schema return (IR reference) → hydrate the full object to the value type
        assert.ok(c.includes("static keyma::CallLeaf<app::src::user::User> signup(const app::src::user::User& user, keyma::alloc_t __alloc = {})"));
        assert.ok(c.includes('__args.set("user", keyma::to_value(user, __alloc));'));  // embedded arg → full object
        assert.ok(c.includes("static keyma::CallLeaf<bool> resend(const std::pmr::string& email, keyma::alloc_t __alloc = {})"));
        assert.ok(c.includes("static keyma::CallLeaf<std::pmr::vector<app::src::tag::Tag>> listTags(keyma::alloc_t __alloc = {})"));  // array return
        assert.ok(c.includes("keyma::Keyma::call("));
        // the opt-in stub header is NOT pulled into index.hpp (keeps it vendor-safe)
        const idx = fileBySuffix(files, "index.hpp");
        assert.ok(!idx.includes("service-client.hpp"), "service-client.hpp must stay opt-in");
    });

    it("computes cross-header includes from refs and validator/formatter use", () => {
        const u = fileBySuffix(files, "src/user.hpp");
        for (const inc of ['#include <keyma/runtime.hpp>', '#include "src/validators.hpp"', '#include "src/formatters.hpp"', '#include "src/address.hpp"', '#include "src/tag.hpp"']) {
            assert.ok(u.includes(inc), `user.hpp missing ${inc}`);
        }
    });

    it("index.hpp hoists schemas, enums, and services into the root namespace", () => {
        const idx = fileBySuffix(files, "index.hpp");
        assert.ok(idx.includes("namespace app {"));
        assert.ok(idx.includes('#include "src/user.hpp"'));
        assert.ok(idx.includes('#include "services.hpp"'));
        assert.ok(idx.includes("using src::user::User;"));
        assert.ok(idx.includes("using src::user::Status;"));
        assert.ok(!idx.includes("materialize_User"), "materializers are removed — none should be hoisted");
        assert.ok(idx.includes("using services::AccountService;"));
    });

    it("validators/formatters live in the configured namespace and use C++23 std::expected", () => {
        const v = fileBySuffix(files, "validators.hpp");
        assert.ok(v.includes("namespace app::src::validators {"));
        assert.ok(v.includes("inline keyma::ValidatorFn minLength(auto value)"));
        assert.ok(v.includes("std::expected<void, keyma::ValidationError>"));
        assert.ok(v.includes('std::unexpected(keyma::ValidationError{'));
        const f = fileBySuffix(files, "formatters.hpp");
        assert.ok(f.includes("namespace app::src::formatters {"));
        assert.ok(f.includes("inline keyma::FormatterFn trim()"));
    });
});

describe("emitCpp — client bundle gating", async () => {
    const { files } = await emitCpp(sampleIR(), { language: "cpp", outDir: "out", client: true, server: false }, CFG);
    const paths = files.map((f) => f.path);
    const u = fileBySuffix(files, "src/user.hpp");

    it("emits into a client/ subdirectory", () => {
        assert.ok(paths.includes("out/client/src/user.hpp"));
        assert.ok(paths.includes("out/client/index.hpp"));
    });

    it("omits the private schema entirely", () => {
        assert.ok(!paths.some((p) => p.endsWith("secret.hpp")), `private schema leaked: ${paths.join(", ")}`);
    });

    it("omits private fields, save-phase formatters, indexes, defaults, and materializers", () => {
        assert.ok(!u.includes("secretNote"), "private field leaked into client bundle");
        assert.ok(!u.includes("Phase::Save"), "save-phase formatter leaked into client bundle");
        assert.ok(!u.includes("IndexMeta") && !u.includes("__idx"), "index metadata leaked into client bundle");
        assert.ok(!u.includes("apply_defaults"), "defaults leaked into client bundle");
        assert.ok(!u.includes("materialize_User"), "materializer leaked into client bundle");
    });

    it("still emits public fields, the change-phase formatter, and validators", () => {
        assert.ok(u.includes("std::pmr::string firstName;"));
        assert.ok(u.includes("keyma::Phase::Change"));
        assert.ok(u.includes("app::src::validators::minLength(2)"));
        assert.ok(u.includes("std::shared_ptr<app::src::tag::Tag> primaryTag;")); // references map the same way
    });

    it("emits public services but omits private methods", () => {
        assert.ok(paths.includes("out/client/services.hpp"));
        const s = fileBySuffix(files, "client/services.hpp");
        assert.ok(s.includes("virtual bool resend(const std::pmr::string& email) = 0;"));
        assert.ok(!s.includes("purge"), "private service method leaked into client bundle");
    });
});

describe("emitCpp — vendorRuntime (zero-dependency drop)", async () => {
    const { files } = await emitCpp(sampleIR(), { language: "cpp", outDir: "out", library: true, vendorRuntime: true }, CFG);
    const paths = files.map((f) => f.path);

    it("emits a self-contained keyma_runtime.hpp and includes it by quoted local name", () => {
        assert.ok(paths.includes("out/keyma_runtime.hpp"), `missing vendored runtime: ${paths.join(", ")}`);
        const rt = fileBySuffix(files, "keyma_runtime.hpp");
        assert.ok(rt.includes("class Value"));
        assert.ok(rt.includes("class move_only_function"), "vendored runtime should carry the move_only_function polyfill");
        assert.ok(!/\bstd::move_only_function\s*</.test(rt), "vendored runtime should not depend on std::move_only_function");
        assert.ok(rt.includes("struct SchemaMeta"));
        assert.ok(rt.includes("struct value_traits"));
        assert.ok(rt.includes("from_value"));
        assert.ok(!rt.includes("#include <nlohmann") && !/#include\s+<boost/.test(rt));
        const u = fileBySuffix(files, "src/user.hpp");
        assert.ok(u.includes('#include "keyma_runtime.hpp"'));
        assert.ok(!u.includes("#include <keyma/runtime.hpp>"), "angle-bracket runtime include leaked in vendor mode");
    });
});

describe("emitCpp — sized numeric member types", async () => {
    const loc = { file: "/proj/src/nums.ts", line: 1, column: 1 };
    const f = (name: string, type: IRType): IRMember => ({
        name, type, visibility: "public", readonly: false, required: true,
        source: loc,
    });
    const ir: KeymaIR = {
        irVersion: "7.1.0", compilerVersion: "0.1.0", sourceRoot: "/proj/src",
        classes: [{
            name: "nums", sourceName: "Nums", visibility: "public",
            fields: [
                f("i8", { kind: "integer", bits: 8 }),
                f("i16", { kind: "integer", bits: 16 }),
                f("i32", { kind: "integer", bits: 32 }),
                f("big", { kind: "integer" }),                              // 64 default
                f("u8", { kind: "integer", bits: 8, unsigned: true }),
                f("u32", { kind: "integer", bits: 32, unsigned: true }),
                f("u64", { kind: "integer", unsigned: true }),             // 64 default
                f("f32", { kind: "number", bits: 32 }),
                f("f64", { kind: "number" }),                              // 64 default
            ],
            source: loc,
        }],
        functionDeclarations: [],
        enums: [], diagnostics: [],
    };
    const { files } = await emitCpp(ir, { language: "cpp", outDir: "out", library: true }, CFG);

    it("emits sized signed/unsigned ints and float/double struct members", () => {
        const m = fileBySuffix(files, "src/nums.hpp");
        assert.ok(m.includes("std::int8_t i8;"), m);
        assert.ok(m.includes("std::int16_t i16;"));
        assert.ok(m.includes("std::int32_t i32;"));
        assert.ok(m.includes("std::int64_t big;"));
        assert.ok(m.includes("std::uint8_t u8;"));
        assert.ok(m.includes("std::uint32_t u32;"));
        assert.ok(m.includes("std::uint64_t u64;"));
        assert.ok(m.includes("float f32;"));
        assert.ok(m.includes("double f64;"));
    });
});

describe("emitSupportHpp — vendored runtime drift guard", () => {
    it("carries the serialization layer and Value::push exactly once", () => {
        const rt = emitSupportHpp();
        assert.ok(rt.includes("void push(Value value);"));
        assert.ok(rt.includes("template <class T> struct value_traits;"));
        assert.ok(rt.includes("T from_value(const Value& v, alloc_t a)"));
        assert.ok(rt.includes("from_value_field"));
        assert.equal(rt.split("#pragma once").length - 1, 1, "vendored runtime must have exactly one #pragma once");
    });
});
