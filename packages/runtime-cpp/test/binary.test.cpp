// Cross-runtime binary parity for @keyma/runtime-cpp. Reads the SAME canonical fixtures the
// JS reference codec generates (packages/runtime-js/test/binary-fixtures.json, passed in via
// -DKEYMA_BINARY_FIXTURES) and asserts byte-identical output, a decode→re-encode round-trip,
// and the unknown-tag skip (durability) guarantee. Compiled and run by scripts/cpp-test.sh.

#include <keyma/binary.hpp>
#include <keyma/json.hpp>

#include <array>
#include <cassert>
#include <cstdint>
#include <deque>
#include <fstream>
#include <iostream>
#include <memory_resource>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifndef KEYMA_BINARY_FIXTURES
#error "KEYMA_BINARY_FIXTURES must be defined (path to binary-fixtures.json)"
#endif

using namespace keyma;

namespace {

// ── Stable storage for the dynamically-built SchemaMeta graph ──
// std::deque keeps element references stable across growth (string_views and spans into
// these outlive their construction). Function-pointer refs are wired via indexed accessor
// thunks (a SchemaMeta::refs entry is a `const SchemaMeta& (*)()`).
struct Registry {
    std::deque<std::string> strings;
    std::deque<std::vector<FieldMeta>> field_lists;
    std::deque<SchemaMeta> schemas;
    std::deque<std::vector<std::pair<std::string_view, const SchemaMeta& (*)()>>> ref_lists;
    std::vector<const SchemaMeta*> by_index;

