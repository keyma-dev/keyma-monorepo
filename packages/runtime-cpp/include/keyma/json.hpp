#pragma once

// JSON (de)serializer for keyma::Value (@keyma/runtime-cpp). Runtime-only — keyma::Value
// is std::pmr-based and cannot be constexpr-constructed, so there is no compile-time
// surface. Recursive-descent parse to a Value; allocator-threaded throughout.
//
//   keyma::Value          json_parse(std::string_view, alloc_t);
//   std::pmr::string      json_stringify(const Value&, alloc_t);
//   std::pmr::string      json_stringify_pretty(const Value&, alloc_t, int indent = 2);
//
// Number rule: an integral token (no '.'/'e') that fits in int64 parses to int64,
// otherwise to double — preserving keyma::Value's int/double distinction. Strings carry
// full JSON escape handling (incl. \uXXXX surrogate pairs → UTF-8). Bytes serialize as a
// base64 string (JSON has no bytes type; parse yields a String, as on every runtime).

#include <keyma/errors.hpp>

#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <format>
#include <span>
#include <string>
#include <string_view>
#include <variant>

namespace keyma {
namespace json_detail {

inline void append_utf8(std::pmr::string& out, char32_t cp) {
    if (cp <= 0x7F) {
        out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

inline void escape_into(std::pmr::string& out, std::string_view s) {
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
                    out += buf;
                } else {
                    out.push_back(c);  // valid UTF-8 ≥ 0x20 passes through verbatim
                }
        }
    }
}

inline void write_double(std::pmr::string& out, double d) {
    if (!std::isfinite(d)) { out += "null"; return; }  // JSON has no nan/inf
    char buf[32];
    auto [ptr, ec] = std::to_chars(buf, buf + sizeof(buf), d);
    std::string_view s(buf, static_cast<std::size_t>(ptr - buf));
    out.append(s);
    // Ensure a '.'/'e' so a re-parse yields a double, not an int64 (type-stable round-trip).
    if (s.find('.') == std::string_view::npos && s.find('e') == std::string_view::npos &&
        s.find('E') == std::string_view::npos)
        out += ".0";
}

// base64_encode lives in keyma::detail (runtime.hpp) so value_traits<vector<byte>> can
// reach it; the JSON writer below reuses it for the Bytes variant.

// ── Writer ──
struct Writer {
    std::pmr::string& out;
    alloc_t a;
    bool pretty;
    int indent_unit;

    void newline_indent(int depth) {
        if (!pretty) return;
        out.push_back('\n');
        out.append(static_cast<std::size_t>(depth) * static_cast<std::size_t>(indent_unit), ' ');
    }

    void write(const Value& v, int depth) {
        std::visit([&](const auto& x) {
            using T = std::decay_t<decltype(x)>;
            if constexpr (std::is_same_v<T, std::monostate>) {
                out += "null";
            } else if constexpr (std::is_same_v<T, bool>) {
                out += x ? "true" : "false";
            } else if constexpr (std::is_same_v<T, std::int64_t>) {
                char b[24];
                auto [p, ec] = std::to_chars(b, b + sizeof(b), x);
                out.append(b, static_cast<std::size_t>(p - b));
            } else if constexpr (std::is_same_v<T, double>) {
                write_double(out, x);
            } else if constexpr (std::is_same_v<T, Value::String>) {
                out.push_back('"'); escape_into(out, x); out.push_back('"');
            } else if constexpr (std::is_same_v<T, Value::Array>) {
                if (x.empty()) { out += "[]"; return; }
                out.push_back('[');
                for (std::size_t k = 0; k < x.size(); ++k) {
                    if (k) out.push_back(',');
                    newline_indent(depth + 1);
                    write(x[k], depth + 1);
                }
                newline_indent(depth); out.push_back(']');
            } else if constexpr (std::is_same_v<T, Value::Object>) {
                if (x.empty()) { out += "{}"; return; }
                out.push_back('{');
                for (std::size_t k = 0; k < x.size(); ++k) {
                    if (k) out.push_back(',');
                    newline_indent(depth + 1);
                    out.push_back('"'); escape_into(out, x[k].key); out.push_back('"');
                    out.push_back(':'); if (pretty) out.push_back(' ');
                    write(x[k].value, depth + 1);
                }
                newline_indent(depth); out.push_back('}');
            } else if constexpr (std::is_same_v<T, Value::Bytes>) {
                out.push_back('"');
                out += keyma::detail::base64_encode(std::span<const std::byte>(x.data(), x.size()), a);
                out.push_back('"');
            }
        }, v.storage());
    }
};

// ── Parser ──
struct Parser {
    std::string_view s;
    std::size_t i;
    alloc_t a;
    int depth;
    static constexpr int kMaxDepth = 200;

    char peek() const { return i < s.size() ? s[i] : '\0'; }
    void skip_ws() {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
    }
    [[noreturn]] void fail(std::string_view why) const {
        throw KeymaRuntimeError(std::string_view("PARSE_ERROR"),
                                std::format("JSON parse error at offset {}: {}", i, why));
    }
    void enter() { if (++depth > kMaxDepth) fail("nesting too deep"); }
    void leave() { --depth; }

