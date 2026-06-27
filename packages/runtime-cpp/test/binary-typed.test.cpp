// Typed binary codec parity for @keyma/runtime-cpp. Hand-writes structs with
// binary_traits<T> specializations in the EXACT shape the C++ backend codegen emits
// (binary-typed.hpp + emit-module.ts), then proves, for every type kind:
//
//   1. Round-trip: from_binary<T>(to_binary<T>(x, a), a) reproduces x.
//   2. Cross-path byte-equality (the cardinal invariant): to_binary<T>(x, a) is
//      byte-identical to the dynamic encode_binary(T::schema, equivalentValue, Server, a).
//      The dynamic codec is itself fixture-verified (binary.test.cpp) against the shared
//      cross-runtime fixtures, so this transitively ties the typed path to the wire spec.
//   3. wiretype `static_assert` parity (and a wiretype_of cross-check), permanently locking
//      the two wiretype derivations together.
//
// Standalone — no codegen, no fixtures needed. Compiled and run by scripts/cpp-test.sh.

// Lead with the umbrella so the kept codec headers compose in dependency order (the typed
// binary codec is then a no-op re-include).
#include <keyma/runtime.hpp>
#include <keyma/binary-typed.hpp>

#include <cassert>
#include <cstdint>
#include <iostream>
#include <memory>
#include <memory_resource>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

using namespace keyma;
namespace bd = keyma::binary_detail;

// ─── Test model types (mirroring codegen output) ────────────────────────────────

namespace app {

enum class Color { Red, Green };

// Every scalar leaf kind, all required & non-nullable (framing = "always").
struct Scalars {
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
    std::pmr::string id;
    std::int64_t big = 0;
    std::int32_t i32 = 0;
    std::uint32_t u32 = 0;
    std::uint64_t u64 = 0;
    bool flag = false;
    float f32 = 0.0f;
    double f64 = 0.0;
    keyma::DateTime when{};
    std::pmr::vector<std::byte> data;
    Color color = Color::Red;

    Scalars() = default;
    explicit Scalars(const allocator_type& a) : id(a), data(a) {}
    Scalars(const Scalars& o, const allocator_type& a)
        : id(o.id, a), big(o.big), i32(o.i32), u32(o.u32), u64(o.u64), flag(o.flag),
          f32(o.f32), f64(o.f64), when(o.when), data(o.data, a), color(o.color) {}
    Scalars(Scalars&& o, const allocator_type& a)
        : id(std::move(o.id), a), big(o.big), i32(o.i32), u32(o.u32), u64(o.u64), flag(o.flag),
          f32(o.f32), f64(o.f64), when(o.when), data(std::move(o.data), a), color(o.color) {}
    Scalars(const Scalars&) = default;
    Scalars(Scalars&&) = default;
    Scalars& operator=(const Scalars&) = default;
    Scalars& operator=(Scalars&&) = default;
    allocator_type get_allocator() const noexcept { return id.get_allocator(); }
};

// The presence/null framing matrix + arrays + json.
struct Wrappers {
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
    std::optional<std::pmr::string> opt;                    // optional-only → omit
    std::optional<std::pmr::string> nul;                    // nullable → WIRE_NULL
    keyma::Field<std::pmr::string> both;                    // two-axis
    std::pmr::vector<std::pmr::string> tags;                // array of scalars
    std::pmr::vector<std::optional<std::int64_t>> nums;     // element-nullable array
    keyma::Value js;                                        // json

    Wrappers() = default;
    explicit Wrappers(const allocator_type& a) : opt(), nul(), both(), tags(a), nums(a), js(a) {}
    Wrappers(const Wrappers& o, const allocator_type& a)
        : opt(keyma::alloc_opt(o.opt, a)), nul(keyma::alloc_opt(o.nul, a)), both(o.both),
          tags(o.tags, a), nums(o.nums, a), js(o.js, a) {}
    Wrappers(Wrappers&& o, const allocator_type& a)
        : opt(keyma::alloc_opt(std::move(o.opt), a)), nul(keyma::alloc_opt(std::move(o.nul), a)),
          both(std::move(o.both)), tags(std::move(o.tags), a), nums(std::move(o.nums), a), js(std::move(o.js), a) {}
    Wrappers(const Wrappers&) = default;
    Wrappers(Wrappers&&) = default;
    Wrappers& operator=(const Wrappers&) = default;
    Wrappers& operator=(Wrappers&&) = default;
    allocator_type get_allocator() const noexcept { return tags.get_allocator(); }
};

// Embedded target.
struct Addr {
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
    std::pmr::string city;
    std::int64_t zip = 0;

    Addr() = default;
    explicit Addr(const allocator_type& a) : city(a) {}
    Addr(const Addr& o, const allocator_type& a) : city(o.city, a), zip(o.zip) {}
    Addr(Addr&& o, const allocator_type& a) : city(std::move(o.city), a), zip(o.zip) {}
    Addr(const Addr&) = default;
    Addr(Addr&&) = default;
    Addr& operator=(const Addr&) = default;
    Addr& operator=(Addr&&) = default;
    allocator_type get_allocator() const noexcept { return city.get_allocator(); }
};

// Reference target with a STRING id.
struct Owner {
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
    std::pmr::string id;
    std::pmr::string name;

