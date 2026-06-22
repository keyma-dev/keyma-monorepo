#pragma once

// Keyma C++ runtime (@keyma/runtime-cpp) — dependency-free, std::pmr throughout, C++23.
// Generated model headers consume this header (via #include <keyma/runtime.hpp>, or a
// vendored copy) plus only the C++ standard library. It provides the dynamic
// keyma::Value, the validation/formatting result types, the schema-metadata structs,
// the intrinsic helpers the expression lowering calls, and the value_traits<T> /
// from_value<T> / to_value<T> serialization layer the generated structs specialize.
// Requires a C++23 standard library that provides std::move_only_function (libstdc++ 14+).

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <expected>
#include <format>
#include <functional>
#include <memory>
#include <memory_resource>
#include <optional>
#include <regex>
#include <span>
#include <stdexcept>
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

    Value() noexcept : data_(std::monostate{}), alloc_() {}
    explicit Value(const allocator_type& a) noexcept : data_(std::monostate{}), alloc_(a) {}

    // Converting constructors are explicit so a bare literal never implicitly becomes
    // a Value (which would make equality with literals ambiguous). Generated code
    // always builds Values explicitly (keyma::Value(...) / keyma::to_value(...)).
    explicit Value(std::nullptr_t, const allocator_type& a = {}) : data_(std::monostate{}), alloc_(a) {}
    explicit Value(bool b, const allocator_type& a = {}) : data_(b), alloc_(a) {}
    explicit Value(std::int64_t i, const allocator_type& a = {}) : data_(i), alloc_(a) {}
    explicit Value(int i, const allocator_type& a = {}) : data_(static_cast<std::int64_t>(i)), alloc_(a) {}
    explicit Value(double d, const allocator_type& a = {}) : data_(d), alloc_(a) {}
    explicit Value(std::string_view s, const allocator_type& a = {}) : data_(String(s, a)), alloc_(a) {}
    explicit Value(const char* s, const allocator_type& a = {}) : data_(String(s, a)), alloc_(a) {}

    // Allocator-extended copy/move — propagate `a` to every nested pmr member.
    Value(const Value& o, const allocator_type& a) : data_(clone(o.data_, a)), alloc_(a) {}
    Value(Value&& o, const allocator_type& a) : data_(clone(std::move(o.data_), a)), alloc_(a) {}

    Value(const Value& o) : data_(clone(o.data_, allocator_type{})), alloc_() {}
    Value(Value&& o) noexcept : data_(std::move(o.data_)), alloc_(o.alloc_) {}
    Value& operator=(const Value& o) { data_ = clone(o.data_, alloc_); return *this; }
    Value& operator=(Value&& o) { data_ = clone(std::move(o.data_), alloc_); return *this; }
    ~Value() = default;

    allocator_type get_allocator() const noexcept { return alloc_; }

    static Value array(const allocator_type& a) { Value v(a); v.data_ = Array(a); return v; }
    static Value object(const allocator_type& a) { Value v(a); v.data_ = Object(a); return v; }

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

// ─── Validation / formatting result types ────────────────────────────────────

struct ValidationError {
    std::pmr::string field;
    std::pmr::string code;
    std::pmr::string message;
};

// The record under validation, for cross-field reads (`ctx.object.find("x")`).
struct Context {
    const Value& object;
};

using ValidatorFn = std::move_only_function<
    std::expected<void, ValidationError>(const Value&, std::string_view, const Context&) const>;
using FormatterFn = std::move_only_function<Value(const Value&, const Context&) const>;

// ─── Optional fields with two axes (presence × nullability) ───────────────────
//
// Emitted only for a field that is BOTH optional (may be absent) AND nullable
// (may be null) — avoids confusing std::optional<std::optional<T>>.
template <class T>
struct Field {
    bool present = false;
    std::optional<T> value;
    bool is_absent() const noexcept { return !present; }
    bool is_null() const noexcept { return present && !value.has_value(); }
    const T& get() const { return *value; }
};

// ─── Schema metadata ─────────────────────────────────────────────────────────

