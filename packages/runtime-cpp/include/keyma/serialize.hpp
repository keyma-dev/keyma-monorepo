#pragma once

// Serialization filtering + reference normalization for @keyma/runtime-cpp (mirror of
// runtime-js `serialize.ts` + `reference.ts`). `serialize` strips fields by target
// (private→client, ephemeral→database) and recurses embedded/array values via the schema's
// `refs`. `normalize_reference_ids` collapses reference-field values to bare ids on the
// write/filter path.
//
// Wire scalars need no conversion here: a `dateTime` lives in keyma::Value as an epoch-ms
// int64 and a `bytes` as a base64 string (value_traits<DateTime> / value_traits<vector<byte>>)
// — both are the canonical cross-runtime wire format shared with the JS and Python runtimes,
// so serialize passes them through unchanged. (keyma::to_iso8601 / keyma::date_parse are
// application-logic helpers backing the `date.toISOString()` / `new Date("…")` body
// intrinsics, not wire helpers.)

#include <keyma/runtime.hpp>

#include <string_view>
#include <utility>

namespace keyma {

enum class SerializeTarget { Client, Server, Database };

// Resolve a target schema by `name` via the parent's refs (the name → metadata accessor
// span). Returns nullptr when the name is not a declared ref of `schema`.
inline const ClassMetadata* resolve_ref(const ClassMetadata& schema, std::string_view target_name) {
    // `refs` is own-only (real inheritance); a ref target of an inherited field lives on an
    // ancestor, so walk the base chain.
    for (const ClassMetadata* s = &schema; s != nullptr; s = (s->base != nullptr ? &s->base() : nullptr)) {
        for (const auto& entry : s->refs) {
            if (entry.first == target_name) return &entry.second();
        }
    }
    return nullptr;
}

Value serialize(const ClassMetadata& schema, const Value& value, SerializeTarget target, alloc_t a);

inline Value serialize_element(const Value& v, TypeTag tag, std::string_view target_name,
                               const ClassMetadata& schema, SerializeTarget target, alloc_t a) {
    if (tag == TypeTag::Embedded && v.is_object()) {
        const ClassMetadata* sub = resolve_ref(schema, target_name);
        if (sub != nullptr) return serialize(*sub, v, target, a);
        return Value(v, a);
    }
    // dateTime (epoch-ms int64), bytes (base64 string), reference (already an id/object),
    // and scalars all pass through verbatim — they are already in canonical wire form.
    return Value(v, a);
}

inline Value serialize_value(const Value& v, const FieldMeta& f, const ClassMetadata& schema,
                             SerializeTarget target, alloc_t a) {
    if (f.type == TypeTag::Array && v.is_array()) {
        Value arr = Value::array(a);
        for (const Value& el : v.as_array())
            arr.push(serialize_element(el, f.element, f.target, schema, target, a));
        return arr;
    }
    return serialize_element(v, f.type, f.target, schema, target, a);
}

inline Value serialize(const ClassMetadata& schema, const Value& value, SerializeTarget target, alloc_t a) {
    Value out = Value::object(a);
    for (const FieldMeta& f : all_fields(schema, a)) {  // own + inherited (real inheritance)
        if (target == SerializeTarget::Client && f.visibility == Visibility::Private) continue;
        if (target == SerializeTarget::Database && f.ephemeral) continue;
        const Value* present = value.find(f.name);
        if (present == nullptr) continue;
        out.set(f.name, serialize_value(*present, f, schema, target, a));
    }
    return out;
}

// ── Reference normalization (reference.ts) ──

// Collapse a single reference value to its bare id: null passes through, a bare scalar id
// passes through, an `{ id }` object becomes its id, an object without `id` is left as-is.
inline Value normalize_reference_value(const Value& v, alloc_t a) {
    if (v.is_object()) {
        const Value* id = v.find("id");
        if (id != nullptr) return Value(*id, a);
    }
    return Value(v, a);
}

inline bool is_query_operator_object(const Value& v) {
    if (!v.is_object()) return false;
    for (const Value::Member& m : v.as_object())
        if (!m.key.empty() && m.key.front() == '$') return true;
    return false;
}

// Normalize the value of a single reference field: operator objects (normalize each operand),
// arrays (element-wise), and scalar references.
inline Value normalize_reference_field_value(const Value& v, alloc_t a) {
    if (v.is_null()) return Value(v, a);
    if (is_query_operator_object(v)) {
        Value out = Value::object(a);
        for (const Value::Member& m : v.as_object()) {
            std::string_view k(m.key);
            if (k == "$in" || k == "$nin") {
                Value arr = Value::array(a);
                if (m.value.is_array())
                    for (const Value& el : m.value.as_array()) arr.push(normalize_reference_value(el, a));
                else
                    arr = Value(m.value, a);  // non-array operand left as-is
                out.set(k, std::move(arr));
            } else if (k == "$eq" || k == "$ne" || k == "$gt" || k == "$gte" || k == "$lt" || k == "$lte") {
                out.set(k, normalize_reference_value(m.value, a));
            } else {
                out.set(k, Value(m.value, a));
            }
        }
        return out;
    }
    if (v.is_array()) {
        Value arr = Value::array(a);
        for (const Value& el : v.as_array()) arr.push(normalize_reference_value(el, a));
        return arr;
    }
    return normalize_reference_value(v, a);
}

// Collapse every reference-typed field in a where/data record to bare id(s). The core type
// unwraps an array field to its element (FieldMeta.element). Returns a new Value.
inline Value normalize_reference_ids(const Value& record, const ClassMetadata& schema, alloc_t a) {
    Value out(record, a);
    for (const FieldMeta& f : all_fields(schema, a)) {  // own + inherited (real inheritance)
        if (out.find(f.name) == nullptr) continue;
        TypeTag core = (f.type == TypeTag::Array) ? f.element : f.type;
        if (core != TypeTag::Reference) continue;
        out.set(f.name, normalize_reference_field_value(out.at(f.name), a));
    }
    return out;
}

}  // namespace keyma