    std::string_view intern(std::string_view s) {
        strings.emplace_back(s);
        return strings.back();
    }
};
Registry g_reg;

template <std::size_t I>
const SchemaMeta& schema_acc() {
    return *g_reg.by_index[I];
}
using Acc = const SchemaMeta& (*)();
template <std::size_t... Is>
std::array<Acc, sizeof...(Is)> make_accs(std::index_sequence<Is...>) {
    return {{&schema_acc<Is>...}};
}
const std::array<Acc, 16> g_accs = make_accs(std::make_index_sequence<16>{});

TypeTag tag_of(std::string_view k) {
    if (k == "string") return TypeTag::String;
    if (k == "number") return TypeTag::Number;
    if (k == "integer") return TypeTag::Integer;
    if (k == "bigint") return TypeTag::BigInt;
    if (k == "decimal") return TypeTag::Decimal;
    if (k == "boolean") return TypeTag::Boolean;
    if (k == "bytes") return TypeTag::Bytes;
    if (k == "json") return TypeTag::Json;
    if (k == "date") return TypeTag::Date;
    if (k == "dateTime") return TypeTag::DateTime;
    if (k == "time") return TypeTag::Time;
    if (k == "id") return TypeTag::Id;
    if (k == "enum") return TypeTag::Enum;
    if (k == "array") return TypeTag::Array;
    if (k == "reference") return TypeTag::Reference;
    if (k == "embedded") return TypeTag::Embedded;
    return TypeTag::String;
}

FieldMeta build_field(const Value& f) {
    FieldMeta fm{};
    fm.name = g_reg.intern(f.at("name").as_string());
    const Value& type = f.at("type");
    std::string_view kind = type.at("kind").as_string();
    fm.type = tag_of(kind);
    if (const Value* vis = f.find("visibility"); vis && vis->is_string() && vis->as_string() == "private")
        fm.visibility = Visibility::Private;
    if (const Value* eph = f.find("ephemeral"); eph && eph->is_bool() && eph->as_bool())
        fm.ephemeral = true;
    if (const Value* tg = f.find("tag"); tg && tg->is_int())
        fm.tag = static_cast<std::uint32_t>(tg->as_int());

    // For arrays, the wire-relevant detail (bits/unsigned/target/idType) lives on the element.
    const Value* core = &type;
    if (kind == "array") {
        const Value& of = type.at("of");
        fm.element = tag_of(of.at("kind").as_string());
        core = &of;
    }
    if (const Value* b = core->find("bits"); b && b->is_int())
        fm.bits = static_cast<int>(b->as_int());
    if (const Value* u = core->find("unsigned"); u && u->is_bool() && u->as_bool())
        fm.is_unsigned = true;
    if (const Value* sc = core->find("schema"); sc && sc->is_string())
        fm.target = g_reg.intern(sc->as_string());
    if (const Value* idt = core->find("idType"); idt && idt->is_object()) {
        fm.id_type = tag_of(idt->at("kind").as_string());
        if (const Value* iu = idt->find("unsigned"); iu && iu->is_bool() && iu->as_bool())
            fm.id_unsigned = true;
    }
    return fm;
}

void fill_schema(SchemaMeta& sm, const Value& meta,
                 std::span<const std::pair<std::string_view, const SchemaMeta& (*)()>> refs) {
    sm.name = g_reg.intern(meta.at("name").as_string());
    sm.source_name = g_reg.intern(meta.at("sourceName").as_string());
    g_reg.field_lists.emplace_back();
    std::vector<FieldMeta>& fields = g_reg.field_lists.back();
    for (const Value& fv : meta.at("fields").as_array()) fields.push_back(build_field(fv));
    sm.fields = std::span<const FieldMeta>(fields.data(), fields.size());
    sm.refs = refs;
}

const SchemaMeta& build_all(const Value& top_meta, const Value* schemas_map) {
    g_reg.ref_lists.emplace_back();
    auto& reflist = g_reg.ref_lists.back();

    // Phase A: reserve a stable SchemaMeta + accessor slot per sub-schema.
    std::vector<SchemaMeta*> subs;
    if (schemas_map != nullptr && schemas_map->is_object()) {
        for (const Value::Member& m : schemas_map->as_object()) {
            g_reg.schemas.emplace_back();
            SchemaMeta* sm = &g_reg.schemas.back();
            std::size_t slot = g_reg.by_index.size();
            assert(slot < g_accs.size());
            g_reg.by_index.push_back(sm);
            reflist.emplace_back(g_reg.intern(m.key), g_accs[slot]);
            subs.push_back(sm);
        }
    }
    std::span<const std::pair<std::string_view, const SchemaMeta& (*)()>> refspan(reflist.data(), reflist.size());

    // Phase B: fill the sub-schemas (every schema shares the full ref list, like the JS map).
    std::size_t si = 0;
    if (schemas_map != nullptr && schemas_map->is_object()) {
        for (const Value::Member& m : schemas_map->as_object()) fill_schema(*subs[si++], m.value, refspan);
    }

    g_reg.schemas.emplace_back();
    SchemaMeta* top = &g_reg.schemas.back();
    fill_schema(*top, top_meta, refspan);
    return *top;
}

std::pmr::vector<std::byte> hex_to_bytes(std::string_view h, alloc_t a) {
    auto nib = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return 0;
    };
    std::pmr::vector<std::byte> out(a);
    for (std::size_t i = 0; i + 1 < h.size(); i += 2)
        out.push_back(static_cast<std::byte>((nib(h[i]) << 4) | nib(h[i + 1])));
    return out;
}

// Expand the committed wire record (with $date/$bytes/$bigint wrappers) into a keyma::Value.
Value build_record(const Value& v, alloc_t a) {
    if (v.is_object()) {
        const Value::Object& o = v.as_object();
        if (o.size() == 1) {
            const Value::Member& m = o[0];
            if (m.key == "$date") return Value(m.value.as_int(), a);
            if (m.key == "$bigint") return Value(static_cast<std::int64_t>(std::stoll(std::string(m.value.as_string()))), a);
            if (m.key == "$bytes") {
                std::pmr::vector<std::byte> raw = hex_to_bytes(m.value.as_string(), a);
                std::pmr::string b64 = detail::base64_encode(std::span<const std::byte>(raw.data(), raw.size()), a);
                return Value(std::string_view(b64), a);
            }
        }
        Value out = Value::object(a);
        for (const Value::Member& m : o) out.set(m.key, build_record(m.value, a));
        return out;
    }
    if (v.is_array()) {
        Value out = Value::array(a);
        for (const Value& e : v.as_array()) out.push(build_record(e, a));
        return out;
    }
    return Value(v, a);
}