enum class TypeTag {
    String, Number, Integer, BigInt, Decimal, Boolean, Bytes, Json,
    Date, DateTime, Time, Id, Regexp, Enum, Array, Reference, Embedded,
};

enum class Visibility { Public, Private };
enum class Phase { Change, Blur, Submit, Save };

// A formatter attached to a field for a lifecycle phase.
struct PhasedFormatter {
    Phase phase;
    FormatterFn fn;
};

// A schema-level index over one or more fields.
struct IndexMeta {
    std::span<const std::string_view> fields{};
    bool unique = false;
};

// Edge metadata for a schema that models a graph edge. Endpoints reference node
// schemas by their `name`. Consumed by the server's traverse handler and the
// edge-endpoint branch of the projection builder.
struct EdgeMeta {
    std::string_view from;
    std::string_view from_field;
    std::string_view to;
    std::string_view to_field;
    std::string_view label;
    bool directed = false;
};

struct FieldMeta {
    std::string_view name;
    TypeTag type;
    bool required = true;
    bool nullable = false;
    bool readonly = false;
    bool computed = false;
    bool indexed = false;
    bool ephemeral = false;
    Visibility visibility = Visibility::Public;
    // When `type == TypeTag::Array`, `element` is the element's TypeTag. For a
    // Reference/Embedded field (or an array thereof), `target` is the target schema
    // `name`. These let the server's projection builder, serialize, and reference
    // normalization recover the type structure a nested FieldType tree would carry —
    // the flat `type` tag alone cannot. Defaulted so existing generated FieldMeta
    // (designated initializers) keep compiling unchanged.
    TypeTag element = TypeTag::String;
    std::string_view target{};
    std::span<const ValidatorFn> validators{};
    std::span<const PhasedFormatter> formatters{};
};

struct SchemaMeta {
    std::string_view name;
    std::string_view source_name;
    Visibility visibility = Visibility::Public;
    bool ephemeral = false;
    std::span<const FieldMeta> fields{};
    std::span<const IndexMeta> indexes{};
    // refs: target schema `name` → accessor for the target's metadata.
    std::span<const std::pair<std::string_view, const SchemaMeta& (*)()>> refs{};
    // Set only for schemas that model a graph edge; null otherwise.
    const EdgeMeta* edge = nullptr;
    void (*apply_defaults)(Value&, const Value::allocator_type&) = nullptr;
};

// ─── Intrinsic helpers ───────────────────────────────────────────────────────
//
// Overloaded free functions so the expression lowering can emit `keyma::<op>(recv, …)`
// uniformly; overload resolution picks the right form for a typed value or a Value.

using alloc_t = std::pmr::polymorphic_allocator<std::byte>;

// ─── Enum string conversion ───────────────────────────────────────────────────
//
// Generic, type-keyed conversions between a generated `enum class` and its string
// values. Each emitted enum provides a full specialization of both templates; the
// unspecialized primaries fail to compile (so a missing enum is caught loudly).
// Call sites: keyma::to_string(v) (deduced) and keyma::from_string<E>(s) (explicit).
template <class> inline constexpr bool always_false = false;
template <class E> std::string_view to_string(E) { static_assert(always_false<E>, "no keyma::to_string for this type"); return {}; }
template <class E> E from_string(std::string_view) { static_assert(always_false<E>, "no keyma::from_string for this type"); return E{}; }

inline std::int64_t length(std::string_view s) { return static_cast<std::int64_t>(s.size()); }
template <class T> std::int64_t length(const std::pmr::vector<T>& v) { return static_cast<std::int64_t>(v.size()); }

inline bool includes(std::string_view s, std::string_view sub) { return s.find(sub) != std::string_view::npos; }
template <class T, class U> bool includes(const std::pmr::vector<T>& v, const U& x) {
    return std::find(v.begin(), v.end(), x) != v.end();
}

inline bool starts_with(std::string_view s, std::string_view p) { return s.starts_with(p); }
inline bool ends_with(std::string_view s, std::string_view p) { return s.ends_with(p); }

