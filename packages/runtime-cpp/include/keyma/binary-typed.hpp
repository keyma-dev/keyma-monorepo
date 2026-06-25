#pragma once

// Typed binary codec for @keyma/runtime-cpp — the struct↔bytes counterpart of the
// value_traits<T> JSON layer (runtime.hpp) and the byte-for-byte twin of the dynamic
// metadata-driven codec (binary.hpp). keyma::to_binary<T>(x, a) / from_binary<T>(bytes, a)
// serialize a generated struct DIRECTLY to/from the wire, with no intermediate
// keyma::Value object graph and no per-field heap allocation.
//
// It is wire-identical to binary.hpp by construction: every leaf below emits bytes through
// the SAME binary_detail:: primitives the dynamic codec calls (write_varint, zigzag_*,
// write_f32/64, write_len_str/raw, encode_json, …). The dynamic codec remains the parity
// oracle (and the path for genuine dynamic-Value use); this header is the allocation-free
// fast path for typed records. See packages/runtime-js/binary-format.md for the spec.
//
// Two-tier split mirrors binary.hpp's encode_record (framing) vs encode_payload (payload):
//   * Leaf binary_traits<E> (here) — payload only; each publishes `wiretype`.
//   * Codegen'd struct binary_traits<T> (emitted by the C++ backend) — per-field key +
//     presence/null framing + tag-keyed decode dispatch, delegating payload to the leaves.

#include <keyma/binary.hpp>

#include <cstdint>
#include <memory>
#include <memory_resource>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace keyma {

// Primary: declared, never defined. A type with no specialization fails loudly with a
// clean incomplete-type error at the use site (mirrors value_traits's discipline, which is
// also what lets codegen forward-declare struct specializations to compile reference cycles).
template <class T> struct binary_traits;

// ── Generic entry points (mirror from_value<T> / to_value<T>) ──
// Whole-record bytes for a struct T. encode_record/decode_record are the struct
// specialization's framing methods (codegen'd); their bodies are parsed only at the
// instantiation point, which is what lets reference cycles compile.
template <class T> ByteBuf to_binary(const T& x, alloc_t a) {
    ByteBuf out(a);
    binary_traits<T>::encode_record(out, x, a);
    return out;
}
template <class T> T from_binary(std::span<const std::byte> bytes, alloc_t a) {
    binary_detail::Reader r{bytes, 0, bytes.size()};
    return binary_traits<T>::decode_record(r, a);
}

// ── Payload dispatchers used by codegen for uniform reads/writes (payload only — no key) ──
template <class E> void encode_payload(ByteBuf& out, const E& x, alloc_t a) { binary_traits<E>::encode_payload(out, x, a); }
template <class E> E    decode_payload(binary_detail::Reader& r, std::uint8_t wt, alloc_t a) { return binary_traits<E>::decode_payload(r, wt, a); }

// ─── Leaf specializations ──────────────────────────────────────────────────────
//
// Each provides `static constexpr std::uint8_t wiretype`, `encode_payload`, and
// `decode_payload`, reusing binary_detail:: verbatim — the strongest possible byte-parity
// guarantee (the typed path calls the same byte-emitting functions as the dynamic path).

// string-family (String / Id / Enum-inline / Date / Time / Decimal) → length-prefixed bytes.
template <> struct binary_traits<std::pmr::string> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_LENGTH;
    static void encode_payload(ByteBuf& out, const std::pmr::string& s, alloc_t) {
        binary_detail::write_len_str(out, std::string_view(s));
    }
    static std::pmr::string decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t a) {
        return std::pmr::string(binary_detail::read_len_str(r), a);
    }
};

// signed integers (Integer<8|16|32|64> signed, bigint) + DateTime → varint, ZIGZAG. `bits`
// never affects the varint; the C++ member type is authoritative for sign here.
template <> struct binary_traits<std::int64_t> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, std::int64_t v, alloc_t) { binary_detail::write_varint(out, binary_detail::zigzag_encode(v)); }
    static std::int64_t decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return binary_detail::zigzag_decode(binary_detail::read_varint(r)); }
};
template <> struct binary_traits<std::int8_t> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, std::int8_t v, alloc_t) { binary_detail::write_varint(out, binary_detail::zigzag_encode(static_cast<std::int64_t>(v))); }
    static std::int8_t decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return static_cast<std::int8_t>(binary_detail::zigzag_decode(binary_detail::read_varint(r))); }
};
template <> struct binary_traits<std::int16_t> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, std::int16_t v, alloc_t) { binary_detail::write_varint(out, binary_detail::zigzag_encode(static_cast<std::int64_t>(v))); }
    static std::int16_t decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return static_cast<std::int16_t>(binary_detail::zigzag_decode(binary_detail::read_varint(r))); }
};
template <> struct binary_traits<std::int32_t> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, std::int32_t v, alloc_t) { binary_detail::write_varint(out, binary_detail::zigzag_encode(static_cast<std::int64_t>(v))); }
    static std::int32_t decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return static_cast<std::int32_t>(binary_detail::zigzag_decode(binary_detail::read_varint(r))); }
};
template <> struct binary_traits<DateTime> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, DateTime t, alloc_t) { binary_detail::write_varint(out, binary_detail::zigzag_encode(date_get_time(t))); }
    static DateTime decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return date_from_epoch_ms(binary_detail::zigzag_decode(binary_detail::read_varint(r))); }
};