    Owner() = default;
    explicit Owner(const allocator_type& a) : id(a), name(a) {}
    Owner(const Owner& o, const allocator_type& a) : id(o.id, a), name(o.name, a) {}
    Owner(Owner&& o, const allocator_type& a) : id(std::move(o.id), a), name(std::move(o.name), a) {}
    Owner(const Owner&) = default;
    Owner(Owner&&) = default;
    Owner& operator=(const Owner&) = default;
    Owner& operator=(Owner&&) = default;
    allocator_type get_allocator() const noexcept { return id.get_allocator(); }
};

// Reference target with an INTEGER id.
struct Cat {
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
    std::int64_t id = 0;
    std::pmr::string label;

    Cat() = default;
    explicit Cat(const allocator_type& a) : label(a) {}
    Cat(const Cat& o, const allocator_type& a) : id(o.id), label(o.label, a) {}
    Cat(Cat&& o, const allocator_type& a) : id(o.id), label(std::move(o.label), a) {}
    Cat(const Cat&) = default;
    Cat(Cat&&) = default;
    Cat& operator=(const Cat&) = default;
    Cat& operator=(Cat&&) = default;
    allocator_type get_allocator() const noexcept { return label.get_allocator(); }
};

// Embedded + reference relations, including ARRAYS of embedded and of references.
struct Relations {
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
    std::pmr::string id;
    Addr addr;
    std::shared_ptr<Owner> owner;            // reference (string id)
    std::shared_ptr<Cat> cat;                // reference (int id)
    std::pmr::vector<Addr> addrs;            // array of embedded
    std::pmr::vector<std::shared_ptr<Cat>> cats;  // array of references

    Relations() = default;
    explicit Relations(const allocator_type& a) : id(a), addr(a), addrs(a), cats(a) {}
    Relations(const Relations& o, const allocator_type& a) : id(o.id, a), addr(o.addr, a), owner(o.owner), cat(o.cat), addrs(o.addrs, a), cats(o.cats, a) {}
    Relations(Relations&& o, const allocator_type& a) : id(std::move(o.id), a), addr(std::move(o.addr), a), owner(std::move(o.owner)), cat(std::move(o.cat)), addrs(std::move(o.addrs), a), cats(std::move(o.cats), a) {}
    Relations(const Relations&) = default;
    Relations(Relations&&) = default;
    Relations& operator=(const Relations&) = default;
    Relations& operator=(Relations&&) = default;
    allocator_type get_allocator() const noexcept { return id.get_allocator(); }
};

}  // namespace app

// ─── binary_traits + enum conversions (exact codegen shape) ─────────────────────