std::string to_hex(std::span<const std::byte> b) {
    static const char* H = "0123456789abcdef";
    std::string s;
    s.reserve(b.size() * 2);
    for (std::byte x : b) {
        unsigned u = std::to_integer<unsigned>(x);
        s.push_back(H[u >> 4]);
        s.push_back(H[u & 15]);
    }
    return s;
}

SerializeTarget target_of(std::string_view s) {
    if (s == "client") return SerializeTarget::Client;
    if (s == "database") return SerializeTarget::Database;
    return SerializeTarget::Server;
}

void test_skip_unknown_tags(alloc_t a) {
    static const FieldMeta wfields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id, .tag = 1},
        FieldMeta{.name = "extra", .type = TypeTag::String, .tag = 2},
        FieldMeta{.name = "n", .type = TypeTag::Integer, .tag = 3},
    };
    static const FieldMeta rfields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id, .tag = 1},
        FieldMeta{.name = "_gap", .type = TypeTag::String, .tag = 99},
        FieldMeta{.name = "n", .type = TypeTag::Integer, .tag = 3},
    };
    SchemaMeta writer{.name = "evolved", .source_name = "Evolved", .fields = wfields};
    SchemaMeta reader{.name = "evolved", .source_name = "Evolved", .fields = rfields};

    Value rec = Value::object(a);
    rec.set("id", Value("z1", a));
    rec.set("extra", Value("dropme", a));
    rec.set("n", Value(std::int64_t{5}, a));

    ByteBuf bytes = encode_binary(writer, rec, SerializeTarget::Server, a);
    Value decoded = decode_binary(reader, std::span<const std::byte>(bytes.data(), bytes.size()), a);
    assert(decoded.find("id") != nullptr && decoded.at("id").as_string() == "z1");
    assert(decoded.find("n") != nullptr && decoded.at("n").as_int() == 5);
    assert(decoded.find("extra") == nullptr);
    assert(decoded.find("_gap") == nullptr);
}

}  // namespace

int main() {
    std::pmr::monotonic_buffer_resource pool;
    alloc_t a(&pool);

    std::ifstream in(KEYMA_BINARY_FIXTURES);
    if (!in) {
        std::cerr << "runtime-cpp: cannot open fixtures " << KEYMA_BINARY_FIXTURES << "\n";
        return 1;
    }
    std::stringstream ss;
    ss << in.rdbuf();
    std::string text = ss.str();

    Value doc = json_parse(text, a);
    const Value& fixtures = doc.at("fixtures");

    int passed = 0, failed = 0;
    for (const Value& fx : fixtures.as_array()) {
        std::string name(fx.at("name").as_string());
        SerializeTarget target = target_of(fx.at("target").as_string());
        const SchemaMeta& schema = build_all(fx.at("schema"), fx.find("schemas"));
        Value record = build_record(fx.at("record"), a);

        ByteBuf bytes = encode_binary(schema, record, target, a);
        std::string got = to_hex(std::span<const std::byte>(bytes.data(), bytes.size()));
        std::string want(fx.at("hex").as_string());
        if (got != want) {
            ++failed;
            std::cerr << "FAIL (hex) " << name << "\n  want " << want << "\n  got  " << got << "\n";
            continue;
        }

        // Round-trip: decode then re-encode must reproduce identical bytes.
        Value back = decode_binary(schema, std::span<const std::byte>(bytes.data(), bytes.size()), a);
        ByteBuf rebytes = encode_binary(schema, back, target, a);
        std::string regot = to_hex(std::span<const std::byte>(rebytes.data(), rebytes.size()));
        if (regot != want) {
            ++failed;
            std::cerr << "FAIL (round-trip) " << name << "\n  want " << want << "\n  got  " << regot << "\n";
            continue;
        }
        ++passed;
    }

    test_skip_unknown_tags(a);

    std::cout << "runtime-cpp binary parity: " << passed << " passed, " << failed << " failed\n";
    return failed == 0 ? 0 : 1;
}
