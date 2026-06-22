#pragma once

// Server plugin contract for @keyma/runtime-cpp (the C++ mirror of runtime-js `plugin.ts`).
// Pure-virtual interface only — concrete plugins (e.g. an `@keyma/plugin-*`) are separate
// packages. Templated on the async policy. Each hook is optional: override the paired
// `has_*()` predicate to return true and implement the hook (the server skips a hook whose
// predicate is false, mirroring the JS `if (p.hook === undefined) continue`).
//
// Transform hooks return Async<std::optional<X>>: an empty optional means "unchanged"
// (the JS `undefined`); a present optional replaces the threaded value.

#include <keyma/adapter.hpp>
#include <keyma/async.hpp>
#include <keyma/protocol.hpp>
#include <keyma/runtime.hpp>

#include <optional>
#include <span>
#include <string_view>

namespace keyma {

enum class KeymaAction { Read, List, Traverse, Count, Create, Update, Delete };
enum class KeymaWriteAction { Create, Update, Delete };

template <template <class> class Async = Sync>
struct PluginServerHandle {
    virtual ~PluginServerHandle() = default;
    virtual std::span<const SchemaMeta* const> schemas() const = 0;
    virtual KeymaDatabaseAdapter<Async>& adapter() const = 0;
    virtual const SchemaMeta* schema(std::string_view name) const = 0;
    virtual Async<void> add_schema(const SchemaMeta& schema) = 0;
};

template <template <class> class Async = Sync>
struct KeymaServerPlugin {
    virtual ~KeymaServerPlugin() = default;
    virtual std::string_view name() const = 0;

    virtual bool has_init() const { return false; }
    virtual Async<void> init(PluginServerHandle<Async>& handle) {
        (void)handle;
        return async_traits<Async>::ready();
    }

    // Rewrite an entire operation before dispatch.
    virtual bool has_transform_operation() const { return false; }
    virtual Async<std::optional<Value>> transform_operation(const RequestContext& ctx, const Value& op) {
        (void)ctx; (void)op;
        return async_traits<Async>::ready(std::optional<Value>{});
    }

    virtual bool has_before_operation() const { return false; }
    virtual Async<void> before_operation(const RequestContext& ctx, const Value& op) {
        (void)ctx; (void)op;
        return async_traits<Async>::ready();
    }

    // Merge policy clauses into the filter (e.g. ACL).
    virtual bool has_transform_filter() const { return false; }
    virtual Async<std::optional<Value>> transform_filter(const RequestContext& ctx, const SchemaMeta& schema,
                                                         const Value& where, KeymaAction action) {
        (void)ctx; (void)schema; (void)where; (void)action;
        return async_traits<Async>::ready(std::optional<Value>{});
    }

    virtual bool has_transform_projection() const { return false; }
    virtual Async<std::optional<AdapterProjection>> transform_projection(
        const RequestContext& ctx, const SchemaMeta& schema, const AdapterProjection& projection, KeymaAction action) {
        (void)ctx; (void)schema; (void)projection; (void)action;
        return async_traits<Async>::ready(std::optional<AdapterProjection>{});
    }

    // Authorize/transform a write payload.
    virtual bool has_check_write() const { return false; }
    virtual Async<std::optional<Value>> check_write(const RequestContext& ctx, const SchemaMeta& schema,
                                                    const Value& data, KeymaWriteAction action) {
        (void)ctx; (void)schema; (void)data; (void)action;
        return async_traits<Async>::ready(std::optional<Value>{});
    }

    virtual bool has_transform_result() const { return false; }
    virtual Async<std::optional<std::pmr::vector<Value>>> transform_result(
        const RequestContext& ctx, const SchemaMeta& schema, const std::pmr::vector<Value>& records, KeymaAction action) {
        (void)ctx; (void)schema; (void)records; (void)action;
        return async_traits<Async>::ready(std::optional<std::pmr::vector<Value>>{});
    }

    // Observe the finished operation. Errors here must not change the response.
    virtual bool has_after_operation() const { return false; }
    virtual Async<void> after_operation(const RequestContext& ctx, const Value& op, const Value& result) {
        (void)ctx; (void)op; (void)result;
        return async_traits<Async>::ready();
    }
};

}  // namespace keyma