inline std::pmr::string to_lower(std::string_view s, alloc_t a = {}) {
    std::pmr::string out(s, a);
    for (auto& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return out;
}
inline std::pmr::string to_upper(std::string_view s, alloc_t a = {}) {
    std::pmr::string out(s, a);
    for (auto& c : out) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return out;
}
inline std::pmr::string trim(std::string_view s, alloc_t a = {}) {
    std::size_t b = 0, e = s.size();
    while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
    return std::pmr::string(s.substr(b, e - b), a);
}

inline std::int64_t index_of(std::string_view s, std::string_view sub) {
    auto p = s.find(sub);
    return p == std::string_view::npos ? -1 : static_cast<std::int64_t>(p);
}
template <class T, class U> std::int64_t index_of(const std::pmr::vector<T>& v, const U& x) {
    auto it = std::find(v.begin(), v.end(), x);
    return it == v.end() ? -1 : static_cast<std::int64_t>(it - v.begin());
}

// JS slice semantics (negative indices count from the end; clamped).
inline std::pmr::string slice(std::string_view s, std::int64_t start, std::int64_t end, alloc_t a = {}) {
    const std::int64_t n = static_cast<std::int64_t>(s.size());
    auto norm = [n](std::int64_t i) { return i < 0 ? std::max<std::int64_t>(n + i, 0) : std::min<std::int64_t>(i, n); };
    const std::int64_t b = norm(start), e = norm(end);
    return b < e ? std::pmr::string(s.substr(b, e - b), a) : std::pmr::string(a);
}
inline std::pmr::string slice(std::string_view s, std::int64_t start, alloc_t a = {}) {
    return slice(s, start, static_cast<std::int64_t>(s.size()), a);
}

inline std::pmr::string char_at(std::string_view s, std::int64_t i, alloc_t a = {}) {
    return (i >= 0 && i < static_cast<std::int64_t>(s.size())) ? std::pmr::string(s.substr(i, 1), a) : std::pmr::string(a);
}

inline std::pmr::string join(const std::pmr::vector<std::pmr::string>& v, std::string_view sep, alloc_t a = {}) {
    std::pmr::string out(a);
    for (std::size_t i = 0; i < v.size(); ++i) { if (i) out += sep; out += v[i]; }
    return out;
}

// JS `%`. Integral operands use the C++ remainder; any floating operand uses fmod
// (C++ `%` is ill-formed for floating-point). Lets the expression lowering emit a
// uniform keyma::mod(a, b) for the modulo operator.
template <class A, class B>
auto mod(A a, B b) {
    if constexpr (std::is_floating_point_v<A> || std::is_floating_point_v<B>) {
        return std::fmod(static_cast<double>(a), static_cast<double>(b));
    } else {
        return a % b;
    }
}

// JS Array.prototype.filter: the predicate is (element[, index]). Arity-adaptive so a
// body's callback may take just the element or both element and index.
template <class T, class Pred>
std::pmr::vector<T> filter(const std::pmr::vector<T>& v, Pred pred, alloc_t a = {}) {
    std::pmr::vector<T> out(a);
    std::int64_t i = 0;
    for (const auto& e : v) {
        const bool keep = [&] {
            if constexpr (std::is_invocable_v<Pred, const T&, std::int64_t>) return pred(e, i);
            else return pred(e);
        }();
        if (keep) out.push_back(e);
        ++i;
    }
    return out;
}

inline std::pmr::string replace(std::string_view s, std::string_view from, std::string_view to, alloc_t a = {}) {
    std::pmr::string out(s, a);
    auto p = out.find(from);
    if (p != std::pmr::string::npos) out.replace(p, from.size(), to);
    return out;
}
inline std::pmr::string replace(std::string_view s, const std::regex& re, std::string_view to, alloc_t a = {}) {
    return std::pmr::string(std::regex_replace(std::string(s), re, std::string(to)), a);
}
// JS String.prototype.replace(regex, fn): a function replacer, called per match with the
// matched substring; its result replaces the match. Replaces all matches (the `g`-flag
// case, which is when a function replacer is used in practice). Constrained so it does
// not collide with the string_view replacement overloads above.
template <class Fn>
    requires std::is_invocable_v<Fn, std::pmr::string>
std::pmr::string replace(std::string_view s, const std::regex& re, Fn fn, alloc_t a = {}) {
    const std::string in(s);
    std::pmr::string out(a);
    const auto end = std::sregex_iterator();
    std::size_t last = 0;
    for (auto it = std::sregex_iterator(in.begin(), in.end(), re); it != end; ++it) {
        const auto& m = *it;
        const std::size_t pos = static_cast<std::size_t>(m.position());
        out.append(in.data() + last, pos - last);
        std::pmr::string matched(m.str(), a);
        out.append(std::string_view(fn(matched)));
        last = pos + static_cast<std::size_t>(m.length());
    }
    out.append(in.data() + last, in.size() - last);
    return out;
}

// ─── Regex ────────────────────────────────────────────────────────────────────
// std::regex uses ECMAScript grammar (JS-compatible). Flags s/u/y are unsupported.
inline std::regex make_regex(std::string_view pattern, std::string_view flags = "") {
    auto opts = std::regex::ECMAScript;
    if (flags.find('i') != std::string_view::npos) opts |= std::regex::icase;
    if (flags.find('m') != std::string_view::npos) opts |= std::regex::multiline;
    return std::regex(std::string(pattern), opts);
}
inline bool regex_test(const std::regex& re, std::string_view s) {
    return std::regex_search(std::string(s), re);
}

// ─── Dates (std::chrono, UTC, millisecond precision) ──────────────────────────
using DateTime = std::chrono::sys_time<std::chrono::milliseconds>;

inline DateTime date_now() {
    return std::chrono::time_point_cast<std::chrono::milliseconds>(std::chrono::system_clock::now());
}
inline std::int64_t date_get_time(DateTime t) { return t.time_since_epoch().count(); }
inline DateTime date_from_epoch_ms(std::int64_t ms) { return DateTime{std::chrono::milliseconds{ms}}; }
inline DateTime date_from_components(int year, int month0, int day = 1, int hours = 0,
                                     int minutes = 0, int seconds = 0, int ms = 0) {
    auto ymd = std::chrono::year{year} / std::chrono::month{static_cast<unsigned>(month0 + 1)} /
               std::chrono::day{static_cast<unsigned>(day)};
    auto t = std::chrono::sys_days{ymd} + std::chrono::hours{hours} + std::chrono::minutes{minutes} +
             std::chrono::seconds{seconds} + std::chrono::milliseconds{ms};
    return std::chrono::time_point_cast<std::chrono::milliseconds>(t);
}
inline DateTime date_parse(std::string_view s) {
    int y = 1970, mo = 1, d = 1, h = 0, mi = 0, se = 0, ms = 0;
    std::string str(s);
    std::sscanf(str.c_str(), "%d-%d-%dT%d:%d:%d.%d", &y, &mo, &d, &h, &mi, &se, &ms);
    return date_from_components(y, mo - 1, d, h, mi, se, ms);
}

namespace detail {
inline std::chrono::year_month_day ymd_of(DateTime t) {
    return std::chrono::year_month_day{std::chrono::floor<std::chrono::days>(t)};
}
inline std::chrono::hh_mm_ss<std::chrono::milliseconds> hms_of(DateTime t) {
    auto days = std::chrono::floor<std::chrono::days>(t);
    return std::chrono::hh_mm_ss{t - days};
}
}  // namespace detail

inline int date_year(DateTime t) { return int(detail::ymd_of(t).year()); }
inline int date_month0(DateTime t) { return static_cast<int>(unsigned(detail::ymd_of(t).month())) - 1; }
inline int date_day(DateTime t) { return static_cast<int>(unsigned(detail::ymd_of(t).day())); }
inline int date_weekday(DateTime t) {
    return static_cast<int>(std::chrono::weekday{std::chrono::floor<std::chrono::days>(t)}.c_encoding());
}
inline int date_hours(DateTime t) { return static_cast<int>(detail::hms_of(t).hours().count()); }
inline int date_minutes(DateTime t) { return static_cast<int>(detail::hms_of(t).minutes().count()); }
inline int date_seconds(DateTime t) { return static_cast<int>(detail::hms_of(t).seconds().count()); }
inline int date_milliseconds(DateTime t) { return static_cast<int>(detail::hms_of(t).subseconds().count()); }

inline std::pmr::string to_iso8601(DateTime t, alloc_t a = {}) {
    auto days = std::chrono::floor<std::chrono::days>(t);
    auto ymd = std::chrono::year_month_day{days};
    auto hms = std::chrono::hh_mm_ss{t - days};
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02u-%02uT%02lld:%02lld:%02lld.%03lldZ",
        int(ymd.year()), unsigned(ymd.month()), unsigned(ymd.day()),
        static_cast<long long>(hms.hours().count()), static_cast<long long>(hms.minutes().count()),
        static_cast<long long>(hms.seconds().count()), static_cast<long long>(hms.subseconds().count()));
    return std::pmr::string(buf, a);
}

