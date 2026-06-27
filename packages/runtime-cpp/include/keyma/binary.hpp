#pragma once

// Binary wire codec for @keyma/runtime-cpp — the C++ mirror of runtime-js `binary.ts`
// (see packages/runtime-js/binary-format.md for the canonical spec). It loops
// `ClassMetadata.fields` exactly as serialize.hpp does (the metadata-driven path, NOT the
// code-driven value_traits path, so all three runtimes stay byte-aligned), emitting a
// protobuf-like tag-keyed TLV stream. `bytes` go raw on the wire (the keyma::Value carries
// them as a base64 string — the canonical Value repr — so encode base64-decodes once;
// decode base64-encodes back, keeping the Value repr consistent). Field identity on the
// wire is `FieldMeta.tag` when non-zero, else the 1-based declaration index.

#include <keyma/runtime.hpp>
#include <keyma/serialize.hpp>  // SerializeTarget, resolve_ref

#include <cstdint>
#include <cstring>
#include <memory_resource>
#include <span>
#include <string_view>
#include <vector>

namespace keyma {

using ByteBuf = std::pmr::vector<std::byte>;

namespace binary_detail {

constexpr std::uint8_t WIRE_VARINT = 0;
constexpr std::uint8_t WIRE_FIXED64 = 1;
constexpr std::uint8_t WIRE_LENGTH = 2;
constexpr std::uint8_t WIRE_NULL = 3;
constexpr std::uint8_t WIRE_FIXED32 = 4;

// Generic self-describing kinds for `json` fields.
constexpr std::uint8_t JSON_NULL = 0, JSON_FALSE = 1, JSON_TRUE = 2, JSON_INT = 3, JSON_FLOAT = 4,
                       JSON_STRING = 5, JSON_ARRAY = 6, JSON_OBJECT = 7, JSON_BYTES = 8;

// Flattened per-position type detail — the same nested distinctions runtime-js reads off
// `field.type`. Built from a FieldMeta (or, for an array element, from the element slot).
struct TypeInfo {
    TypeTag tag;
    TypeTag element;     // array element TypeTag (when tag == Array)
    int bits;            // Number: 32 ⇒ float32
    bool is_unsigned;    // Integer: plain vs zigzag
    TypeTag id_type;     // Reference: bare-id wire kind
    bool id_unsigned;
    std::string_view target;  // embedded / reference target schema name
};

inline TypeInfo field_info(const FieldMeta& f) {
    return TypeInfo{f.type, f.element, f.bits, f.is_unsigned, f.id_type, f.id_unsigned, f.target};
}
inline TypeInfo element_of(const TypeInfo& t) {
    return TypeInfo{t.element, TypeTag::String, t.bits, t.is_unsigned, t.id_type, t.id_unsigned, t.target};
}

// ── Primitive writers ──

inline void put(ByteBuf& out, std::uint8_t b) { out.push_back(static_cast<std::byte>(b)); }

inline void write_varint(ByteBuf& out, std::uint64_t v) {
    while (v >= 0x80) {
        put(out, static_cast<std::uint8_t>((v & 0x7F) | 0x80));
        v >>= 7;
    }
    put(out, static_cast<std::uint8_t>(v));
}

inline std::uint64_t zigzag_encode(std::int64_t n) {
    return (static_cast<std::uint64_t>(n) << 1) ^ static_cast<std::uint64_t>(n >> 63);
}
inline std::int64_t zigzag_decode(std::uint64_t u) {
    return static_cast<std::int64_t>((u >> 1) ^ (~(u & 1ULL) + 1ULL));
}

inline void write_f64(ByteBuf& out, double d) {
    std::uint64_t bits;
    std::memcpy(&bits, &d, 8);
    for (int i = 0; i < 8; ++i) put(out, static_cast<std::uint8_t>(bits >> (i * 8)));
}
inline void write_f32(ByteBuf& out, float f) {
    std::uint32_t bits;
    std::memcpy(&bits, &f, 4);
    for (int i = 0; i < 4; ++i) put(out, static_cast<std::uint8_t>(bits >> (i * 8)));
}

inline void write_key(ByteBuf& out, std::uint32_t tag, std::uint8_t wt) {
    write_varint(out, static_cast<std::uint64_t>(tag) * 8 + wt);
}
inline void write_len_str(ByteBuf& out, std::string_view s) {
    write_varint(out, s.size());
    for (char c : s) put(out, static_cast<std::uint8_t>(c));
}
inline void write_len_raw(ByteBuf& out, std::span<const std::byte> b) {
    write_varint(out, b.size());
    out.insert(out.end(), b.begin(), b.end());
}

// ── Encoding ──

inline std::uint8_t wiretype_of(const TypeInfo& t) {
    switch (t.tag) {
        case TypeTag::Boolean:
        case TypeTag::Integer:
        case TypeTag::BigInt:
        case TypeTag::DateTime:
            return WIRE_VARINT;
        case TypeTag::Number:
            return t.bits == 32 ? WIRE_FIXED32 : WIRE_FIXED64;
        case TypeTag::Reference:
            return t.id_type == TypeTag::Integer ? WIRE_VARINT : WIRE_LENGTH;
        default:
            return WIRE_LENGTH;
    }
}

inline void encode_record(ByteBuf& out, const ClassMetadata& schema, const Value& value, SerializeTarget target, alloc_t a);

inline void encode_json(ByteBuf& out, const Value& v) {
    if (v.is_null()) { put(out, JSON_NULL); return; }
    if (v.is_bool()) { put(out, v.as_bool() ? JSON_TRUE : JSON_FALSE); return; }
    if (v.is_int()) { put(out, JSON_INT); write_varint(out, zigzag_encode(v.as_int())); return; }
    if (v.is_double()) { put(out, JSON_FLOAT); write_f64(out, v.as_double()); return; }
    if (v.is_string()) { put(out, JSON_STRING); write_len_str(out, v.as_string()); return; }
    if (v.is_bytes()) {
        put(out, JSON_BYTES);
        write_len_raw(out, std::span<const std::byte>(v.as_bytes().data(), v.as_bytes().size()));
        return;
    }
    if (v.is_array()) {
        put(out, JSON_ARRAY);
        write_varint(out, v.as_array().size());
        for (const Value& e : v.as_array()) encode_json(out, e);
        return;
    }
    if (v.is_object()) {
        put(out, JSON_OBJECT);
        write_varint(out, v.as_object().size());
        for (const Value::Member& m : v.as_object()) {
            write_len_str(out, m.key);
            encode_json(out, m.value);
        }
        return;
    }
    put(out, JSON_NULL);
}

inline void encode_payload(ByteBuf& out, const TypeInfo& t, const Value& v, const ClassMetadata& schema, SerializeTarget target, alloc_t a) {
    switch (t.tag) {
        case TypeTag::Boolean:
            write_varint(out, v.is_bool() && v.as_bool() ? 1 : 0);
            return;
        case TypeTag::Integer:
            write_varint(out, t.is_unsigned ? static_cast<std::uint64_t>(v.as_int()) : zigzag_encode(v.as_int()));
            return;
        case TypeTag::BigInt:
            write_varint(out, zigzag_encode(v.as_int()));
            return;
        case TypeTag::DateTime:
            write_varint(out, zigzag_encode(v.as_int()));  // Value carries epoch-ms int64
            return;
        case TypeTag::Number:
            if (t.bits == 32) write_f32(out, static_cast<float>(v.as_double()));
            else write_f64(out, v.as_double());
            return;
        case TypeTag::String:
        case TypeTag::Id:
        case TypeTag::Enum:
        case TypeTag::Date:
        case TypeTag::Time:
        case TypeTag::Decimal:
            write_len_str(out, v.is_string() ? std::string_view(v.as_string()) : std::string_view{});
            return;
        case TypeTag::Bytes: {
            if (v.is_bytes()) {
                write_len_raw(out, std::span<const std::byte>(v.as_bytes().data(), v.as_bytes().size()));
            } else if (v.is_string()) {
                ByteBuf raw = detail::base64_decode(std::string_view(v.as_string()), a);
                write_len_raw(out, std::span<const std::byte>(raw.data(), raw.size()));
            } else {
                write_varint(out, 0);
            }
            return;
        }
        case TypeTag::Embedded: {
            ByteBuf body(a);
            const ClassMetadata* sub = resolve_ref(schema, t.target);
            if (sub != nullptr && v.is_object()) encode_record(body, *sub, v, target, a);
            write_len_raw(out, std::span<const std::byte>(body.data(), body.size()));
            return;
        }
        case TypeTag::Reference: {
            const Value* idp = v.is_object() ? v.find("id") : &v;
            Value none(a);
            const Value& id = idp != nullptr ? *idp : none;
            if (t.id_type == TypeTag::Integer) {
                write_varint(out, t.id_unsigned ? static_cast<std::uint64_t>(id.as_int()) : zigzag_encode(id.as_int()));
            } else {
                write_len_str(out, id.is_string() ? std::string_view(id.as_string()) : std::string_view{});
            }
            return;
        }
        case TypeTag::Array: {
            ByteBuf body(a);
            const Value::Array* arr = v.is_array() ? &v.as_array() : nullptr;
            write_varint(body, arr != nullptr ? arr->size() : 0);
            if (arr != nullptr) {
                TypeInfo elem = element_of(t);
                std::uint8_t ewt = wiretype_of(elem);
                for (const Value& el : *arr) {
                    if (el.is_null()) { put(body, WIRE_NULL); continue; }
                    put(body, ewt);
                    encode_payload(body, elem, el, schema, target, a);
                }
            }
            write_len_raw(out, std::span<const std::byte>(body.data(), body.size()));
            return;
        }
        case TypeTag::Json: {
            ByteBuf body(a);
            encode_json(body, v);
            write_len_raw(out, std::span<const std::byte>(body.data(), body.size()));
            return;
        }
        default:
            write_len_str(out, v.is_string() ? std::string_view(v.as_string()) : std::string_view{});
    }
}

inline void encode_record(ByteBuf& out, const ClassMetadata& schema, const Value& value, SerializeTarget target, alloc_t a) {
    // Real inheritance: walk the base chain. Records are tag-keyed (chain-unique tags assigned by
    // the compiler), so emit order is irrelevant. The 1-based `idx` fallback is reached only when
    // tags are absent — which never happens on the configured binary path — but it runs CHAIN-GLOBAL
    // (idx continues across the base chain, not restarting per schema) so an untagged child field
    // can never collide with an untagged inherited one; find_by_tag mirrors this exactly.
    std::uint32_t idx = 0;
    for (const ClassMetadata* s = &schema; s != nullptr; s = (s->base != nullptr ? &s->base() : nullptr)) {
        for (const FieldMeta& f : s->fields) {
            ++idx;  // 1-based declaration index across the whole chain (child-first)
            if (target == SerializeTarget::Client && f.visibility == Visibility::Private) continue;
            if (target == SerializeTarget::Database && f.ephemeral) continue;
            const Value* present = value.find(f.name);
            if (present == nullptr) continue;
            std::uint32_t tag = f.tag != 0 ? f.tag : idx;
            if (present->is_null()) {
                write_key(out, tag, WIRE_NULL);
                continue;
            }
            TypeInfo t = field_info(f);
            write_key(out, tag, wiretype_of(t));
            encode_payload(out, t, *present, schema, target, a);  // top schema → resolve_ref walks the chain
        }
    }
}

// ── Decoding ──

struct Reader {
    std::span<const std::byte> buf;
    std::size_t pos;
    std::size_t end;
};

inline std::uint64_t read_varint(Reader& r) {
    std::uint64_t result = 0;
    int shift = 0;
    while (true) {
        std::uint8_t b = std::to_integer<std::uint8_t>(r.buf[r.pos++]);
        result |= static_cast<std::uint64_t>(b & 0x7F) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
    }
    return result;
}
inline double read_f64(const Reader& r, std::size_t pos) {
    std::uint64_t bits = 0;
    for (int i = 0; i < 8; ++i) bits |= static_cast<std::uint64_t>(std::to_integer<std::uint8_t>(r.buf[pos + i])) << (i * 8);
    double d;
    std::memcpy(&d, &bits, 8);
    return d;
}
inline float read_f32(const Reader& r, std::size_t pos) {
    std::uint32_t bits = 0;
    for (int i = 0; i < 4; ++i) bits |= static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(r.buf[pos + i])) << (i * 8);
    float f;
    std::memcpy(&f, &bits, 4);
    return f;
}
inline std::string_view read_len_str(Reader& r) {
    std::uint64_t n = read_varint(r);
    const char* p = reinterpret_cast<const char*>(r.buf.data() + r.pos);
    r.pos += n;
    return std::string_view(p, n);
}
inline Reader read_len_window(Reader& r) {
    std::uint64_t n = read_varint(r);
    std::size_t start = r.pos;
    r.pos += n;
    return Reader{r.buf, start, start + n};
}
inline void skip_value(Reader& r, std::uint8_t wt) {
    switch (wt) {
        case WIRE_VARINT: read_varint(r); return;
        case WIRE_FIXED64: r.pos += 8; return;
        case WIRE_FIXED32: r.pos += 4; return;
        case WIRE_LENGTH: { std::uint64_t n = read_varint(r); r.pos += n; return; }
        case WIRE_NULL: return;
        default: return;
    }
}

inline const FieldMeta* find_by_tag(const ClassMetadata& schema, std::uint32_t tag) {
    // Walk the base chain (own + inherited); the chain-global `idx` fallback mirrors encode_record
    // (idx continues across the chain, never restarting per schema) so untagged fields stay unique.
    std::uint32_t idx = 0;
    for (const ClassMetadata* s = &schema; s != nullptr; s = (s->base != nullptr ? &s->base() : nullptr)) {
        for (const FieldMeta& f : s->fields) {
            ++idx;
            std::uint32_t ft = f.tag != 0 ? f.tag : idx;
            if (ft == tag) return &f;
        }
    }
    return nullptr;
}

inline Value decode_record(const ClassMetadata& schema, Reader& r, alloc_t a);

inline Value decode_json(Reader& r, alloc_t a) {
    std::uint8_t kind = std::to_integer<std::uint8_t>(r.buf[r.pos++]);
    switch (kind) {
        case JSON_NULL: return Value(nullptr, a);
        case JSON_FALSE: return Value(false, a);
        case JSON_TRUE: return Value(true, a);
        case JSON_INT: return Value(zigzag_decode(read_varint(r)), a);
        case JSON_FLOAT: { double d = read_f64(r, r.pos); r.pos += 8; return Value(d, a); }
        case JSON_STRING: return Value(read_len_str(r), a);
        case JSON_BYTES: {
            std::uint64_t n = read_varint(r);
            std::pmr::string b64 = detail::base64_encode(std::span<const std::byte>(r.buf.data() + r.pos, n), a);
            r.pos += n;
            return Value(std::string_view(b64), a);
        }
        case JSON_ARRAY: {
            std::uint64_t count = read_varint(r);
            Value arr = Value::array(a);
            for (std::uint64_t i = 0; i < count; ++i) arr.push(decode_json(r, a));
            return arr;
        }
        case JSON_OBJECT: {
            std::uint64_t count = read_varint(r);
            Value obj = Value::object(a);
            for (std::uint64_t i = 0; i < count; ++i) {
                std::string_view k = read_len_str(r);
                obj.set(k, decode_json(r, a));
            }
            return obj;
        }
        default: return Value(nullptr, a);
    }
}

inline Value decode_value(Reader& r, const TypeInfo& t, std::uint8_t wt, const ClassMetadata& schema, alloc_t a) {
    switch (t.tag) {
        case TypeTag::Boolean:
            return Value(read_varint(r) != 0, a);
        case TypeTag::Integer: {
            std::uint64_t u = read_varint(r);
            return Value(t.is_unsigned ? static_cast<std::int64_t>(u) : zigzag_decode(u), a);
        }
        case TypeTag::BigInt:
            return Value(zigzag_decode(read_varint(r)), a);
        case TypeTag::DateTime:
            return Value(zigzag_decode(read_varint(r)), a);  // epoch-ms int64
        case TypeTag::Number: {
            double d;
            if (wt == WIRE_FIXED32) { d = static_cast<double>(read_f32(r, r.pos)); r.pos += 4; }
            else { d = read_f64(r, r.pos); r.pos += 8; }
            return Value(d, a);
        }
        case TypeTag::String:
        case TypeTag::Id:
        case TypeTag::Enum:
        case TypeTag::Date:
        case TypeTag::Time:
        case TypeTag::Decimal:
            return Value(read_len_str(r), a);
        case TypeTag::Bytes: {
            std::uint64_t n = read_varint(r);
            std::pmr::string b64 = detail::base64_encode(std::span<const std::byte>(r.buf.data() + r.pos, n), a);
            r.pos += n;
            return Value(std::string_view(b64), a);
        }
        case TypeTag::Embedded: {
            Reader inner = read_len_window(r);
            const ClassMetadata* sub = resolve_ref(schema, t.target);
            if (sub == nullptr) return Value::object(a);
            return decode_record(*sub, inner, a);
        }
        case TypeTag::Reference: {
            if (t.id_type == TypeTag::Integer) {
                std::uint64_t u = read_varint(r);
                return Value(t.id_unsigned ? static_cast<std::int64_t>(u) : zigzag_decode(u), a);
            }
            return Value(read_len_str(r), a);
        }
        case TypeTag::Array: {
            Reader inner = read_len_window(r);
            std::uint64_t count = read_varint(inner);
            Value arr = Value::array(a);
            TypeInfo elem = element_of(t);
            for (std::uint64_t i = 0; i < count; ++i) {
                std::uint8_t ewt = std::to_integer<std::uint8_t>(inner.buf[inner.pos++]);
                if (ewt == WIRE_NULL) arr.push(Value(nullptr, a));
                else arr.push(decode_value(inner, elem, ewt, schema, a));
            }
            return arr;
        }
        case TypeTag::Json: {
            Reader inner = read_len_window(r);
            return decode_json(inner, a);
        }
        default:
            skip_value(r, wt);
            return Value(nullptr, a);
    }
}

inline Value decode_record(const ClassMetadata& schema, Reader& r, alloc_t a) {
    Value out = Value::object(a);
    while (r.pos < r.end) {
        std::uint64_t key = read_varint(r);
        std::uint32_t tag = static_cast<std::uint32_t>(key >> 3);
        std::uint8_t wt = static_cast<std::uint8_t>(key & 7);
        const FieldMeta* f = find_by_tag(schema, tag);
        if (f == nullptr) { skip_value(r, wt); continue; }
        if (wt == WIRE_NULL) { out.set(f->name, Value(nullptr, a)); continue; }
        out.set(f->name, decode_value(r, field_info(*f), wt, schema, a));
    }
    return out;
}

}  // namespace binary_detail

// ── Public API ──

inline ByteBuf encode_binary(const ClassMetadata& schema, const Value& value, SerializeTarget target, alloc_t a) {
    ByteBuf out(a);
    binary_detail::encode_record(out, schema, value, target, a);
    return out;
}

inline Value decode_binary(const ClassMetadata& schema, std::span<const std::byte> bytes, alloc_t a) {
    binary_detail::Reader r{bytes, 0, bytes.size()};
    return binary_detail::decode_record(schema, r, a);
}

}  // namespace keyma
