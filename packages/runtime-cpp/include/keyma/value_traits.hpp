#pragma once

// The value_traits<T> / from_value<T> / to_value<T> serialization layer for @keyma/runtime-cpp —
// per-field coercion between a dynamic keyma::Value and a typed model. value_traits<T> is the
// customization point: built-in / library leaves are specialized here; each generated model struct
// specializes it (mapping field name ↔ member). Builds on keyma::Value, the intrinsics (alloc_t /
// DateTime / base64), and keyma::Field (keyma/metadata.hpp).

#include <cstddef>
#include <cstdint>
#include <memory>
#include <memory_resource>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

#include <keyma/value.hpp>
#include <keyma/intrinsics.hpp>
#include <keyma/metadata.hpp>

namespace keyma {

// ─── Serialization (value_traits<T>, from_value<T>, to_value<T>) ───────────────
//
// The runtime owns all per-field coercion between a dynamic keyma::Value and a typed
// model. value_traits<T> is the customization point: built-in / library types are
// specialized below; each generated model struct specializes it (mapping field name ↔
// member). The free functions keyma::from_value<T> / keyma::to_value<T> are what
// generated code calls. value_traits<T> is a CLASS template so generated specializations
// can be forward-declared — which is what lets reference cycles (A↔B) compile: a model
// header forward-declares the value_traits of every reference target before any struct
// instantiates it, then defines its own after the targets' headers are pulled in.

// Primary: declared, never defined. A type with no specialization fails loudly with a
// clean incomplete-type error at the use site (no SFINAE detector needed).
template <class T> struct value_traits;

// Generic deserialize entry point. A template, so its body is parsed only at the
// instantiation point — the key to compiling reference cycles.
template <class T> T from_value(const Value& v, alloc_t a) { return value_traits<T>::from_value(v, a); }

// Generic serialize entry point, CONSTRAINED off every leaf the non-template
// to_value(...) overloads already cover. So a deduced keyma::to_value(scalar, a) selects
// an overload (this template is non-viable), while keyma::to_value(composite, a) — an
// optional / Field / vector / shared_ptr / struct / enum — selects this template (no
// overload matches). An explicit keyma::to_value<T>(x, a) works for any non-leaf T.
template <class T>
    requires (!std::is_arithmetic_v<T>
              && !std::is_same_v<std::remove_cvref_t<T>, Value>
              && !std::is_same_v<std::remove_cvref_t<T>, DateTime>
              && !std::is_same_v<std::remove_cvref_t<T>, std::pmr::string>
              && !std::is_convertible_v<T, std::string_view>)
Value to_value(const T& x, alloc_t a) { return value_traits<T>::to_value(x, a); }

// Presence-aware member helper for keyma::Field<E> (optional AND nullable). Presence
// comes from the key POINTER: v.find(key) yields nullptr for an absent key, which
// v.at(key) cannot express (it returns a shared null Value, conflating absent with
// present-null). nullptr → absent; present-null → present with no value; else value.
template <class E> Field<E> from_value_field(const Value* p, alloc_t a) {
    Field<E> f;
    if (p == nullptr) { f.present = false; return f; }
    f.present = true;
    if (!p->is_null()) f.value = keyma::from_value<E>(*p, a);
    return f;
}

// ── Built-in / library leaf specializations ──
template <> struct value_traits<std::pmr::string> {
    static std::pmr::string from_value(const Value& v, alloc_t a) {
        return v.is_string() ? std::pmr::string(std::string_view(v.as_string()), a) : std::pmr::string(a);
    }
    static Value to_value(const std::pmr::string& s, alloc_t a) { return Value(std::string_view(s), a); }
};
template <> struct value_traits<bool> {
    static bool from_value(const Value& v, alloc_t) { return v.is_bool() && v.as_bool(); }
    static Value to_value(bool b, alloc_t a) { return Value(b, a); }
};
template <> struct value_traits<std::int64_t> {
    static std::int64_t from_value(const Value& v, alloc_t) { return v.is_number() ? v.as_int() : std::int64_t{0}; }
    static Value to_value(std::int64_t i, alloc_t a) { return Value(i, a); }
};
template <> struct value_traits<double> {
    static double from_value(const Value& v, alloc_t) { return v.is_number() ? v.as_double() : 0.0; }
    static Value to_value(double d, alloc_t a) { return Value(d, a); }
};
// Sized integer leaves (Integer<8|16|32>, Unsigned<8|16|32|64>). The Value variant only
// stores int64_t + double, so these read through as_int() / write through int64_t — width
// is a C++ member-type concern, not a wire concern. An out-of-range value truncates by
// static_cast (no runtime range check), mirroring the unchecked behaviour of int64_t.
template <> struct value_traits<std::int8_t> {
    static std::int8_t from_value(const Value& v, alloc_t) { return v.is_number() ? static_cast<std::int8_t>(v.as_int()) : std::int8_t{0}; }
    static Value to_value(std::int8_t i, alloc_t a) { return Value(static_cast<std::int64_t>(i), a); }
};
template <> struct value_traits<std::int16_t> {
    static std::int16_t from_value(const Value& v, alloc_t) { return v.is_number() ? static_cast<std::int16_t>(v.as_int()) : std::int16_t{0}; }
    static Value to_value(std::int16_t i, alloc_t a) { return Value(static_cast<std::int64_t>(i), a); }
};
template <> struct value_traits<std::int32_t> {
    static std::int32_t from_value(const Value& v, alloc_t) { return v.is_number() ? static_cast<std::int32_t>(v.as_int()) : std::int32_t{0}; }
    static Value to_value(std::int32_t i, alloc_t a) { return Value(static_cast<std::int64_t>(i), a); }
};
template <> struct value_traits<std::uint8_t> {
    static std::uint8_t from_value(const Value& v, alloc_t) { return v.is_number() ? static_cast<std::uint8_t>(v.as_int()) : std::uint8_t{0}; }
    static Value to_value(std::uint8_t i, alloc_t a) { return Value(static_cast<std::int64_t>(i), a); }
};
template <> struct value_traits<std::uint16_t> {
    static std::uint16_t from_value(const Value& v, alloc_t) { return v.is_number() ? static_cast<std::uint16_t>(v.as_int()) : std::uint16_t{0}; }
    static Value to_value(std::uint16_t i, alloc_t a) { return Value(static_cast<std::int64_t>(i), a); }
};
template <> struct value_traits<std::uint32_t> {
    static std::uint32_t from_value(const Value& v, alloc_t) { return v.is_number() ? static_cast<std::uint32_t>(v.as_int()) : std::uint32_t{0}; }
    static Value to_value(std::uint32_t i, alloc_t a) { return Value(static_cast<std::int64_t>(i), a); }
};
template <> struct value_traits<std::uint64_t> {
    static std::uint64_t from_value(const Value& v, alloc_t) { return v.is_number() ? static_cast<std::uint64_t>(v.as_int()) : std::uint64_t{0}; }
    static Value to_value(std::uint64_t i, alloc_t a) { return Value(static_cast<std::int64_t>(i), a); }
};
template <> struct value_traits<float> {
    static float from_value(const Value& v, alloc_t) { return v.is_number() ? static_cast<float>(v.as_double()) : 0.0f; }
    static Value to_value(float f, alloc_t a) { return Value(static_cast<double>(f), a); }
};
template <> struct value_traits<DateTime> {
    // is_number (not is_int): an epoch-ms that arrived as a double still converts.
    static DateTime from_value(const Value& v, alloc_t) { return v.is_number() ? date_from_epoch_ms(v.as_int()) : DateTime{}; }
    static Value to_value(DateTime t, alloc_t a) { return Value(date_get_time(t), a); }
};
template <> struct value_traits<Value> {
    static Value from_value(const Value& v, alloc_t a) { return Value(v, a); }
    static Value to_value(const Value& v, alloc_t a) { return Value(v, a); }
};
// bytes leaf (a `bytes` field lowers to std::pmr::vector<std::byte>; the full
// specialization wins over the generic vector<E> below). The canonical wire form is a
// base64 string (shared with the JS/Python runtimes), so to_value emits base64 and
// from_value decodes it. An in-process Value carrying the native Bytes variant is also
// accepted on the read side.
template <> struct value_traits<std::pmr::vector<std::byte>> {
    static std::pmr::vector<std::byte> from_value(const Value& v, alloc_t a) {
        if (v.is_string()) return detail::base64_decode(std::string_view(v.as_string()), a);
        if (v.is_bytes()) return std::pmr::vector<std::byte>(v.as_bytes(), a);
        return std::pmr::vector<std::byte>(a);
    }
    static Value to_value(const std::pmr::vector<std::byte>& b, alloc_t a) {
        return Value(std::string_view(detail::base64_encode(
                         std::span<const std::byte>(b.data(), b.size()), a)),
                     a);
    }
};

// ── Composite specializations (recurse, threading the allocator) ──
template <class E> struct value_traits<std::optional<E>> {
    // null (or absent, since at() yields null) → nullopt. The absent-vs-present-null
    // distinction is intentionally collapsed for the single-axis optional member.
    static std::optional<E> from_value(const Value& v, alloc_t a) {
        if (v.is_null()) return std::nullopt;
        return std::optional<E>(keyma::from_value<E>(v, a));
    }
    static Value to_value(const std::optional<E>& o, alloc_t a) {
        return o.has_value() ? value_traits<E>::to_value(*o, a) : Value(nullptr, a);
    }
};
// Field<E> value-only spec, for nested composition (e.g. vector<Field<E>>) and the
// generic from_value<Field<E>> entry. A Field MEMBER uses from_value_field for true
// presence; here a present Value distinguishes present-null from present-value.
template <class E> struct value_traits<Field<E>> {
    static Field<E> from_value(const Value& v, alloc_t a) {
        Field<E> f; f.present = true;
        if (!v.is_null()) f.value = keyma::from_value<E>(v, a);
        return f;
    }
    static Value to_value(const Field<E>& f, alloc_t a) {
        return (f.is_absent() || f.is_null()) ? Value(nullptr, a) : value_traits<E>::to_value(f.get(), a);
    }
};
template <class E> struct value_traits<std::pmr::vector<E>> {
    static std::pmr::vector<E> from_value(const Value& v, alloc_t a) {
        std::pmr::vector<E> out(a);
        if (v.is_array()) {
            out.reserve(v.as_array().size());
            for (const Value& e : v.as_array()) out.push_back(keyma::from_value<E>(e, a));
        }
        return out;
    }
    static Value to_value(const std::pmr::vector<E>& xs, alloc_t a) {
        Value arr = Value::array(a);
        for (const E& x : xs) arr.push(value_traits<E>::to_value(x, a));
        return arr;
    }
};
// shared_ptr<T>: a reference id-stub. from_value: an expanded object → full from_value;
// a bare id → an allocate_shared'd target carrying just its id (via the target's
// value_traits<T>::set_id); null/absent → a null pointer. to_value: ID-ONLY (via
// value_traits<T>::id_value) so a populated cycle terminates and round-trips. set_id /
// id_value are emitted on the TARGET's value_traits specialization (reference targets only).
template <class T> struct value_traits<std::shared_ptr<T>> {
    static std::shared_ptr<T> from_value(const Value& v, alloc_t a) {
        if (v.is_object()) return std::allocate_shared<T>(a, keyma::from_value<T>(v, a));
        if (!v.is_null())  { auto p = std::allocate_shared<T>(a); value_traits<T>::set_id(*p, v, a); return p; }
        return nullptr;
    }
    static Value to_value(const std::shared_ptr<T>& p, alloc_t a) {
        return p ? value_traits<T>::id_value(*p, a) : Value(nullptr, a);
    }
};

}  // namespace keyma