// ─── Type inspection (operate on a Value) ─────────────────────────────────────
inline bool type_is(const Value& v, std::string_view name) {
    if (name == "string") return v.is_string();
    if (name == "number") return v.is_number();
    if (name == "boolean") return v.is_bool();
    if (name == "bigint") return v.is_int();
    if (name == "undefined") return v.is_null();
    if (name == "object") return v.is_object() || v.is_array();
    return false;
}
inline bool instance_of(const Value& v, std::string_view ctor) {
    if (ctor == "Array") return v.is_array();
    if (ctor == "Uint8Array") return v.is_bytes();
    return false;
}

// Wrap a concrete value into a Value (used by formatters/defaults/materializers).
inline Value to_value(std::string_view s, alloc_t a = {}) { return Value(s, a); }
inline Value to_value(const std::pmr::string& s, alloc_t a = {}) { return Value(std::string_view(s), a); }
inline Value to_value(const char* s, alloc_t a = {}) { return Value(s, a); }
inline Value to_value(bool b, alloc_t a = {}) { return Value(b, a); }
inline Value to_value(std::int64_t i, alloc_t a = {}) { return Value(i, a); }
inline Value to_value(int i, alloc_t a = {}) { return Value(static_cast<std::int64_t>(i), a); }
inline Value to_value(double d, alloc_t a = {}) { return Value(d, a); }
inline Value to_value(DateTime t, alloc_t a = {}) { return Value(date_get_time(t), a); }
inline Value to_value(const Value& v, alloc_t a = {}) { return Value(v, a); }

