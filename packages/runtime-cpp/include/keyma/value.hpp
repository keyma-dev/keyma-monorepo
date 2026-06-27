#pragma once

// keyma::Value and its std::formatter specialization for @keyma/runtime-cpp. Dependency-free
// (standard library only) so it composes into the umbrella runtime header (keyma/runtime.hpp)
// without an include cycle. Targets C++23 (std::pmr, std::format).

#include <cstddef>
#include <cstdint>
#include <format>
#include <memory>
#include <memory_resource>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace keyma {

// ─── Dynamic value ──────────────────────────────────────────────────────────
//
// keyma::Value is the allocator-aware dynamic representation of a record (and of
// `json`-typed fields). It is the currency at the validator/formatter/defaults
// boundary, mirroring the dict the Python runtime hands those functions. Typed
// model structs are constructed from a Value via their `from_value` factory.

class Value {
public:
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;
    using String = std::pmr::string;
    using Array = std::pmr::vector<Value>;
    using Bytes = std::pmr::vector<std::byte>;
    struct Member;
    using Object = std::pmr::vector<Member>;
    using Storage = std::variant<std::monostate, bool, std::int64_t, double, String, Array, Object, Bytes>;

    // These touch std::variant<…, Object, …>, whose construct/destroy/assign instantiate
    // std::vector<Member>'s operations — which require Member to be a complete type. Member
    // is only completed below the class (it holds a Value by value), so every member that
    // manipulates the variant is DECLARED here and DEFINED out-of-line after Member, where
    // it is complete. (libc++ enforces this; libstdc++ happens to tolerate the inline form.)
    Value() noexcept;
    explicit Value(const allocator_type& a) noexcept;

    // Converting constructors are explicit so a bare literal never implicitly becomes
    // a Value (which would make equality with literals ambiguous). Generated code
    // always builds Values explicitly (keyma::Value(...) / keyma::to_value(...)).
    explicit Value(std::nullptr_t, const allocator_type& a = {});
    explicit Value(bool b, const allocator_type& a = {});
    explicit Value(std::int64_t i, const allocator_type& a = {});
    explicit Value(int i, const allocator_type& a = {});
    explicit Value(double d, const allocator_type& a = {});
    explicit Value(std::string_view s, const allocator_type& a = {});
    explicit Value(const char* s, const allocator_type& a = {});

    // Allocator-extended copy/move — propagate `a` to every nested pmr member.
    Value(const Value& o, const allocator_type& a);
    Value(Value&& o, const allocator_type& a);

    Value(const Value& o);
    Value(Value&& o) noexcept;
    Value& operator=(const Value& o);
    Value& operator=(Value&& o);
    ~Value();

    allocator_type get_allocator() const noexcept { return alloc_; }

    static Value array(const allocator_type& a);
    static Value object(const allocator_type& a);

    bool is_null() const noexcept { return std::holds_alternative<std::monostate>(data_); }
    bool is_bool() const noexcept { return std::holds_alternative<bool>(data_); }
    bool is_int() const noexcept { return std::holds_alternative<std::int64_t>(data_); }
    bool is_double() const noexcept { return std::holds_alternative<double>(data_); }
    bool is_number() const noexcept { return is_int() || is_double(); }
    bool is_string() const noexcept { return std::holds_alternative<String>(data_); }
    bool is_array() const noexcept { return std::holds_alternative<Array>(data_); }
    bool is_object() const noexcept { return std::holds_alternative<Object>(data_); }
    bool is_bytes() const noexcept { return std::holds_alternative<Bytes>(data_); }

    bool as_bool() const { return std::get<bool>(data_); }
    std::int64_t as_int() const { return is_double() ? static_cast<std::int64_t>(std::get<double>(data_)) : std::get<std::int64_t>(data_); }
    double as_double() const { return is_int() ? static_cast<double>(std::get<std::int64_t>(data_)) : std::get<double>(data_); }
    const String& as_string() const { return std::get<String>(data_); }
    const Array& as_array() const { return std::get<Array>(data_); }
    const Object& as_object() const { return std::get<Object>(data_); }
    const Bytes& as_bytes() const { return std::get<Bytes>(data_); }

    const Storage& storage() const noexcept { return data_; }

    // Object lookup (defined out-of-line, once Member is complete). `find` returns
    // nullptr when absent; `at` returns a shared null Value so callers can read
    // missing keys without branching.
    const Value* find(std::string_view key) const noexcept;
    const Value& at(std::string_view key) const noexcept;
    void set(std::string_view key, Value value);
    // Append to an array (initializing to an empty array first if needed). The
    // counterpart of `set` for the array case; serialization (to_value of a vector)
    // builds arrays through it.
    void push(Value value);

    friend bool operator==(const Value& a, const Value& b);

private:
    static const Value& null_ref() noexcept { static const Value n; return n; }
    static Storage clone(const Storage& s, const allocator_type& a);
    static Storage clone(Storage&& s, const allocator_type& a);

    Storage data_;
    allocator_type alloc_;
};

struct Value::Member {
    Value::String key;
    Value value;
    friend bool operator==(const Member&, const Member&) = default;
};