// unsigned integers (Unsigned<8|16|32|64>) → varint, PLAIN LEB128 (no zigzag). uint64_t
// keeps the full 64-bit range — no int64 narrowing through keyma::Value as the dynamic path
// suffers (the C++ type is authoritative for the plain-vs-zigzag choice).
template <> struct binary_traits<std::uint64_t> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, std::uint64_t v, alloc_t) { binary_detail::write_varint(out, v); }
    static std::uint64_t decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return binary_detail::read_varint(r); }
};
template <> struct binary_traits<std::uint8_t> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, std::uint8_t v, alloc_t) { binary_detail::write_varint(out, static_cast<std::uint64_t>(v)); }
    static std::uint8_t decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return static_cast<std::uint8_t>(binary_detail::read_varint(r)); }
};
template <> struct binary_traits<std::uint16_t> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, std::uint16_t v, alloc_t) { binary_detail::write_varint(out, static_cast<std::uint64_t>(v)); }
    static std::uint16_t decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return static_cast<std::uint16_t>(binary_detail::read_varint(r)); }
};
template <> struct binary_traits<std::uint32_t> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, std::uint32_t v, alloc_t) { binary_detail::write_varint(out, static_cast<std::uint64_t>(v)); }
    static std::uint32_t decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return static_cast<std::uint32_t>(binary_detail::read_varint(r)); }
};

// bool → varint 0/1.
template <> struct binary_traits<bool> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_VARINT;
    static void encode_payload(ByteBuf& out, bool b, alloc_t) { binary_detail::write_varint(out, b ? 1 : 0); }
    static bool decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { return binary_detail::read_varint(r) != 0; }
};

// float → fixed32 (little-endian); double → fixed64.
template <> struct binary_traits<float> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_FIXED32;
    static void encode_payload(ByteBuf& out, float f, alloc_t) { binary_detail::write_f32(out, f); }
    static float decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { float f = binary_detail::read_f32(r, r.pos); r.pos += 4; return f; }
};
template <> struct binary_traits<double> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_FIXED64;
    static void encode_payload(ByteBuf& out, double d, alloc_t) { binary_detail::write_f64(out, d); }
    static double decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t) { double d = binary_detail::read_f64(r, r.pos); r.pos += 8; return d; }
};

// bytes → length-prefixed RAW bytes. base64 only ever lived in the keyma::Value repr; the
// wire is raw in both paths, so the typed path is byte-identical AND skips base64 entirely.
// Full specialization wins over the generic vector<E> below (the precedence trick
// value_traits uses too).
template <> struct binary_traits<std::pmr::vector<std::byte>> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_LENGTH;
    static void encode_payload(ByteBuf& out, const std::pmr::vector<std::byte>& b, alloc_t) {
        binary_detail::write_len_raw(out, std::span<const std::byte>(b.data(), b.size()));
    }
    static std::pmr::vector<std::byte> decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t a) {
        std::uint64_t n = binary_detail::read_varint(r);
        std::pmr::vector<std::byte> out(a);
        out.insert(out.end(), r.buf.data() + r.pos, r.buf.data() + r.pos + n);
        r.pos += n;
        return out;
    }
};

// keyma::Value (json fields) → length-prefixed self-describing json body. Reuses
// binary_detail::encode_json / decode_json verbatim (byte-identical to the dynamic path).
template <> struct binary_traits<Value> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_LENGTH;
    static void encode_payload(ByteBuf& out, const Value& v, alloc_t a) {
        ByteBuf body(a);
        binary_detail::encode_json(body, v);
        binary_detail::write_len_raw(out, std::span<const std::byte>(body.data(), body.size()));
    }
    static Value decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t a) {
        binary_detail::Reader inner = binary_detail::read_len_window(r);
        return binary_detail::decode_json(inner, a);
    }
};

// std::optional<E> → wiretype of E; payload delegates to E (presence/null framing is the
// field/element wrapper's job, never the value leaf's). Provided for completeness/nested
// composition — a field MEMBER's optional wrapper is unrolled by codegen, which operates on
// the inner core directly.
template <class E> struct binary_traits<std::optional<E>> {
    static constexpr std::uint8_t wiretype = binary_traits<E>::wiretype;
    static void encode_payload(ByteBuf& out, const std::optional<E>& o, alloc_t a) { binary_traits<E>::encode_payload(out, *o, a); }
    static std::optional<E> decode_payload(binary_detail::Reader& r, std::uint8_t wt, alloc_t a) { return std::optional<E>(binary_traits<E>::decode_payload(r, wt, a)); }
};