// Nullish coalescing (the `??` operator in authored bodies).
template <class T, class U> T coalesce(const std::optional<T>& o, U&& def) { return o.has_value() ? *o : T(std::forward<U>(def)); }
inline Value coalesce(Value v, Value def) { return v.is_null() ? std::move(def) : std::move(v); }

// Approximate JS `typeof` for a Value (the frontend usually folds typeof into type-is).
inline std::string_view js_typeof(const Value& v) {
    if (v.is_string()) return "string";
    if (v.is_number()) return "number";
    if (v.is_bool()) return "boolean";
    if (v.is_null()) return "undefined";
    return "object";
}

// Thread an allocator into an std::optional<T> (which is not allocator-aware).
template <class T>
std::optional<T> alloc_opt(const std::optional<T>& o, const std::pmr::polymorphic_allocator<std::byte>& a) {
    if (!o) return std::nullopt;
    return std::optional<T>(std::in_place, *o, a);
}
template <class T>
std::optional<T> alloc_opt(std::optional<T>&& o, const std::pmr::polymorphic_allocator<std::byte>& a) {
    if (!o) return std::nullopt;
    return std::optional<T>(std::in_place, std::move(*o), a);
}

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
// specialization wins over the generic vector<E> below). from_value round-trips Value
// bytes; to_value is a documented gap — Value has no public bytes ctor and no schema
// serializes bytes today, so it yields null.
template <> struct value_traits<std::pmr::vector<std::byte>> {
    static std::pmr::vector<std::byte> from_value(const Value& v, alloc_t a) {
        return v.is_bytes() ? std::pmr::vector<std::byte>(v.as_bytes(), a) : std::pmr::vector<std::byte>(a);
    }
    static Value to_value(const std::pmr::vector<std::byte>&, alloc_t a) { return Value(nullptr, a); }
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