namespace keyma {

template <> inline std::string_view to_string<app::Color>(app::Color c) {
    switch (c) { case app::Color::Red: return "red"; case app::Color::Green: return "green"; }
    return {};
}
template <> inline app::Color from_string<app::Color>(std::string_view s) {
    if (s == "red") return app::Color::Red;
    if (s == "green") return app::Color::Green;
    return app::Color::Red;
}
template <> struct binary_traits<app::Color> {
    static constexpr std::uint8_t wiretype = bd::WIRE_LENGTH;
    static void encode_payload(ByteBuf& out, app::Color c, alloc_t) { bd::write_len_str(out, keyma::to_string(c)); }
    static app::Color decode_payload(bd::Reader& r, std::uint8_t, alloc_t) { return keyma::from_string<app::Color>(bd::read_len_str(r)); }
};

template <> struct binary_traits<app::Scalars> {
    using T = app::Scalars;
    static void encode_record(ByteBuf& out, const T& x, alloc_t a) {
        bd::write_key(out, 1, binary_traits<std::pmr::string>::wiretype);       keyma::encode_payload<std::pmr::string>(out, x.id, a);
        bd::write_key(out, 2, binary_traits<std::int64_t>::wiretype);           keyma::encode_payload<std::int64_t>(out, x.big, a);
        bd::write_key(out, 3, binary_traits<std::int32_t>::wiretype);           keyma::encode_payload<std::int32_t>(out, x.i32, a);
        bd::write_key(out, 4, binary_traits<std::uint32_t>::wiretype);          keyma::encode_payload<std::uint32_t>(out, x.u32, a);
        bd::write_key(out, 5, binary_traits<std::uint64_t>::wiretype);          keyma::encode_payload<std::uint64_t>(out, x.u64, a);
        bd::write_key(out, 6, binary_traits<bool>::wiretype);                   keyma::encode_payload<bool>(out, x.flag, a);
        bd::write_key(out, 7, binary_traits<float>::wiretype);                  keyma::encode_payload<float>(out, x.f32, a);
        bd::write_key(out, 8, binary_traits<double>::wiretype);                 keyma::encode_payload<double>(out, x.f64, a);
        bd::write_key(out, 9, binary_traits<keyma::DateTime>::wiretype);        keyma::encode_payload<keyma::DateTime>(out, x.when, a);
        bd::write_key(out, 10, binary_traits<std::pmr::vector<std::byte>>::wiretype); keyma::encode_payload<std::pmr::vector<std::byte>>(out, x.data, a);
        bd::write_key(out, 11, binary_traits<app::Color>::wiretype);            keyma::encode_payload<app::Color>(out, x.color, a);
    }
    static T decode_record(bd::Reader& r, alloc_t a) {
        T __o(a);
        while (r.pos < r.end) {
            std::uint64_t key = bd::read_varint(r);
            std::uint32_t tag = (std::uint32_t)(key >> 3);
            std::uint8_t wt = (std::uint8_t)(key & 7);
            switch (tag) {
                case 1: if (wt == bd::WIRE_NULL) {} else __o.id = keyma::decode_payload<std::pmr::string>(r, wt, a); break;
                case 2: if (wt == bd::WIRE_NULL) {} else __o.big = keyma::decode_payload<std::int64_t>(r, wt, a); break;
                case 3: if (wt == bd::WIRE_NULL) {} else __o.i32 = keyma::decode_payload<std::int32_t>(r, wt, a); break;
                case 4: if (wt == bd::WIRE_NULL) {} else __o.u32 = keyma::decode_payload<std::uint32_t>(r, wt, a); break;
                case 5: if (wt == bd::WIRE_NULL) {} else __o.u64 = keyma::decode_payload<std::uint64_t>(r, wt, a); break;
                case 6: if (wt == bd::WIRE_NULL) {} else __o.flag = keyma::decode_payload<bool>(r, wt, a); break;
                case 7: if (wt == bd::WIRE_NULL) {} else __o.f32 = keyma::decode_payload<float>(r, wt, a); break;
                case 8: if (wt == bd::WIRE_NULL) {} else __o.f64 = keyma::decode_payload<double>(r, wt, a); break;
                case 9: if (wt == bd::WIRE_NULL) {} else __o.when = keyma::decode_payload<keyma::DateTime>(r, wt, a); break;
                case 10: if (wt == bd::WIRE_NULL) {} else __o.data = keyma::decode_payload<std::pmr::vector<std::byte>>(r, wt, a); break;
                case 11: if (wt == bd::WIRE_NULL) {} else __o.color = keyma::decode_payload<app::Color>(r, wt, a); break;
                default: bd::skip_value(r, wt);
            }
        }
        return __o;
    }
};

template <> struct binary_traits<app::Wrappers> {
    using T = app::Wrappers;
    static void encode_record(ByteBuf& out, const T& x, alloc_t a) {
        // opt — optional-only (omit when absent)
        if (x.opt.has_value()) { bd::write_key(out, 1, binary_traits<std::pmr::string>::wiretype); keyma::encode_payload<std::pmr::string>(out, *x.opt, a); }
        // nul — nullable (WIRE_NULL when absent)
        if (x.nul.has_value()) { bd::write_key(out, 2, binary_traits<std::pmr::string>::wiretype); keyma::encode_payload<std::pmr::string>(out, *x.nul, a); }
        else { bd::write_key(out, 2, bd::WIRE_NULL); }
        // both — two-axis Field
        if (x.both.present) {
            if (x.both.value.has_value()) { bd::write_key(out, 3, binary_traits<std::pmr::string>::wiretype); keyma::encode_payload<std::pmr::string>(out, *x.both.value, a); }
            else { bd::write_key(out, 3, bd::WIRE_NULL); }
        }
        // tags — array of scalars (always)
        bd::write_key(out, 4, binary_traits<std::pmr::vector<std::pmr::string>>::wiretype); keyma::encode_payload<std::pmr::vector<std::pmr::string>>(out, x.tags, a);
        // nums — element-nullable array (always)
        bd::write_key(out, 5, binary_traits<std::pmr::vector<std::optional<std::int64_t>>>::wiretype); keyma::encode_payload<std::pmr::vector<std::optional<std::int64_t>>>(out, x.nums, a);
        // js — json (WIRE_NULL when the Value is null)
        if (x.js.is_null()) { bd::write_key(out, 6, bd::WIRE_NULL); }
        else { bd::write_key(out, 6, binary_traits<keyma::Value>::wiretype); keyma::encode_payload<keyma::Value>(out, x.js, a); }
    }
    static T decode_record(bd::Reader& r, alloc_t a) {
        T __o(a);
        while (r.pos < r.end) {
            std::uint64_t key = bd::read_varint(r);
            std::uint32_t tag = (std::uint32_t)(key >> 3);
            std::uint8_t wt = (std::uint8_t)(key & 7);
            switch (tag) {
                case 1: if (wt == bd::WIRE_NULL) __o.opt = std::nullopt; else __o.opt = keyma::decode_payload<std::pmr::string>(r, wt, a); break;
                case 2: if (wt == bd::WIRE_NULL) __o.nul = std::nullopt; else __o.nul = keyma::decode_payload<std::pmr::string>(r, wt, a); break;
                case 3: __o.both.present = true; if (wt == bd::WIRE_NULL) __o.both.value.reset(); else __o.both.value = keyma::decode_payload<std::pmr::string>(r, wt, a); break;
                case 4: if (wt == bd::WIRE_NULL) {} else __o.tags = keyma::decode_payload<std::pmr::vector<std::pmr::string>>(r, wt, a); break;
                case 5: if (wt == bd::WIRE_NULL) {} else __o.nums = keyma::decode_payload<std::pmr::vector<std::optional<std::int64_t>>>(r, wt, a); break;
                case 6: if (wt == bd::WIRE_NULL) __o.js = keyma::Value(nullptr, a); else __o.js = keyma::decode_payload<keyma::Value>(r, wt, a); break;
                default: bd::skip_value(r, wt);
            }
        }
        return __o;
    }
};

template <> struct binary_traits<app::Addr> {
    using T = app::Addr;
    static void encode_record(ByteBuf& out, const T& x, alloc_t a) {
        bd::write_key(out, 1, binary_traits<std::pmr::string>::wiretype); keyma::encode_payload<std::pmr::string>(out, x.city, a);
        bd::write_key(out, 2, binary_traits<std::int64_t>::wiretype);     keyma::encode_payload<std::int64_t>(out, x.zip, a);
    }
    static T decode_record(bd::Reader& r, alloc_t a) {
        T __o(a);
        while (r.pos < r.end) {
            std::uint64_t key = bd::read_varint(r);
            std::uint32_t tag = (std::uint32_t)(key >> 3);
            std::uint8_t wt = (std::uint8_t)(key & 7);
            switch (tag) {
                case 1: if (wt == bd::WIRE_NULL) {} else __o.city = keyma::decode_payload<std::pmr::string>(r, wt, a); break;
                case 2: if (wt == bd::WIRE_NULL) {} else __o.zip = keyma::decode_payload<std::int64_t>(r, wt, a); break;
                default: bd::skip_value(r, wt);
            }
        }
        return __o;
    }
    // Length-windowed payload methods so Addr works as an embedded field / vector<Addr> element.
    static constexpr std::uint8_t wiretype = bd::WIRE_LENGTH;
    static void encode_payload(ByteBuf& out, const T& x, alloc_t a) {
        ByteBuf __b(a); encode_record(__b, x, a);
        bd::write_len_raw(out, std::span<const std::byte>(__b.data(), __b.size()));
    }
    static T decode_payload(bd::Reader& r, std::uint8_t, alloc_t a) {
        bd::Reader __inner = bd::read_len_window(r);
        return decode_record(__inner, a);
    }
};

template <> struct binary_traits<app::Owner> {
    using T = app::Owner;
    static void encode_record(ByteBuf& out, const T& x, alloc_t a) {
        bd::write_key(out, 1, binary_traits<std::pmr::string>::wiretype); keyma::encode_payload<std::pmr::string>(out, x.id, a);
        bd::write_key(out, 2, binary_traits<std::pmr::string>::wiretype); keyma::encode_payload<std::pmr::string>(out, x.name, a);
    }
    static T decode_record(bd::Reader& r, alloc_t a) {
        T __o(a);
        while (r.pos < r.end) {
            std::uint64_t key = bd::read_varint(r);
            std::uint32_t tag = (std::uint32_t)(key >> 3);
            std::uint8_t wt = (std::uint8_t)(key & 7);
            switch (tag) {
                case 1: if (wt == bd::WIRE_NULL) {} else __o.id = keyma::decode_payload<std::pmr::string>(r, wt, a); break;
                case 2: if (wt == bd::WIRE_NULL) {} else __o.name = keyma::decode_payload<std::pmr::string>(r, wt, a); break;
                default: bd::skip_value(r, wt);
            }
        }
        return __o;
    }
    // Reference-target id helpers (string id).
    static constexpr std::uint8_t id_wiretype = binary_traits<std::pmr::string>::wiretype;
    static void encode_id_payload(ByteBuf& out, const T& t, alloc_t a) { keyma::encode_payload<std::pmr::string>(out, t.id, a); }
    static void decode_id_into(T& t, bd::Reader& r, std::uint8_t wt, alloc_t a) { t.id = keyma::decode_payload<std::pmr::string>(r, wt, a); }
};

template <> struct binary_traits<app::Cat> {
    using T = app::Cat;
    static void encode_record(ByteBuf& out, const T& x, alloc_t a) {
        bd::write_key(out, 1, binary_traits<std::int64_t>::wiretype);     keyma::encode_payload<std::int64_t>(out, x.id, a);
        bd::write_key(out, 2, binary_traits<std::pmr::string>::wiretype); keyma::encode_payload<std::pmr::string>(out, x.label, a);
    }
    static T decode_record(bd::Reader& r, alloc_t a) {
        T __o(a);
        while (r.pos < r.end) {
            std::uint64_t key = bd::read_varint(r);
            std::uint32_t tag = (std::uint32_t)(key >> 3);
            std::uint8_t wt = (std::uint8_t)(key & 7);
            switch (tag) {
                case 1: if (wt == bd::WIRE_NULL) {} else __o.id = keyma::decode_payload<std::int64_t>(r, wt, a); break;
                case 2: if (wt == bd::WIRE_NULL) {} else __o.label = keyma::decode_payload<std::pmr::string>(r, wt, a); break;
                default: bd::skip_value(r, wt);
            }
        }
        return __o;
    }
    // Reference-target id helpers (signed int id → zigzag varint).
    static constexpr std::uint8_t id_wiretype = binary_traits<std::int64_t>::wiretype;
    static void encode_id_payload(ByteBuf& out, const T& t, alloc_t a) { keyma::encode_payload<std::int64_t>(out, t.id, a); }
    static void decode_id_into(T& t, bd::Reader& r, std::uint8_t wt, alloc_t a) { t.id = keyma::decode_payload<std::int64_t>(r, wt, a); }
};

template <> struct binary_traits<app::Relations> {
    using T = app::Relations;
    static void encode_record(ByteBuf& out, const T& x, alloc_t a) {
        bd::write_key(out, 1, binary_traits<std::pmr::string>::wiretype); keyma::encode_payload<std::pmr::string>(out, x.id, a);
        // embedded (always): length-windowed sub-record
        bd::write_key(out, 2, bd::WIRE_LENGTH);
        { ByteBuf __b(a); binary_traits<app::Addr>::encode_record(__b, x.addr, a);
          bd::write_len_raw(out, std::span<const std::byte>(__b.data(), __b.size())); }
        // reference (string id) — omit when null
        if (x.owner) { bd::write_key(out, 3, binary_traits<app::Owner>::id_wiretype); binary_traits<app::Owner>::encode_id_payload(out, *x.owner, a); }
        // reference (int id) — omit when null
        if (x.cat) { bd::write_key(out, 4, binary_traits<app::Cat>::id_wiretype); binary_traits<app::Cat>::encode_id_payload(out, *x.cat, a); }
        // array of embedded (always)
        bd::write_key(out, 5, binary_traits<std::pmr::vector<app::Addr>>::wiretype); keyma::encode_payload<std::pmr::vector<app::Addr>>(out, x.addrs, a);
        // array of references (always)
        bd::write_key(out, 6, binary_traits<std::pmr::vector<std::shared_ptr<app::Cat>>>::wiretype); keyma::encode_payload<std::pmr::vector<std::shared_ptr<app::Cat>>>(out, x.cats, a);
    }
    static T decode_record(bd::Reader& r, alloc_t a) {
        T __o(a);
        while (r.pos < r.end) {
            std::uint64_t key = bd::read_varint(r);
            std::uint32_t tag = (std::uint32_t)(key >> 3);
            std::uint8_t wt = (std::uint8_t)(key & 7);
            switch (tag) {
                case 1: if (wt == bd::WIRE_NULL) {} else __o.id = keyma::decode_payload<std::pmr::string>(r, wt, a); break;
                case 2: if (wt == bd::WIRE_NULL) {} else { bd::Reader inner = bd::read_len_window(r); __o.addr = binary_traits<app::Addr>::decode_record(inner, a); } break;
                case 3: if (wt == bd::WIRE_NULL) __o.owner = nullptr; else { auto p = std::allocate_shared<app::Owner>(a); binary_traits<app::Owner>::decode_id_into(*p, r, wt, a); __o.owner = p; } break;
                case 4: if (wt == bd::WIRE_NULL) __o.cat = nullptr; else { auto p = std::allocate_shared<app::Cat>(a); binary_traits<app::Cat>::decode_id_into(*p, r, wt, a); __o.cat = p; } break;
                case 5: if (wt == bd::WIRE_NULL) {} else __o.addrs = keyma::decode_payload<std::pmr::vector<app::Addr>>(r, wt, a); break;
                case 6: if (wt == bd::WIRE_NULL) {} else __o.cats = keyma::decode_payload<std::pmr::vector<std::shared_ptr<app::Cat>>>(r, wt, a); break;
                default: bd::skip_value(r, wt);
            }
        }
        return __o;
    }
};

}  // namespace keyma