// ── Value members defined out-of-line (Member is now complete) ──
inline Value::Value() noexcept : data_(std::monostate{}), alloc_() {}
inline Value::Value(const allocator_type& a) noexcept : data_(std::monostate{}), alloc_(a) {}
inline Value::Value(std::nullptr_t, const allocator_type& a) : data_(std::monostate{}), alloc_(a) {}
inline Value::Value(bool b, const allocator_type& a) : data_(b), alloc_(a) {}
inline Value::Value(std::int64_t i, const allocator_type& a) : data_(i), alloc_(a) {}
inline Value::Value(int i, const allocator_type& a) : data_(static_cast<std::int64_t>(i)), alloc_(a) {}
inline Value::Value(double d, const allocator_type& a) : data_(d), alloc_(a) {}
inline Value::Value(std::string_view s, const allocator_type& a) : data_(String(s, a)), alloc_(a) {}
inline Value::Value(const char* s, const allocator_type& a) : data_(String(s, a)), alloc_(a) {}
inline Value::Value(const Value& o, const allocator_type& a) : data_(clone(o.data_, a)), alloc_(a) {}
inline Value::Value(Value&& o, const allocator_type& a) : data_(clone(std::move(o.data_), a)), alloc_(a) {}
inline Value::Value(const Value& o) : data_(clone(o.data_, allocator_type{})), alloc_() {}
inline Value::Value(Value&& o) noexcept : data_(std::move(o.data_)), alloc_(o.alloc_) {}
inline Value& Value::operator=(const Value& o) { data_ = clone(o.data_, alloc_); return *this; }
inline Value& Value::operator=(Value&& o) { data_ = clone(std::move(o.data_), alloc_); return *this; }
inline Value::~Value() = default;
inline Value Value::array(const allocator_type& a) { Value v(a); v.data_ = Array(a); return v; }
inline Value Value::object(const allocator_type& a) { Value v(a); v.data_ = Object(a); return v; }

inline const Value* Value::find(std::string_view key) const noexcept {
    if (auto* o = std::get_if<Object>(&data_))
        for (const auto& m : *o) if (m.key == key) return &m.value;
    return nullptr;
}
inline const Value& Value::at(std::string_view key) const noexcept {
    const Value* p = find(key);
    return p != nullptr ? *p : null_ref();
}
inline void Value::set(std::string_view key, Value value) {
    if (!is_object()) data_ = Object(alloc_);
    auto& o = std::get<Object>(data_);
    for (auto& m : o) if (m.key == key) { m.value = std::move(value); return; }
    o.push_back(Member{String(key, alloc_), std::move(value)});
}
inline void Value::push(Value value) {
    if (!is_array()) data_ = Array(alloc_);
    std::get<Array>(data_).push_back(std::move(value));
}
inline bool operator==(const Value& a, const Value& b) { return a.data_ == b.data_; }
// Equality with a string (the common cross-field case, e.g. password confirmation).
// A concrete std::pmr::string converts to string_view, so `value == ctx.object.at("x")` works.
inline bool operator==(const Value& v, std::string_view s) { return v.is_string() && v.as_string() == s; }
inline bool operator==(std::string_view s, const Value& v) { return v == s; }
// Null comparison (the common `value != null` / `value !== undefined` guard in authored
// bodies lowers to `value != nullptr`). operator!= is synthesized from operator== (C++20).
inline bool operator==(const Value& v, std::nullptr_t) noexcept { return v.is_null(); }
inline bool operator==(std::nullptr_t, const Value& v) noexcept { return v.is_null(); }

inline Value::Storage Value::clone(const Storage& s, const allocator_type& a) {
    return std::visit([&](const auto& v) -> Storage {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, String>) return String(v, a);
        else if constexpr (std::is_same_v<T, Array>) {
            Array out(a); out.reserve(v.size());
            for (const auto& e : v) out.push_back(Value(e, a));
            return out;
        } else if constexpr (std::is_same_v<T, Object>) {
            Object out(a); out.reserve(v.size());
            for (const auto& m : v) out.push_back(Member{String(m.key, a), Value(m.value, a)});
            return out;
        } else if constexpr (std::is_same_v<T, Bytes>) return Bytes(v, a);
        else return v;
    }, s);
}
inline Value::Storage Value::clone(Storage&& s, const allocator_type& a) {
    return clone(static_cast<const Storage&>(s), a);
}

static_assert(std::uses_allocator_v<Value, Value::allocator_type>);

}  // namespace keyma

// std::format support for keyma::Value (used by template-literal interpolation).
template <>
struct std::formatter<keyma::Value, char> {
    constexpr auto parse(std::format_parse_context& ctx) { return ctx.begin(); }
    auto format(const keyma::Value& v, std::format_context& ctx) const {
        if (v.is_string()) return std::format_to(ctx.out(), "{}", v.as_string());
        if (v.is_int()) return std::format_to(ctx.out(), "{}", v.as_int());
        if (v.is_double()) return std::format_to(ctx.out(), "{}", v.as_double());
        if (v.is_bool()) return std::format_to(ctx.out(), "{}", v.as_bool());
        if (v.is_null()) return std::format_to(ctx.out(), "null");
        return std::format_to(ctx.out(), "[object]");
    }
};
