#pragma once

// Intrinsic helpers for @keyma/runtime-cpp: the JS-semantics free functions the expression
// lowering emits as keyma::<op>(...) — string/array ops, Math.*, JS String()/Number() coercion,
// regex, dates (std::chrono, UTC, ms precision), base64, and type inspection — plus the shared
// alloc_t / DateTime aliases. Operates on keyma::Value; depends only on keyma/value.hpp.

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <format>
#include <limits>
#include <memory_resource>
#include <optional>
#include <regex>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#include <keyma/value.hpp>
#include <keyma/metadata.hpp>  // keyma::Field<T> (for the coalesce overload below)

namespace keyma {

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
// Enum-only so the coercion `to_string` overloads below (numbers/bool/strings/Value) own
// non-enum arguments without competing with this template (which would otherwise be an exact
// match for e.g. an integer and trip the static_assert). Each emitted enum still provides a
// full specialization `to_string<E>` that satisfies this constraint.
template <class E> requires std::is_enum_v<E>
std::string_view to_string(E) { static_assert(always_false<E>, "no keyma::to_string for this type"); return {}; }
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

// ─── Math (JS Math.* semantics) ───────────────────────────────────────────────
// floor/ceil/sqrt/pow/abs map onto <cmath>/comparison; round/trunc/sign reproduce JS
// semantics (half-up rounding, truncate-toward-zero, signed-zero) and pass NaN/±Infinity
// through unchanged. min/max are variadic over a common numeric type.
template <class T> double floor(T x) { return std::floor(static_cast<double>(x)); }
template <class T> double ceil(T x)  { return std::ceil(static_cast<double>(x)); }
template <class T> double sqrt(T x)  { return std::sqrt(static_cast<double>(x)); }
template <class A, class B> double pow(A a, B b) { return std::pow(static_cast<double>(a), static_cast<double>(b)); }
template <class T> auto abs(T x) { return x < T{} ? -x : x; }

template <class T> double math_round(T x) {
    const double d = static_cast<double>(x);
    if (std::isnan(d) || std::isinf(d)) return d;
    return std::floor(d + 0.5);
}
template <class T> double math_trunc(T x) {
    const double d = static_cast<double>(x);
    if (std::isnan(d) || std::isinf(d)) return d;
    return std::trunc(d);
}
template <class T> double math_sign(T x) {
    const double d = static_cast<double>(x);
    if (std::isnan(d)) return d;
    if (d > 0) return 1.0;
    if (d < 0) return -1.0;
    return d;  // ±0 → itself
}

template <class T, class... Ts>
std::common_type_t<T, Ts...> min(T a, Ts... rest) {
    std::common_type_t<T, Ts...> m = a;
    (((static_cast<std::common_type_t<T, Ts...>>(rest) < m) ? (m = rest) : m), ...);
    return m;
}
template <class T, class... Ts>
std::common_type_t<T, Ts...> max(T a, Ts... rest) {
    std::common_type_t<T, Ts...> m = a;
    (((static_cast<std::common_type_t<T, Ts...>>(rest) > m) ? (m = rest) : m), ...);
    return m;
}

// ─── Array map / some / every (JS Array.prototype.*) ──────────────────────────
// Arity-adaptive: a callback may take just the element or both element and index.
template <class T, class Fn>
auto map(const std::pmr::vector<T>& v, Fn fn, alloc_t a = {}) {
    auto call = [&fn](const T& e, std::int64_t i) {
        if constexpr (std::is_invocable_v<Fn, const T&, std::int64_t>) return fn(e, i);
        else return fn(e);
    };
    using R = std::remove_cvref_t<decltype(call(v.front(), std::int64_t{0}))>;
    std::pmr::vector<R> out(a);
    out.reserve(v.size());
    std::int64_t i = 0;
    for (const auto& e : v) { out.push_back(call(e, i)); ++i; }
    return out;
}
template <class T, class Pred>
bool some(const std::pmr::vector<T>& v, Pred pred) {
    std::int64_t i = 0;
    for (const auto& e : v) {
        const bool keep = [&] {
            if constexpr (std::is_invocable_v<Pred, const T&, std::int64_t>) return pred(e, i);
            else return pred(e);
        }();
        if (keep) return true;
        ++i;
    }
    return false;
}
template <class T, class Pred>
bool every(const std::pmr::vector<T>& v, Pred pred) {
    std::int64_t i = 0;
    for (const auto& e : v) {
        const bool keep = [&] {
            if constexpr (std::is_invocable_v<Pred, const T&, std::int64_t>) return pred(e, i);
            else return pred(e);
        }();
        if (!keep) return false;
        ++i;
    }
    return true;
}

// ─── JS coercion: String(x) / Number(x) ───────────────────────────────────────
// `to_string` reproduces JS `String(x)`: lowercase booleans, integral floats without a
// trailing `.0`, NaN/Infinity spellings, arrays comma-joined, objects → "[object Object]".
// Declared before the Value overload so its body can reach the numeric/string forms.
inline std::pmr::string to_string(bool b, alloc_t a = {}) { return std::pmr::string(b ? "true" : "false", a); }
template <class T> requires (std::is_arithmetic_v<T> && !std::is_same_v<T, bool>)
std::pmr::string to_string(T x, alloc_t a = {}) {
    if constexpr (std::is_floating_point_v<T>) {
        if (std::isnan(x)) return std::pmr::string("NaN", a);
        if (std::isinf(x)) return std::pmr::string(x < 0 ? "-Infinity" : "Infinity", a);
    }
    return std::pmr::string(std::format("{}", x), a);
}
inline std::pmr::string to_string(std::string_view s, alloc_t a = {}) { return std::pmr::string(s, a); }
inline std::pmr::string to_string(const std::pmr::string& s, alloc_t a = {}) { return std::pmr::string(s, a); }
inline std::pmr::string to_string(const char* s, alloc_t a = {}) { return std::pmr::string(s, a); }
inline std::pmr::string to_string(const Value& v, alloc_t a = {}) {
    if (v.is_string()) return std::pmr::string(v.as_string(), a);
    if (v.is_null())   return std::pmr::string("null", a);
    if (v.is_bool())   return to_string(v.as_bool(), a);
    if (v.is_int())    return to_string(v.as_int(), a);
    if (v.is_double()) return to_string(v.as_double(), a);
    if (v.is_array()) {
        std::pmr::string out(a);
        bool first = true;
        for (const auto& e : v.as_array()) {
            if (!first) out += ",";
            if (!e.is_null()) out += to_string(e, a);  // JS joins null/undefined as empty
            first = false;
        }
        return out;
    }
    if (v.is_object()) return std::pmr::string("[object Object]", a);
    return std::pmr::string(a);
}

// `to_number` reproduces JS `Number(x)`: empty/whitespace → 0, booleans → 0/1, numeric
// strings (incl. 0x/0o/0b and the `Infinity` spellings) → their value, anything else → NaN.
inline double to_number(bool b) { return b ? 1.0 : 0.0; }
template <class T> requires (std::is_arithmetic_v<T> && !std::is_same_v<T, bool>)
double to_number(T x) { return static_cast<double>(x); }
inline double to_number(std::string_view sv) {
    std::size_t b = 0, e = sv.size();
    while (b < e && std::isspace(static_cast<unsigned char>(sv[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(sv[e - 1]))) --e;
    if (b == e) return 0.0;  // empty / whitespace-only → 0
    const std::string s(sv.substr(b, e - b));
    if (s.size() > 2 && s[0] == '0') {  // JS hex/octal/binary integer literals
        int base = 0;
        switch (s[1]) {
            case 'x': case 'X': base = 16; break;
            case 'o': case 'O': base = 8;  break;
            case 'b': case 'B': base = 2;  break;
            default: break;
        }
        if (base != 0) {
            char* end = nullptr;
            const unsigned long long val = std::strtoull(s.c_str() + 2, &end, base);
            return (end != nullptr && *end == '\0') ? static_cast<double>(val) : std::numeric_limits<double>::quiet_NaN();
        }
    }
    if (s == "Infinity" || s == "+Infinity") return std::numeric_limits<double>::infinity();
    if (s == "-Infinity") return -std::numeric_limits<double>::infinity();
    char* end = nullptr;
    const double d = std::strtod(s.c_str(), &end);
    return (end != nullptr && *end == '\0') ? d : std::numeric_limits<double>::quiet_NaN();
}
inline double to_number(const std::pmr::string& s) { return to_number(std::string_view(s)); }
inline double to_number(const char* s) { return to_number(std::string_view(s)); }
inline double to_number(const Value& v) {
    if (v.is_number()) return v.as_double();
    if (v.is_bool())   return v.as_bool() ? 1.0 : 0.0;
    if (v.is_null())   return 0.0;
    if (v.is_string()) return to_number(std::string_view(v.as_string()));
    return std::numeric_limits<double>::quiet_NaN();
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

// ─── Base64 (RFC 4648, alphabet A-Za-z0-9+/, `=` padding) ─────────────────────
// The canonical wire encoding for `bytes` fields, byte-compatible with the JS runtime's
// base64.ts and the Python runtime's `base64` module. Defined here (not json.hpp) so the
// value_traits<vector<byte>> specialization below can reach it; json.hpp reuses it on the
// JSON write path.
namespace detail {
inline constexpr char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

inline std::pmr::string base64_encode(std::span<const std::byte> data, alloc_t a) {
    std::pmr::string out(a);
    const std::size_t n = data.size();
    out.reserve(((n + 2) / 3) * 4);
    auto at = [&](std::size_t k) { return static_cast<unsigned>(std::to_integer<unsigned char>(data[k])); };
    std::size_t i = 0;
    for (; i + 3 <= n; i += 3) {
        unsigned v = (at(i) << 16) | (at(i + 1) << 8) | at(i + 2);
        out.push_back(kB64[(v >> 18) & 63]); out.push_back(kB64[(v >> 12) & 63]);
        out.push_back(kB64[(v >> 6) & 63]);  out.push_back(kB64[v & 63]);
    }
    if (n - i == 1) {
        unsigned v = at(i) << 16;
        out.push_back(kB64[(v >> 18) & 63]); out.push_back(kB64[(v >> 12) & 63]); out += "==";
    } else if (n - i == 2) {
        unsigned v = (at(i) << 16) | (at(i + 1) << 8);
        out.push_back(kB64[(v >> 18) & 63]); out.push_back(kB64[(v >> 12) & 63]);
        out.push_back(kB64[(v >> 6) & 63]);  out += "=";
    }
    return out;
}

// Decode a base64 string into raw bytes. Padding ('='), whitespace, and any stray
// non-alphabet character are skipped; trailing sub-byte bits are discarded (best-effort,
// matching the JS/Python decoders' leniency).
inline std::pmr::vector<std::byte> base64_decode(std::string_view s, alloc_t a) {
    std::pmr::vector<std::byte> out(a);
    out.reserve((s.size() / 4) * 3);
    unsigned acc = 0;
    int bits = 0;
    for (char c : s) {
        int d;
        if (c >= 'A' && c <= 'Z') d = c - 'A';
        else if (c >= 'a' && c <= 'z') d = c - 'a' + 26;
        else if (c >= '0' && c <= '9') d = c - '0' + 52;
        else if (c == '+') d = 62;
        else if (c == '/') d = 63;
        else continue;  // '=', whitespace, or stray char
        acc = (acc << 6) | static_cast<unsigned>(d);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<std::byte>((acc >> bits) & 0xFFu));
        }
    }
    return out;
}
}  // namespace detail

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

// Wrap a concrete value into a Value (used by formatters/defaults).
inline Value to_value(std::string_view s, alloc_t a = {}) { return Value(s, a); }
inline Value to_value(const std::pmr::string& s, alloc_t a = {}) { return Value(std::string_view(s), a); }
inline Value to_value(const char* s, alloc_t a = {}) { return Value(s, a); }
inline Value to_value(bool b, alloc_t a = {}) { return Value(b, a); }
inline Value to_value(std::int64_t i, alloc_t a = {}) { return Value(i, a); }
inline Value to_value(int i, alloc_t a = {}) { return Value(static_cast<std::int64_t>(i), a); }
// Unsigned wide ints (Unsigned<32>/<64> members): unsigned int/long/long long have no
// integral-promotion target, so a deduced keyma::to_value(u, a) — as emitted per-field by
// the C++ backend's struct serializer — would be ambiguous across the int/int64_t/double
// overloads. These exact-match overloads disambiguate. (uint8/uint16 already promote to
// int, and signed sized ints / float resolve via the int / double overloads.)
inline Value to_value(unsigned i, alloc_t a = {}) { return Value(static_cast<std::int64_t>(i), a); }
inline Value to_value(unsigned long i, alloc_t a = {}) { return Value(static_cast<std::int64_t>(i), a); }
inline Value to_value(unsigned long long i, alloc_t a = {}) { return Value(static_cast<std::int64_t>(i), a); }
inline Value to_value(double d, alloc_t a = {}) { return Value(d, a); }
inline Value to_value(DateTime t, alloc_t a = {}) { return Value(date_get_time(t), a); }
inline Value to_value(const Value& v, alloc_t a = {}) { return Value(v, a); }

// Nullish coalescing (the `??` operator in authored bodies).
template <class T, class U> T coalesce(const std::optional<T>& o, U&& def) { return o.has_value() ? *o : T(std::forward<U>(def)); }
inline Value coalesce(Value v, Value def) { return v.is_null() ? std::move(def) : std::move(v); }
// Two-axis `keyma::Field<T>` (presence × nullability): fill the default only when the field is
// ABSENT (a present-null Field keeps its null). For a synthesized `applyDefaults()` on a Field.
template <class T, class U> Field<T> coalesce(Field<T> f, U&& def) {
    if (f.is_absent()) return Field<T>{true, std::optional<T>(T(std::forward<U>(def)))};
    return f;
}

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
