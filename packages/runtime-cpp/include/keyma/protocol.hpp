#pragma once

// Wire protocol for @keyma/runtime-cpp. Mirrors runtime-js `protocol.ts`. Operations,
// requests, and responses are plain keyma::Value objects (JSON-native, exactly like the
// JS/Python plain-dict design) so they cross a transport as JSON unchanged. This header
// provides typed builders/accessors over that Value shape, plus the RequestContext alias.

#include <keyma/runtime.hpp>

#include <string_view>
#include <utility>

namespace keyma {

// Per-request context (identity, etc.). A Value object; `identity.isSystem == true`
// marks the in-process system caller that bypasses visibility guards.
using RequestContext = Value;

namespace proto {

// Set a key only when the value is non-null, so absent optionals omit the key (mirrors
// the JS `if (x !== undefined)` guards on operation fields).
inline void set_opt(Value& o, std::string_view key, const Value& v, alloc_t a) {
    if (!v.is_null()) o.set(key, Value(v, a));
}

inline Value list_op(std::string_view schema, const Value& where, const Value& project,
                     const Value& options, alloc_t a) {
    Value o = Value::object(a);
    o.set("op", Value(std::string_view("list"), a));
    o.set("schema", Value(schema, a));
    set_opt(o, "where", where, a);
    set_opt(o, "project", project, a);
    set_opt(o, "options", options, a);
    return o;
}
inline Value read_op(std::string_view schema, const Value& where, const Value& project, alloc_t a) {
    Value o = Value::object(a);
    o.set("op", Value(std::string_view("read"), a));
    o.set("schema", Value(schema, a));
    o.set("where", Value(where, a));
    set_opt(o, "project", project, a);
    return o;
}
inline Value create_op(std::string_view schema, const Value& data, const Value& project, alloc_t a) {
    Value o = Value::object(a);
    o.set("op", Value(std::string_view("create"), a));
    o.set("schema", Value(schema, a));
    o.set("data", Value(data, a));
    set_opt(o, "project", project, a);
    return o;
}
inline Value update_op(std::string_view schema, const Value& where, const Value& data,
                       const Value& project, alloc_t a) {
    Value o = Value::object(a);
    o.set("op", Value(std::string_view("update"), a));
    o.set("schema", Value(schema, a));
    o.set("where", Value(where, a));
    o.set("data", Value(data, a));
    set_opt(o, "project", project, a);
    return o;
}
inline Value delete_op(std::string_view schema, const Value& where, alloc_t a) {
    Value o = Value::object(a);
    o.set("op", Value(std::string_view("delete"), a));
    o.set("schema", Value(schema, a));
    o.set("where", Value(where, a));
    return o;
}
inline Value traverse_op(std::string_view schema, const Value& spec, const Value& project, alloc_t a) {
    Value o = Value::object(a);
    o.set("op", Value(std::string_view("traverse"), a));
    o.set("schema", Value(schema, a));
    o.set("spec", Value(spec, a));
    set_opt(o, "project", project, a);
    return o;
}
inline Value count_op(std::string_view schema, const Value& where, alloc_t a) {
    Value o = Value::object(a);
    o.set("op", Value(std::string_view("count"), a));
    o.set("schema", Value(schema, a));
    set_opt(o, "where", where, a);
    return o;
}
inline Value call_op(std::string_view service, std::string_view method, const Value& args, alloc_t a) {
    Value o = Value::object(a);
    o.set("op", Value(std::string_view("call"), a));
    o.set("service", Value(service, a));
    o.set("method", Value(method, a));
    o.set("args", Value(args, a));
    return o;
}

inline Value request(Value operations, alloc_t a) {
    Value o = Value::object(a);
    o.set("operations", std::move(operations));
    return o;
}
inline Value batch_response(Value results, alloc_t a) {
    Value o = Value::object(a);
    o.set("results", std::move(results));
    return o;
}
inline Value ok_result(Value data, alloc_t a) {
    Value o = Value::object(a);
    o.set("ok", Value(true, a));
    o.set("data", std::move(data));
    return o;
}

// ── Accessors ──
inline std::string_view op_kind(const Value& op) {
    const Value* p = op.find("op");
    return (p != nullptr && p->is_string()) ? std::string_view(p->as_string()) : std::string_view{};
}
inline std::string_view op_schema(const Value& op) {
    const Value* p = op.find("schema");
    return (p != nullptr && p->is_string()) ? std::string_view(p->as_string()) : std::string_view{};
}
inline bool leaf_ok(const Value& result) {
    const Value* p = result.find("ok");
    return p != nullptr && p->is_bool() && p->as_bool();
}
inline const Value& leaf_data(const Value& result) { return result.at("data"); }
inline std::string_view leaf_code(const Value& result) {
    const Value* p = result.find("code");
    return (p != nullptr && p->is_string()) ? std::string_view(p->as_string()) : std::string_view{};
}

}  // namespace proto
}  // namespace keyma