    unsigned hex4() {
        unsigned v = 0;
        for (int k = 0; k < 4; ++k) {
            if (i >= s.size()) fail("unexpected end in \\u escape");
            char c = s[i++];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
            else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
            else fail("invalid hex digit in \\u escape");
        }
        return v;
    }

    std::pmr::string parse_raw_string() {
        if (peek() != '"') fail("expected string");
        ++i;
        std::pmr::string out(a);
        while (true) {
            if (i >= s.size()) fail("unterminated string");
            char c = s[i++];
            if (c == '"') break;
            if (c == '\\') {
                if (i >= s.size()) fail("unterminated escape");
                char e = s[i++];
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        unsigned cp = hex4();
                        if (cp >= 0xD800 && cp <= 0xDBFF) {  // high surrogate
                            if (i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') {
                                i += 2;
                                unsigned lo = hex4();
                                if (lo < 0xDC00 || lo > 0xDFFF) fail("invalid low surrogate");
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            } else {
                                fail("expected low surrogate");
                            }
                        } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                            fail("unexpected low surrogate");
                        }
                        append_utf8(out, static_cast<char32_t>(cp));
                        break;
                    }
                    default: fail("invalid escape");
                }
            } else if (static_cast<unsigned char>(c) < 0x20) {
                fail("raw control character in string");
            } else {
                out.push_back(c);
            }
        }
        return out;
    }

    Value parse_number() {
        std::size_t start = i;
        if (peek() == '-') ++i;
        while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
        bool is_float = false;
        if (peek() == '.') { is_float = true; ++i; while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i; }
        if (peek() == 'e' || peek() == 'E') {
            is_float = true; ++i;
            if (peek() == '+' || peek() == '-') ++i;
            while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
        }
        std::string_view tok = s.substr(start, i - start);
        if (tok.empty() || tok == "-") fail("invalid number");
        if (!is_float) {
            std::int64_t out{};
            auto [ptr, ec] = std::from_chars(tok.data(), tok.data() + tok.size(), out);
            if (ec == std::errc{} && ptr == tok.data() + tok.size()) return Value(out, a);
            // integer literal that overflows int64 → keep as double
        }
        double d{};
        auto [ptr, ec] = std::from_chars(tok.data(), tok.data() + tok.size(), d);
        if (ec != std::errc{} || ptr != tok.data() + tok.size()) fail("invalid number");
        return Value(d, a);
    }

    Value parse_object() {
        enter();
        ++i;  // '{'
        Value obj = Value::object(a);
        skip_ws();
        if (peek() == '}') { ++i; leave(); return obj; }
        while (true) {
            skip_ws();
            std::pmr::string key = parse_raw_string();
            skip_ws();
            if (peek() != ':') fail("expected ':'");
            ++i;
            Value val = parse_value();
            obj.set(std::string_view(key), std::move(val));
            skip_ws();
            char c = peek();
            if (c == ',') { ++i; continue; }
            if (c == '}') { ++i; break; }
            fail("expected ',' or '}'");
        }
        leave();
        return obj;
    }

    Value parse_array() {
        enter();
        ++i;  // '['
        Value arr = Value::array(a);
        skip_ws();
        if (peek() == ']') { ++i; leave(); return arr; }
        while (true) {
            arr.push(parse_value());
            skip_ws();
            char c = peek();
            if (c == ',') { ++i; continue; }
            if (c == ']') { ++i; break; }
            fail("expected ',' or ']'");
        }
        leave();
        return arr;
    }

    Value parse_value() {
        skip_ws();
        if (i >= s.size()) fail("unexpected end of input");
        char c = s[i];
        switch (c) {
            case '{': return parse_object();
            case '[': return parse_array();
            case '"': { std::pmr::string str = parse_raw_string(); return Value(std::string_view(str), a); }
            case 't': if (s.substr(i, 4) == "true")  { i += 4; return Value(true, a); }  fail("invalid literal");
            case 'f': if (s.substr(i, 5) == "false") { i += 5; return Value(false, a); } fail("invalid literal");
            case 'n': if (s.substr(i, 4) == "null")  { i += 4; return Value(nullptr, a); } fail("invalid literal");
            default:
                if (c == '-' || (c >= '0' && c <= '9')) return parse_number();
                fail("unexpected character");
        }
    }
};

}  // namespace json_detail

inline Value json_parse(std::string_view src, alloc_t a) {
    json_detail::Parser p{src, 0, a, 0};
    p.skip_ws();
    Value v = p.parse_value();
    p.skip_ws();
    if (p.i != src.size()) p.fail("trailing characters after JSON value");
    return v;
}

inline std::pmr::string json_stringify(const Value& v, alloc_t a) {
    std::pmr::string out(a);
    json_detail::Writer{out, a, false, 0}.write(v, 0);
    return out;
}

inline std::pmr::string json_stringify_pretty(const Value& v, alloc_t a, int indent = 2) {
    std::pmr::string out(a);
    json_detail::Writer{out, a, true, indent}.write(v, 0);
    return out;
}

}  // namespace keyma