// ─── Dynamic-path schema metadata (the parity oracle) ───────────────────────────

namespace {

const ClassMetadata& addr_schema() {
    static const FieldMeta fields[] = {
        FieldMeta{.name = "city", .type = TypeTag::String, .tag = 1},
        FieldMeta{.name = "zip", .type = TypeTag::BigInt, .tag = 2},
    };
    static const ClassMetadata meta{.name = "addr", .source_name = "Addr", .fields = fields};
    return meta;
}
const ClassMetadata& owner_schema() {
    static const FieldMeta fields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id, .tag = 1},
        FieldMeta{.name = "name", .type = TypeTag::String, .tag = 2},
    };
    static const ClassMetadata meta{.name = "owner", .source_name = "Owner", .fields = fields};
    return meta;
}
const ClassMetadata& cat_schema() {
    static const FieldMeta fields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Integer, .tag = 1},
        FieldMeta{.name = "label", .type = TypeTag::String, .tag = 2},
    };
    static const ClassMetadata meta{.name = "cat", .source_name = "Cat", .fields = fields};
    return meta;
}

const ClassMetadata& scalars_schema() {
    static const FieldMeta fields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id, .tag = 1},
        FieldMeta{.name = "big", .type = TypeTag::BigInt, .tag = 2},
        FieldMeta{.name = "i32", .type = TypeTag::Integer, .tag = 3, .bits = 32},
        FieldMeta{.name = "u32", .type = TypeTag::Integer, .tag = 4, .bits = 32, .is_unsigned = true},
        FieldMeta{.name = "u64", .type = TypeTag::Integer, .tag = 5, .is_unsigned = true},
        FieldMeta{.name = "flag", .type = TypeTag::Boolean, .tag = 6},
        FieldMeta{.name = "f32", .type = TypeTag::Number, .tag = 7, .bits = 32},
        FieldMeta{.name = "f64", .type = TypeTag::Number, .tag = 8},
        FieldMeta{.name = "when", .type = TypeTag::DateTime, .tag = 9},
        FieldMeta{.name = "data", .type = TypeTag::Bytes, .tag = 10},
        FieldMeta{.name = "color", .type = TypeTag::Enum, .tag = 11},
    };
    static const ClassMetadata meta{.name = "scalars", .source_name = "Scalars", .fields = fields};
    return meta;
}

