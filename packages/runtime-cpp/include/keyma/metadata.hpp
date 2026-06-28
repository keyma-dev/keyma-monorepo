#pragma once

// Schema metadata + validation/formatter callback types for @keyma/runtime-cpp.
//
// The validator/formatter function types (ValidatorFn / FormatterFn) over keyma::Value, the
// presence×nullability Field<T>, and the static schema descriptors (TypeTag … FieldMeta /
// ClassMetadata + the all_fields base-chain walk) the C++ backend emits per schema and the
// server / codecs / serialize consume. Builds on keyma::Value and keyma::move_only_function.

#include <cstdint>
#include <expected>
#include <functional>
#include <memory_resource>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <keyma/value.hpp>
#include <keyma/function.hpp>

namespace keyma {

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

using ValidatorFn = move_only_function<
    std::expected<void, ValidationError>(const Value&, std::string_view, const Context&) const>;
using FormatterFn = move_only_function<Value(const Value&, const Context&) const>;

// ─── Typed validator hot path (method-driven synthesis) ──────────────────────
//
// The concrete-typed validator context: the enclosing instance, by const-ref. A synthesized
// `validate()`/`format*()` builds `ValidatorCtx{(*this)}` (CTAD) so cross-field reads are typed
// member accesses (`ctx.object.<field>`) and the allocator is reachable as
// `ctx.object.get_allocator()`. Generic over the model type so no per-schema context type is
// emitted; distinct from the legacy Value-based `Context` (which the A-oracle drivers still use).
template <class T>
struct ValidatorCtx {
    const T& object;
};

// Collect the non-null candidate errors (each a `std::optional<ValidationError>`) into a vector
// built on `a` — the typed-vector companion to the JS/Python baked `__keyma_collect`/`_keyma_collect`
// (the `error.collect` intrinsic lowers to this in C++). A null candidate is skipped; a present one
// is moved in. (`alloc_t` is spelled out here — it is aliased later, in intrinsics.hpp.)
template <class... Opts>
std::pmr::vector<ValidationError> collect_errors(std::pmr::polymorphic_allocator<std::byte> a, Opts&&... opts) {
    std::pmr::vector<ValidationError> out(a);
    ( (opts.has_value() ? (void)out.push_back(std::move(*opts)) : (void)0), ... );
    return out;
}

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
    Date, DateTime, Time, Id, Enum, Array, Reference, Embedded,
};

enum class Visibility { Public, Private };
enum class Phase { Change, Blur, Submit, Save };

// Logical classification of a field for the typed query DSL (keyma/query.hpp). Carried
// by the per-schema field descriptors the C++ backend emits (`struct f`) so the typed
// where/projection builders can constrain operands and pick the right lowering:
//   Scalar    — equality/membership only (bool, bytes).
//   Ordered   — also supports relational operators ($gt/$gte/$lt/$lte): string, number,
//               integer, decimal, date(Time), id.
//   Enum      — a named enum; the descriptor's Value is the enum class, lowered via
//               keyma::to_string to its wire string.
//   Reference — a relation; the descriptor's Value is the TARGET's id type, and operands
//               may be a bare id, an {id} wrapper, or a target instance.
//   Json      — an opaque keyma::Value (equality only).
enum class FieldKind { Scalar, Ordered, Enum, Reference, Json };

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
    // Binary-wire type detail (see keyma/binary.hpp). Additive, trailing, and defaulted so
    // existing generated FieldMeta designated-initializers keep compiling unchanged. The
    // flat `type` tag alone cannot drive the binary codec's varint-vs-float / signed-vs-
    // unsigned / bare-id-wire-kind choices, so these carry the missing nested-type detail.
    std::uint32_t tag = 0;            // stable wire tag; 0 ⇒ fall back to 1-based declaration index
    int bits = 64;                    // Number: 32 ⇒ float32 wire (for an array, the element's bits)
    bool is_unsigned = false;         // Integer: plain LEB128 vs zigzag (for an array, the element's)
    TypeTag id_type = TypeTag::Id;    // Reference: bare-id wire kind (Integer ⇒ varint, else length)
    bool id_unsigned = false;         // Reference: unsigned integer id
};

struct ClassMetadata {
    std::string_view name;
    std::string_view source_name;
    Visibility visibility = Visibility::Public;
    bool ephemeral = false;
    std::span<const FieldMeta> fields{};
    std::span<const IndexMeta> indexes{};
    // refs: target schema `name` → accessor for the target's metadata.
    std::span<const std::pair<std::string_view, const ClassMetadata& (*)()>> refs{};
    // Real inheritance: accessor for the `extends` parent's metadata (null if none). `fields`
    // holds OWN fields only — walk `base` for the full set (see `all_fields`).
    const ClassMetadata& (*base)() = nullptr;
    // Set only for schemas that model a graph edge; null otherwise.
    const EdgeMeta* edge = nullptr;
    void (*apply_defaults)(Value&, const Value::allocator_type&) = nullptr;
};

// The full field set of a schema including inherited fields, base-first (matching the old
// flattened order). `fields` carries OWN fields only now that inheritance is real, so every
// metadata-driven consumer (serialize / validate / defaults / binary / reference) walks the
// `base` chain through this helper. A returned `reference_wrapper` binds to `const FieldMeta&`
// in a range-for unchanged. (Field overrides — a child re-declaring a parent field name — are
// rare; both entries are kept, child later, so the more-derived wins on assignment.)
inline std::pmr::vector<std::reference_wrapper<const FieldMeta>> all_fields(
    const ClassMetadata& schema, const std::pmr::polymorphic_allocator<std::byte>& a) {
    std::pmr::vector<const ClassMetadata*> chain(a);
    for (const ClassMetadata* s = &schema; s != nullptr; s = (s->base != nullptr ? &s->base() : nullptr)) chain.push_back(s);
    std::pmr::vector<std::reference_wrapper<const FieldMeta>> out(a);
    for (auto it = chain.rbegin(); it != chain.rend(); ++it)
        for (const FieldMeta& f : (*it)->fields) out.push_back(std::cref(f));
    return out;
}

}  // namespace keyma