// keyma::Field<E> (two-axis) → same payload as optional<E>; presence framing handled at
// field level by codegen.
template <class E> struct binary_traits<Field<E>> {
    static constexpr std::uint8_t wiretype = binary_traits<E>::wiretype;
    static void encode_payload(ByteBuf& out, const Field<E>& f, alloc_t a) { binary_traits<E>::encode_payload(out, f.get(), a); }
    static Field<E> decode_payload(binary_detail::Reader& r, std::uint8_t wt, alloc_t a) {
        Field<E> f; f.present = true; f.value = binary_traits<E>::decode_payload(r, wt, a); return f;
    }
};

// std::pmr::vector<E> (array) → length-prefixed body of varint(count) + per element
// byte(binary_traits<E>::wiretype) + E payload. Empty → varint(0) (byte string 01 00,
// matching the dynamic path).
template <class E> struct binary_traits<std::pmr::vector<E>> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_LENGTH;
    static void encode_payload(ByteBuf& out, const std::pmr::vector<E>& xs, alloc_t a) {
        ByteBuf body(a);
        binary_detail::write_varint(body, xs.size());
        for (const E& e : xs) {
            binary_detail::put(body, binary_traits<E>::wiretype);
            binary_traits<E>::encode_payload(body, e, a);
        }
        binary_detail::write_len_raw(out, std::span<const std::byte>(body.data(), body.size()));
    }
    static std::pmr::vector<E> decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t a) {
        binary_detail::Reader inner = binary_detail::read_len_window(r);
        std::uint64_t count = binary_detail::read_varint(inner);
        std::pmr::vector<E> out(a);
        out.reserve(count);
        for (std::uint64_t i = 0; i < count; ++i) {
            std::uint8_t ewt = std::to_integer<std::uint8_t>(inner.buf[inner.pos++]);
            out.push_back(binary_traits<E>::decode_payload(inner, ewt, a));
        }
        return out;
    }
};

// std::pmr::vector<std::optional<E>> (element-nullable array) → byte(WIRE_NULL) / no payload
// for nullopt; on decode pushes nullopt for WIRE_NULL. Matches decode_value's array null
// handling. More specialized than vector<E>, so it wins for an optional element type.
template <class E> struct binary_traits<std::pmr::vector<std::optional<E>>> {
    static constexpr std::uint8_t wiretype = binary_detail::WIRE_LENGTH;
    static void encode_payload(ByteBuf& out, const std::pmr::vector<std::optional<E>>& xs, alloc_t a) {
        ByteBuf body(a);
        binary_detail::write_varint(body, xs.size());
        for (const std::optional<E>& e : xs) {
            if (!e.has_value()) { binary_detail::put(body, binary_detail::WIRE_NULL); continue; }
            binary_detail::put(body, binary_traits<E>::wiretype);
            binary_traits<E>::encode_payload(body, *e, a);
        }
        binary_detail::write_len_raw(out, std::span<const std::byte>(body.data(), body.size()));
    }
    static std::pmr::vector<std::optional<E>> decode_payload(binary_detail::Reader& r, std::uint8_t, alloc_t a) {
        binary_detail::Reader inner = binary_detail::read_len_window(r);
        std::uint64_t count = binary_detail::read_varint(inner);
        std::pmr::vector<std::optional<E>> out(a);
        out.reserve(count);
        for (std::uint64_t i = 0; i < count; ++i) {
            std::uint8_t ewt = std::to_integer<std::uint8_t>(inner.buf[inner.pos++]);
            if (ewt == binary_detail::WIRE_NULL) { out.push_back(std::nullopt); continue; }
            out.push_back(std::optional<E>(binary_traits<E>::decode_payload(inner, ewt, a)));
        }
        return out;
    }
};

// std::shared_ptr<T> (a reference held as an array element / nested value) → the target's
// BARE id, routing through the target's codegen'd id helpers (id_wiretype / encode_id_payload
// / decode_id_into — the binary analogues of value_traits' id_value / set_id). A reference
// FIELD is unrolled by codegen instead (its null-pointer framing — omit vs WIRE_NULL — is a
// field-level concern); this leaf handles a reference appearing as a vector<E> element, where
// per-element null is expressed by the surrounding vector<std::optional<E>> spec. A bare
// (non-optional) shared_ptr element is assumed non-null, like every other vector<E> element.
template <class T> struct binary_traits<std::shared_ptr<T>> {
    static constexpr std::uint8_t wiretype = binary_traits<T>::id_wiretype;
    static void encode_payload(ByteBuf& out, const std::shared_ptr<T>& p, alloc_t a) { binary_traits<T>::encode_id_payload(out, *p, a); }
    static std::shared_ptr<T> decode_payload(binary_detail::Reader& r, std::uint8_t wt, alloc_t a) {
        auto p = std::allocate_shared<T>(a);
        binary_traits<T>::decode_id_into(*p, r, wt, a);
        return p;
    }
};

// Embedded needs no special leaf: the member type IS the target struct, and the codegen'd
// struct specialization provides encode_payload / decode_payload (length-windowed encode_record
// / decode_record) plus wiretype = WIRE_LENGTH, so an embedded value — as a field OR a
// vector<Target> element — routes through binary_traits<Target> like any other leaf.

}  // namespace keyma