const ClassMetadata& wrappers_schema() {
    static const FieldMeta fields[] = {
        FieldMeta{.name = "opt", .type = TypeTag::String, .required = false, .tag = 1},
        FieldMeta{.name = "nul", .type = TypeTag::String, .nullable = true, .tag = 2},
        FieldMeta{.name = "both", .type = TypeTag::String, .required = false, .nullable = true, .tag = 3},
        FieldMeta{.name = "tags", .type = TypeTag::Array, .element = TypeTag::String, .tag = 4},
        FieldMeta{.name = "nums", .type = TypeTag::Array, .element = TypeTag::Integer, .tag = 5},
        FieldMeta{.name = "js", .type = TypeTag::Json, .tag = 6},
    };
    static const ClassMetadata meta{.name = "wrappers", .source_name = "Wrappers", .fields = fields};
    return meta;
}

const ClassMetadata& relations_schema() {
    static const std::pair<std::string_view, const ClassMetadata& (*)()> refs[] = {
        {"addr", &addr_schema}, {"owner", &owner_schema}, {"cat", &cat_schema},
    };
    static const FieldMeta fields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id, .tag = 1},
        FieldMeta{.name = "addr", .type = TypeTag::Embedded, .target = "addr", .tag = 2},
        FieldMeta{.name = "owner", .type = TypeTag::Reference, .target = "owner", .tag = 3, .id_type = TypeTag::Id},
        FieldMeta{.name = "cat", .type = TypeTag::Reference, .target = "cat", .tag = 4, .id_type = TypeTag::Integer},
        FieldMeta{.name = "addrs", .type = TypeTag::Array, .element = TypeTag::Embedded, .target = "addr", .tag = 5},
        FieldMeta{.name = "cats", .type = TypeTag::Array, .element = TypeTag::Reference, .target = "cat", .tag = 6, .id_type = TypeTag::Integer},
    };
    static const ClassMetadata meta{.name = "relations", .source_name = "Relations", .fields = fields, .refs = refs};
    return meta;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

