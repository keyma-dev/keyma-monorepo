#pragma once

// Database adapter contract for @keyma/runtime-cpp (the C++ mirror of runtime-js
// `adapter.ts`). This header ships ONLY the pure-virtual interface plus the adapter-facing
// data structs the server hands an adapter — concrete adapters (e.g. an `@keyma/adapter-*`)
// are separate packages. The interface is templated on the async policy (default Sync), so
// a synchronous adapter implements `KeymaDatabaseAdapter<>` and an async one implements
// `KeymaDatabaseAdapter<std::future>` etc.

#include <keyma/async.hpp>
#include <keyma/errors.hpp>
#include <keyma/runtime.hpp>

#include <cstdint>
#include <optional>
#include <string_view>
#include <utility>

namespace keyma {

struct PopulateNode;

// A resolved projection the adapter executes directly. `fields` is the AdapterFieldSpec
// map (`{ field: 1 | nested-spec }`) as a Value; a null `fields` means "all fields".
// `populate` expands reference/embedded fields into resolved sub-projections.
struct AdapterProjection {
    using allocator_type = alloc_t;
    Value fields;                                 // object spec, or null = all
    std::pmr::vector<PopulateNode> populate;

    AdapterProjection() : fields(), populate() {}
    explicit AdapterProjection(alloc_t a) : fields(a), populate(a) {}
    AdapterProjection(const AdapterProjection& o, alloc_t a) : fields(o.fields, a), populate(o.populate, a) {}
    AdapterProjection(AdapterProjection&& o, alloc_t a) : fields(std::move(o.fields), a), populate(std::move(o.populate), a) {}
    AdapterProjection(const AdapterProjection&) = default;
    AdapterProjection(AdapterProjection&&) = default;
    AdapterProjection& operator=(const AdapterProjection&) = default;
    AdapterProjection& operator=(AdapterProjection&&) = default;
    alloc_t get_allocator() const noexcept { return fields.get_allocator(); }
};

// One reference/embedded field expanded to its target schema and sub-projection.
struct PopulateNode {
    using allocator_type = alloc_t;
    std::pmr::string field;
    const SchemaMeta* schema = nullptr;
    AdapterProjection projection;

    explicit PopulateNode(alloc_t a) : field(a), projection(a) {}
    PopulateNode(const PopulateNode& o, alloc_t a) : field(o.field, a), schema(o.schema), projection(o.projection, a) {}
    PopulateNode(PopulateNode&& o, alloc_t a) : field(std::move(o.field), a), schema(o.schema), projection(std::move(o.projection), a) {}
    PopulateNode(const PopulateNode&) = default;
    PopulateNode(PopulateNode&&) = default;
    PopulateNode& operator=(const PopulateNode&) = default;
    PopulateNode& operator=(PopulateNode&&) = default;
    alloc_t get_allocator() const noexcept { return field.get_allocator(); }
};

struct ListQuery {
    using allocator_type = alloc_t;
    Value where;                                  // Mongo-style filter
    Value sort;                                   // object: field -> 1 | -1
    std::optional<std::int64_t> skip;
    std::optional<std::int64_t> limit;
    AdapterProjection projection;

    explicit ListQuery(alloc_t a) : where(a), sort(a), projection(a) {}
    ListQuery(const ListQuery& o, alloc_t a)
        : where(o.where, a), sort(o.sort, a), skip(o.skip), limit(o.limit), projection(o.projection, a) {}
    ListQuery(ListQuery&& o, alloc_t a)
        : where(std::move(o.where), a), sort(std::move(o.sort), a), skip(o.skip), limit(o.limit),
          projection(std::move(o.projection), a) {}
    ListQuery(const ListQuery&) = default;
    ListQuery(ListQuery&&) = default;
    ListQuery& operator=(const ListQuery&) = default;
    ListQuery& operator=(ListQuery&&) = default;
    alloc_t get_allocator() const noexcept { return where.get_allocator(); }
};

// Capability flags advertised by an adapter; the server checks these before dispatching
// (e.g. it rejects traverse with UNSUPPORTED unless `traverse` is set).
struct AdapterCapabilities {
    bool traverse = false;
    int max_depth = 0;
    bool emit_paths = false;
    bool heterogeneous = false;
};

// Resolved-schema context handed to traverse() — saves the adapter from name lookups.
// edges/nodes are small association lists (schema name -> metadata).
struct AdapterTraversalContext {
    using allocator_type = alloc_t;
    const SchemaMeta* terminal_schema = nullptr;
    const SchemaMeta* start_schema = nullptr;
    std::pmr::vector<std::pair<std::string_view, const SchemaMeta*>> edges;
    std::pmr::vector<std::pair<std::string_view, const SchemaMeta*>> nodes;

    explicit AdapterTraversalContext(alloc_t a) : edges(a), nodes(a) {}
};

// The database adapter consumed by KeymaServer. `read` returns a null Value when no record
// matches; `traverse` returns an array Value (node/edge records, or {nodes,edges} path
// objects). Filter Values follow the documented Mongo-style shape (literals or `$`-operator
// objects; top-level `$and`/`$or`/`$nor`).
template <template <class> class Async = Sync>
struct KeymaDatabaseAdapter {
    virtual ~KeymaDatabaseAdapter() = default;

    virtual const AdapterCapabilities& capabilities() const {
        static const AdapterCapabilities none{};
        return none;
    }
    // Optional connection lifecycle. Default no-op.
    virtual Async<void> connect() { return async_traits<Async>::ready(); }
    virtual Async<void> close() { return async_traits<Async>::ready(); }

    virtual Async<void> ensure_schema(const SchemaMeta& schema) = 0;
    virtual Async<Value> create(const SchemaMeta& schema, Value data, AdapterProjection projection) = 0;
    virtual Async<Value> read(const SchemaMeta& schema, Value where, AdapterProjection projection) = 0;
    virtual Async<std::pmr::vector<Value>> list(const SchemaMeta& schema, ListQuery query) = 0;
    virtual Async<Value> update(const SchemaMeta& schema, Value where, Value data, AdapterProjection projection) = 0;
    virtual Async<void> del(const SchemaMeta& schema, Value where) = 0;
    virtual Async<std::int64_t> count(const SchemaMeta& schema, Value where) = 0;

    // Optional graph traversal. Default: unsupported (the server gates on capabilities()).
    virtual Async<Value> traverse(const AdapterTraversalContext& ctx, Value spec, AdapterProjection projection) {
        (void)ctx; (void)spec; (void)projection;
        throw KeymaRuntimeError("UNSUPPORTED", "Database adapter does not support traverse operations");
    }
};

}  // namespace keyma