std::string to_hex(std::span<const std::byte> b) {
    static const char* H = "0123456789abcdef";
    std::string s;
    s.reserve(b.size() * 2);
    for (std::byte x : b) { unsigned u = std::to_integer<unsigned>(x); s.push_back(H[u >> 4]); s.push_back(H[u & 15]); }
    return s;
}

int g_failed = 0;

void check_bytes(const char* label, const ByteBuf& typed, const ByteBuf& dyn) {
    std::string t = to_hex(std::span<const std::byte>(typed.data(), typed.size()));
    std::string d = to_hex(std::span<const std::byte>(dyn.data(), dyn.size()));
    if (t != d) {
        ++g_failed;
        std::cerr << "FAIL (byte-equality) " << label << "\n  typed   " << t << "\n  dynamic " << d << "\n";
    }
}

void expect(const char* label, bool ok) {
    if (!ok) { ++g_failed; std::cerr << "FAIL " << label << "\n"; }
}

}  // namespace

int main() {
    std::pmr::monotonic_buffer_resource pool;
    alloc_t a(&pool);

    // ── Scalars: round-trip + byte-equality ──
    {
        app::Scalars s(a);
        s.id = "rec-1";
        s.big = -123456789012;
        s.i32 = -2000111000;
        s.u32 = 4000000000u;
        s.u64 = 9000000000ull;
        s.flag = true;
        s.f32 = 1.5f;
        s.f64 = 2.5;
        s.when = date_from_epoch_ms(1700000000000LL);
        s.data = std::pmr::vector<std::byte>({std::byte{0xDE}, std::byte{0xAD}, std::byte{0xBE}, std::byte{0xEF}}, a);
        s.color = app::Color::Green;

        ByteBuf typed = keyma::to_binary<app::Scalars>(s, a);

        Value v = Value::object(a);
        v.set("id", Value(std::string_view(s.id), a));
        v.set("big", Value(s.big, a));
        v.set("i32", Value(static_cast<std::int64_t>(s.i32), a));
        v.set("u32", Value(static_cast<std::int64_t>(s.u32), a));
        v.set("u64", Value(static_cast<std::int64_t>(s.u64), a));
        v.set("flag", Value(s.flag, a));
        v.set("f32", Value(static_cast<double>(s.f32), a));
        v.set("f64", Value(s.f64, a));
        v.set("when", Value(date_get_time(s.when), a));
        v.set("data", Value(std::string_view(detail::base64_encode(std::span<const std::byte>(s.data.data(), s.data.size()), a)), a));
        v.set("color", Value(std::string_view(keyma::to_string(s.color)), a));
        ByteBuf dyn = encode_binary(scalars_schema(), v, SerializeTarget::Server, a);
        check_bytes("Scalars", typed, dyn);

        app::Scalars back = keyma::from_binary<app::Scalars>(std::span<const std::byte>(typed.data(), typed.size()), a);
        expect("Scalars.id", back.id == "rec-1");
        expect("Scalars.big", back.big == -123456789012);
        expect("Scalars.i32", back.i32 == -2000111000);
        expect("Scalars.u32", back.u32 == 4000000000u);
        expect("Scalars.u64", back.u64 == 9000000000ull);
        expect("Scalars.flag", back.flag == true);
        expect("Scalars.f32", back.f32 == 1.5f);
        expect("Scalars.f64", back.f64 == 2.5);
        expect("Scalars.when", date_get_time(back.when) == 1700000000000LL);
        expect("Scalars.data", back.data.size() == 4 && back.data[0] == std::byte{0xDE} && back.data[3] == std::byte{0xEF});
        expect("Scalars.color", back.color == app::Color::Green);
    }

    // u64 beyond int64 range: round-trips natively (cannot go through the dynamic Value).
    {
        app::Scalars s(a);
        s.id = "big-u64";
        s.u64 = 18000000000000000000ull;  // > INT64_MAX
        ByteBuf typed = keyma::to_binary<app::Scalars>(s, a);
        app::Scalars back = keyma::from_binary<app::Scalars>(std::span<const std::byte>(typed.data(), typed.size()), a);
        expect("Scalars.u64 wide", back.u64 == 18000000000000000000ull);
    }

    // ── Wrappers (populated): byte-equality + round-trip ──
    {
        app::Wrappers w(a);
        w.opt = std::pmr::string("o", a);
        w.nul = std::pmr::string("n", a);
        w.both.present = true; w.both.value = std::pmr::string("b", a);
        w.tags = std::pmr::vector<std::pmr::string>(a);
        w.tags.push_back(std::pmr::string("x", a));
        w.tags.push_back(std::pmr::string("y", a));
        w.nums = std::pmr::vector<std::optional<std::int64_t>>(a);
        w.nums.push_back(std::int64_t{5});
        w.nums.push_back(std::nullopt);   // element-null
        w.nums.push_back(std::int64_t{-3});
        w.js = Value::object(a);
        w.js.set("k", Value(std::int64_t{1}, a));
        { Value arr = Value::array(a); arr.push(Value(true, a)); arr.push(Value(nullptr, a)); w.js.set("arr", arr); }

        ByteBuf typed = keyma::to_binary<app::Wrappers>(w, a);

        Value v = Value::object(a);
        v.set("opt", Value(std::string_view("o"), a));
        v.set("nul", Value(std::string_view("n"), a));
        v.set("both", Value(std::string_view("b"), a));
        { Value arr = Value::array(a); arr.push(Value(std::string_view("x"), a)); arr.push(Value(std::string_view("y"), a)); v.set("tags", arr); }
        { Value arr = Value::array(a); arr.push(Value(std::int64_t{5}, a)); arr.push(Value(nullptr, a)); arr.push(Value(std::int64_t{-3}, a)); v.set("nums", arr); }
        v.set("js", Value(w.js, a));
        ByteBuf dyn = encode_binary(wrappers_schema(), v, SerializeTarget::Server, a);
        check_bytes("Wrappers (populated)", typed, dyn);

        app::Wrappers back = keyma::from_binary<app::Wrappers>(std::span<const std::byte>(typed.data(), typed.size()), a);
        expect("Wrappers.opt", back.opt.has_value() && *back.opt == "o");
        expect("Wrappers.nul", back.nul.has_value() && *back.nul == "n");
        expect("Wrappers.both", back.both.present && back.both.value.has_value() && *back.both.value == "b");
        expect("Wrappers.tags", back.tags.size() == 2 && back.tags[0] == "x" && back.tags[1] == "y");
        expect("Wrappers.nums", back.nums.size() == 3 && back.nums[0] == 5 && !back.nums[1].has_value() && back.nums[2] == -3);
        expect("Wrappers.js", back.js.is_object() && back.js.at("k").as_int() == 1 && back.js.at("arr").as_array().size() == 2);
    }

    // ── Wrappers (empty/null/absent framing): byte-equality + round-trip ──
    {
        app::Wrappers w(a);
        // opt absent (nullopt → omitted), nul null (→ WIRE_NULL), both absent (→ omitted)
        w.nul = std::nullopt;
        w.both.present = false;
        w.tags = std::pmr::vector<std::pmr::string>(a);                 // empty → 01 00
        w.nums = std::pmr::vector<std::optional<std::int64_t>>(a);      // empty
        w.js = Value(nullptr, a);                                       // null → WIRE_NULL

        ByteBuf typed = keyma::to_binary<app::Wrappers>(w, a);

        Value v = Value::object(a);
        // opt omitted (key absent); both omitted (key absent)
        v.set("nul", Value(nullptr, a));
        v.set("tags", Value::array(a));
        v.set("nums", Value::array(a));
        v.set("js", Value(nullptr, a));
        ByteBuf dyn = encode_binary(wrappers_schema(), v, SerializeTarget::Server, a);
        check_bytes("Wrappers (empty)", typed, dyn);

        app::Wrappers back = keyma::from_binary<app::Wrappers>(std::span<const std::byte>(typed.data(), typed.size()), a);
        expect("Wrappers(empty).opt", !back.opt.has_value());
        expect("Wrappers(empty).nul", !back.nul.has_value());
        expect("Wrappers(empty).both absent", !back.both.present);
        expect("Wrappers(empty).tags", back.tags.empty());
        expect("Wrappers(empty).nums", back.nums.empty());
        expect("Wrappers(empty).js", back.js.is_null());
    }

    // ── Relations (embedded + references): byte-equality + round-trip ──
    {
        app::Relations rel(a);
        rel.id = "r-1";
        rel.addr.city = "NYC";
        rel.addr.zip = 10001;
        rel.owner = std::allocate_shared<app::Owner>(a);
        rel.owner->id = std::pmr::string("u-7", a);
        rel.cat = std::allocate_shared<app::Cat>(a);
        rel.cat->id = 42;
        // array of embedded
        { app::Addr a1(a); a1.city = "LA"; a1.zip = 90001; rel.addrs.push_back(a1);
          app::Addr a2(a); a2.city = "SF"; a2.zip = 94016; rel.addrs.push_back(a2); }
        // array of references (int ids)
        { auto c1 = std::allocate_shared<app::Cat>(a); c1->id = 7; rel.cats.push_back(c1);
          auto c2 = std::allocate_shared<app::Cat>(a); c2->id = 8; rel.cats.push_back(c2); }

        ByteBuf typed = keyma::to_binary<app::Relations>(rel, a);

        Value v = Value::object(a);
        v.set("id", Value(std::string_view("r-1"), a));
        { Value addr = Value::object(a); addr.set("city", Value(std::string_view("NYC"), a)); addr.set("zip", Value(std::int64_t{10001}, a)); v.set("addr", addr); }
        v.set("owner", Value(std::string_view("u-7"), a));   // bare reference id (string)
        v.set("cat", Value(std::int64_t{42}, a));            // bare reference id (int)
        { Value arr = Value::array(a);
          { Value e = Value::object(a); e.set("city", Value(std::string_view("LA"), a)); e.set("zip", Value(std::int64_t{90001}, a)); arr.push(e); }
          { Value e = Value::object(a); e.set("city", Value(std::string_view("SF"), a)); e.set("zip", Value(std::int64_t{94016}, a)); arr.push(e); }
          v.set("addrs", arr); }
        { Value arr = Value::array(a); arr.push(Value(std::int64_t{7}, a)); arr.push(Value(std::int64_t{8}, a)); v.set("cats", arr); }
        ByteBuf dyn = encode_binary(relations_schema(), v, SerializeTarget::Server, a);
        check_bytes("Relations", typed, dyn);

        app::Relations back = keyma::from_binary<app::Relations>(std::span<const std::byte>(typed.data(), typed.size()), a);
        expect("Relations.id", back.id == "r-1");
        expect("Relations.addr.city", back.addr.city == "NYC");
        expect("Relations.addr.zip", back.addr.zip == 10001);
        expect("Relations.owner", back.owner && back.owner->id == "u-7");
        expect("Relations.cat", back.cat && back.cat->id == 42);
        expect("Relations.addrs", back.addrs.size() == 2 && back.addrs[0].city == "LA" && back.addrs[0].zip == 90001 && back.addrs[1].city == "SF");
        expect("Relations.cats", back.cats.size() == 2 && back.cats[0] && back.cats[0]->id == 7 && back.cats[1] && back.cats[1]->id == 8);
    }

    // Relations with null references → omitted; round-trips to null pointers.
    {
        app::Relations rel(a);
        rel.id = "r-2";
        rel.addr.city = "LA";
        rel.addr.zip = 90001;
        ByteBuf typed = keyma::to_binary<app::Relations>(rel, a);
        app::Relations back = keyma::from_binary<app::Relations>(std::span<const std::byte>(typed.data(), typed.size()), a);
        expect("Relations(null).owner", !back.owner);
        expect("Relations(null).cat", !back.cat);
        expect("Relations(null).addr", back.addr.city == "LA" && back.addr.zip == 90001);
    }

    // ── wiretype parity: static_asserts + a wiretype_of cross-check ──
    static_assert(binary_traits<std::pmr::string>::wiretype == bd::WIRE_LENGTH);
    static_assert(binary_traits<std::int64_t>::wiretype == bd::WIRE_VARINT);
    static_assert(binary_traits<std::int32_t>::wiretype == bd::WIRE_VARINT);
    static_assert(binary_traits<std::uint64_t>::wiretype == bd::WIRE_VARINT);
    static_assert(binary_traits<bool>::wiretype == bd::WIRE_VARINT);
    static_assert(binary_traits<keyma::DateTime>::wiretype == bd::WIRE_VARINT);
    static_assert(binary_traits<float>::wiretype == bd::WIRE_FIXED32);
    static_assert(binary_traits<double>::wiretype == bd::WIRE_FIXED64);
    static_assert(binary_traits<std::pmr::vector<std::byte>>::wiretype == bd::WIRE_LENGTH);
    static_assert(binary_traits<keyma::Value>::wiretype == bd::WIRE_LENGTH);
    static_assert(binary_traits<std::pmr::vector<std::int64_t>>::wiretype == bd::WIRE_LENGTH);
    static_assert(binary_traits<std::optional<std::int64_t>>::wiretype == bd::WIRE_VARINT);
    static_assert(binary_traits<app::Color>::wiretype == bd::WIRE_LENGTH);
    static_assert(binary_traits<app::Owner>::id_wiretype == bd::WIRE_LENGTH);   // string id
    static_assert(binary_traits<app::Cat>::id_wiretype == bd::WIRE_VARINT);     // int id
    static_assert(binary_traits<app::Addr>::wiretype == bd::WIRE_LENGTH);       // embedded struct as a leaf
    static_assert(binary_traits<std::shared_ptr<app::Cat>>::wiretype == bd::WIRE_VARINT);  // ref-as-element → target id wiretype
    static_assert(binary_traits<std::pmr::vector<app::Addr>>::wiretype == bd::WIRE_LENGTH);
    static_assert(binary_traits<std::pmr::vector<std::shared_ptr<app::Cat>>>::wiretype == bd::WIRE_LENGTH);

    // Lock the typed wiretype to the dynamic wiretype_of derivation for representative types.
    expect("wiretype_of string", binary_traits<std::pmr::string>::wiretype == bd::wiretype_of(bd::TypeInfo{.tag = TypeTag::String}));
    expect("wiretype_of int", binary_traits<std::int64_t>::wiretype == bd::wiretype_of(bd::TypeInfo{.tag = TypeTag::Integer}));
    expect("wiretype_of f32", binary_traits<float>::wiretype == bd::wiretype_of(bd::TypeInfo{.tag = TypeTag::Number, .bits = 32}));
    expect("wiretype_of f64", binary_traits<double>::wiretype == bd::wiretype_of(bd::TypeInfo{.tag = TypeTag::Number, .bits = 64}));
    expect("wiretype_of json", binary_traits<keyma::Value>::wiretype == bd::wiretype_of(bd::TypeInfo{.tag = TypeTag::Json}));
    expect("wiretype_of ref(int id)", binary_traits<app::Cat>::id_wiretype == bd::wiretype_of(bd::TypeInfo{.tag = TypeTag::Reference, .id_type = TypeTag::Integer}));

    std::cout << "runtime-cpp typed binary parity: " << (g_failed == 0 ? "all checks passed" : "FAILURES") << "\n";
    return g_failed == 0 ? 0 : 1;
}
