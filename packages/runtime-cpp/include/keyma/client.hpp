#pragma once

// Client / query builder for @keyma/runtime-cpp (port of runtime-js `query.ts` + `client.ts`).
// The `Keyma` builders produce Leaf descriptors; a Document batches leaves into a request
// Value, sends it through a Transport, and returns the response Value. Typed builders
// (Keyma::list<T>(...)) derive the schema name from T::schema() and tag the leaf with its
// metadata for reference normalization; the typed `*_as<T>` helpers additionally hydrate
// results via keyma::from_value<T>. Templated on the async policy (default Sync).

#include <keyma/async.hpp>
#include <keyma/concepts.hpp>
#include <keyma/errors.hpp>
#include <keyma/protocol.hpp>
#include <keyma/query.hpp>
#include <keyma/serialize.hpp>
#include <keyma/server.hpp>

#include <format>
#include <functional>
#include <optional>
#include <string_view>
#include <utility>

namespace keyma {

template <template <class> class Async = Sync>
using Transport = move_only_function<Async<Value>(Value) const>;

// A pending operation descriptor. Clause Values are templates that may contain input
// placeholders ({"$keyma_input": name}); a null Value means the clause is absent. Not
// itself allocator-aware: its Value/string members each carry the allocator they were
// built with, and a normal move preserves them (so a std::pmr::vector<Leaf> relocates
// without needing uses-allocator construction).
struct Leaf {
    std::pmr::string op;
    std::pmr::string schema;
    std::pmr::string service;
    std::pmr::string method;
    Value where;
    Value data;
    Value project;
    Value spec;
    Value args;
    const SchemaMeta* meta = nullptr;  // for reference normalization of where/data

    explicit Leaf(alloc_t a)
        : op(a), schema(a), service(a), method(a),
          where(a), data(a), project(a), spec(a), args(a) {}
};

// ── Typed leaves: a compile-time overlay that carries an operation's result type T.
// Each owns the erased Leaf and decays back to it (so Document::add is unchanged); the
// result type rides along as a template parameter — the C++ analog of runtime-js's
// phantom LEAF_BRAND. `send` (below) reads it to hydrate the response so a caller never
// re-specifies T. ──
enum class LeafKind { List, Read, Create, Update, Delete, Count, Traverse, Call };

template <LeafKind K, class T>
struct TypedLeaf {
    using element_type = T;
    static constexpr LeafKind kind = K;
    Leaf leaf;
    explicit TypedLeaf(Leaf l) : leaf(std::move(l)) {}
    operator Leaf() && { return std::move(leaf); }   // decays into Document::add unchanged
    operator const Leaf&() const& { return leaf; }
};

template <class T> using ListLeaf = TypedLeaf<LeafKind::List, T>;
template <class T> using ReadLeaf = TypedLeaf<LeafKind::Read, T>;
template <class T> using CreateLeaf = TypedLeaf<LeafKind::Create, T>;
template <class T> using UpdateLeaf = TypedLeaf<LeafKind::Update, T>;
template <class T> using TraverseLeaf = TypedLeaf<LeafKind::Traverse, T>;
template <class T> using CallLeaf = TypedLeaf<LeafKind::Call, T>;
using DeleteLeaf = TypedLeaf<LeafKind::Delete, void>;
using CountLeaf = TypedLeaf<LeafKind::Count, std::int64_t>;

// Map (kind, element T) → the hydrated C++ result type `send` returns. The primary
// covers create/update/call(scalar); the per-kind partial specializations override.
template <LeafKind K, class T> struct leaf_result { using type = T; };
template <class T> struct leaf_result<LeafKind::List, T> { using type = std::pmr::vector<T>; };
template <class T> struct leaf_result<LeafKind::Traverse, T> { using type = std::pmr::vector<T>; };
template <class T> struct leaf_result<LeafKind::Read, T> { using type = std::optional<T>; };
template <class T> struct leaf_result<LeafKind::Count, T> { using type = std::int64_t; };
template <class T> struct leaf_result<LeafKind::Delete, T> { using type = void; };
template <class L> using leaf_result_t = typename leaf_result<L::kind, typename L::element_type>::type;

template <class L>
concept TypedLeafLike = requires {
    { L::kind } -> std::convertible_to<LeafKind>;
    typename L::element_type;
};

struct Keyma {
    // ── Dynamic builders (string schema name) ──
    static Leaf list(std::string_view schema, Value where = {}, Value project = {}, alloc_t a = {}) {
        Leaf l(a); l.op = std::pmr::string("list", a); l.schema = std::pmr::string(schema, a);
        l.where = std::move(where); l.project = std::move(project); return l;
    }
    static Leaf read(std::string_view schema, Value where, Value project = {}, alloc_t a = {}) {
        Leaf l(a); l.op = std::pmr::string("read", a); l.schema = std::pmr::string(schema, a);
        l.where = std::move(where); l.project = std::move(project); return l;
    }
    static Leaf create(std::string_view schema, Value data, Value project = {}, alloc_t a = {}) {
        Leaf l(a); l.op = std::pmr::string("create", a); l.schema = std::pmr::string(schema, a);
        l.data = std::move(data); l.project = std::move(project); return l;
    }
    static Leaf update(std::string_view schema, Value where, Value data, Value project = {}, alloc_t a = {}) {
        Leaf l(a); l.op = std::pmr::string("update", a); l.schema = std::pmr::string(schema, a);
        l.where = std::move(where); l.data = std::move(data); l.project = std::move(project); return l;
    }
    static Leaf del(std::string_view schema, Value where, alloc_t a = {}) {
        Leaf l(a); l.op = std::pmr::string("delete", a); l.schema = std::pmr::string(schema, a);
        l.where = std::move(where); return l;
    }
    static Leaf traverse(std::string_view schema, Value spec, Value project = {}, alloc_t a = {}) {
        Leaf l(a); l.op = std::pmr::string("traverse", a); l.schema = std::pmr::string(schema, a);
        l.spec = std::move(spec); l.project = std::move(project); return l;
    }
    static Leaf count(std::string_view schema, Value where = {}, alloc_t a = {}) {
        Leaf l(a); l.op = std::pmr::string("count", a); l.schema = std::pmr::string(schema, a);
        l.where = std::move(where); return l;
    }
    static Leaf call(std::string_view service, std::string_view method, Value args, alloc_t a = {}) {
        Leaf l(a); l.op = std::pmr::string("call", a);
        l.service = std::pmr::string(service, a); l.method = std::pmr::string(method, a);
        l.args = std::move(args); return l;
    }

    // ── Typed builders: derive schema name from T::schema(), tag the leaf for reference
    //    normalization, and carry the result type T in a TypedLeaf so `send` hydrates it. ──
    template <KeymaRecord T> static ListLeaf<T> list(Value where = {}, Value project = {}, alloc_t a = {}) {
        Leaf l = list(T::schema().name, std::move(where), std::move(project), a);
        l.meta = &T::schema(); return ListLeaf<T>{std::move(l)};
    }
    template <KeymaRecord T> static ReadLeaf<T> read(Value where, Value project = {}, alloc_t a = {}) {
        Leaf l = read(T::schema().name, std::move(where), std::move(project), a);
        l.meta = &T::schema(); return ReadLeaf<T>{std::move(l)};
    }
    template <KeymaRecord T> static CreateLeaf<T> create(Value data, Value project = {}, alloc_t a = {}) {
        Leaf l = create(T::schema().name, std::move(data), std::move(project), a);
        l.meta = &T::schema(); return CreateLeaf<T>{std::move(l)};
    }
    template <KeymaRecord T> static UpdateLeaf<T> update(Value where, Value data, Value project = {}, alloc_t a = {}) {
        Leaf l = update(T::schema().name, std::move(where), std::move(data), std::move(project), a);
        l.meta = &T::schema(); return UpdateLeaf<T>{std::move(l)};
    }
    template <KeymaRecord T> static DeleteLeaf del(Value where, alloc_t a = {}) {
        Leaf l = del(T::schema().name, std::move(where), a);
        l.meta = &T::schema(); return DeleteLeaf{std::move(l)};
    }
    template <KeymaRecord T> static CountLeaf count(Value where = {}, alloc_t a = {}) {
        Leaf l = count(T::schema().name, std::move(where), a);
        l.meta = &T::schema(); return CountLeaf{std::move(l)};
    }
    template <KeymaRecord T> static TraverseLeaf<T> traverse(Value spec, Value project = {}, alloc_t a = {}) {
        Leaf l = traverse(T::schema().name, std::move(spec), std::move(project), a);
        l.meta = &T::schema(); return TraverseLeaf<T>{std::move(l)};
    }

    // ── Typed Where<T> overloads (keyma/query.hpp): lower the typed filter to the Value
    //    the raw builders take, preserving the wire boundary. The `where` argument is
    //    non-defaulted so the zero-arg call still resolves to the Value overload above. ──
    template <KeymaRecord T> static ListLeaf<T> list(const Where<T>& where, Value project = {}, alloc_t a = {}) {
        return list<T>(where.to_value(a), std::move(project), a);
    }
    template <KeymaRecord T> static ReadLeaf<T> read(const Where<T>& where, Value project = {}, alloc_t a = {}) {
        return read<T>(where.to_value(a), std::move(project), a);
    }
    template <KeymaRecord T> static UpdateLeaf<T> update(const Where<T>& where, Value data, Value project = {}, alloc_t a = {}) {
        return update<T>(where.to_value(a), std::move(data), std::move(project), a);
    }
    template <KeymaRecord T> static DeleteLeaf del(const Where<T>& where, alloc_t a = {}) {
        return del<T>(where.to_value(a), a);
    }
    template <KeymaRecord T> static CountLeaf count(const Where<T>& where, alloc_t a = {}) {
        return count<T>(where.to_value(a), a);
    }

    // Input placeholder. Encoded as a sentinel object so it survives in a pure-Value pipeline;
    // resolved by Document against the per-leaf inputs at request time.
    static Value input(std::string_view name, alloc_t a = {}) {
        Value v = Value::object(a);
        v.set("$keyma_input", Value(name, a));
        return v;
    }
};

template <template <class> class Async = Sync>
    requires AsyncPolicy<Async>
class Document {
public:
    using AT = async_traits<Async>;
    explicit Document(alloc_t a) : a_(a), keys_(a), leaves_(a) {}

    Document& add(std::string_view key, Leaf leaf) {
        keys_.push_back(std::pmr::string(key, a_));
        leaves_.push_back(std::move(leaf));
        return *this;
    }

    // Build the batched request, send it through `transport`, and return the raw response
    // Value ({ results: { <key>: <leaf-result> } }). `inputs` maps leaf key -> input map.
    Async<Value> request(Transport<Async>& transport, Value inputs = {}) const {
        Value operations = Value::object(a_);
        for (std::size_t i = 0; i < keys_.size(); ++i) {
            std::string_view key(keys_[i]);
            const Value* li = inputs.find(key);
            Value leaf_inputs = (li != nullptr) ? Value(*li, a_) : Value::object(a_);
            operations.set(key, build_operation(leaves_[i], leaf_inputs));
        }
        return transport(proto::request(std::move(operations), a_));
    }

private:
    Value build_operation(const Leaf& leaf, const Value& leaf_inputs) const {
        std::string_view op(leaf.op);
        if (op == "call") {
            Value args = substitute(leaf.args, leaf_inputs);
            return proto::call_op(std::string_view(leaf.service), std::string_view(leaf.method), args, a_);
        }
        Value where = build_clause(leaf.where, leaf_inputs, leaf.meta);
        Value data = build_clause(leaf.data, leaf_inputs, leaf.meta);
        Value project = Value(leaf.project, a_);
        if (op == "list") return proto::list_op(std::string_view(leaf.schema), where, project, Value(a_), a_);
        if (op == "read") return proto::read_op(std::string_view(leaf.schema), where, project, a_);
        if (op == "create") return proto::create_op(std::string_view(leaf.schema), data, project, a_);
        if (op == "update") return proto::update_op(std::string_view(leaf.schema), where, data, project, a_);
        if (op == "delete") return proto::delete_op(std::string_view(leaf.schema), where, a_);
        if (op == "count") return proto::count_op(std::string_view(leaf.schema), where, a_);
        if (op == "traverse") {
            Value spec = substitute(leaf.spec, leaf_inputs);
            return proto::traverse_op(std::string_view(leaf.schema), spec, project, a_);
        }
        return Value::object(a_);
    }

    Value build_clause(const Value& tmpl, const Value& leaf_inputs, const SchemaMeta* meta) const {
        if (tmpl.is_null()) return Value(nullptr, a_);
        Value sub = substitute(tmpl, leaf_inputs);
        return (meta != nullptr) ? normalize_reference_ids(sub, *meta, a_) : sub;
    }

    // Recursively replace {"$keyma_input": name} placeholders with the bound input value.
    Value substitute(const Value& tmpl, const Value& leaf_inputs) const {
        if (tmpl.is_object()) {
            const Value* inp = tmpl.find("$keyma_input");
            if (inp != nullptr && inp->is_string()) {
                std::string_view name = inp->as_string();
                const Value* bound = leaf_inputs.find(name);
                if (bound == nullptr)
                    throw KeymaRuntimeError("MISSING_PARAMETER", std::format("Missing parameter \"{}\"", name));
                return Value(*bound, a_);
            }
            Value out = Value::object(a_);
            for (const Value::Member& m : tmpl.as_object())
                out.set(std::string_view(m.key), substitute(m.value, leaf_inputs));
            return out;
        }
        if (tmpl.is_array()) {
            Value arr = Value::array(a_);
            for (const Value& e : tmpl.as_array()) arr.push(substitute(e, leaf_inputs));
            return arr;
        }
        return Value(tmpl, a_);
    }

    alloc_t a_;
    std::pmr::vector<std::pmr::string> keys_;
    std::pmr::vector<Leaf> leaves_;
};

// In-process transport: route requests straight to a server's handle().
template <template <class> class Async = Sync>
    requires AsyncPolicy<Async>
Transport<Async> create_direct_transport(KeymaServer<Async>& server,
                                         move_only_function<RequestContext() const> context_factory = {}) {
    return Transport<Async>([&server, cf = std::move(context_factory)](Value req) -> Async<Value> {
        if (cf) return server.handle(std::move(req), cf());
        return server.handle(std::move(req));
    });
}

// Unwrap a leaf result by key, throwing a structured error on failure. Returns the
// `data` Value (used by `send` and the dynamic batched path).
inline const Value& leaf_unwrap(const Value& response, std::string_view key) {
    const Value& leaf = response.at("results").at(key);
    if (!proto::leaf_ok(leaf)) {
        const Value* err = leaf.find("error");
        std::string_view msg = (err != nullptr && err->is_string())
            ? std::string_view(err->as_string()) : std::string_view("request failed");
        throw KeymaRuntimeError(proto::leaf_code(leaf), msg);
    }
    return proto::leaf_data(leaf);
}

// Hydrate an unwrapped leaf-result Value into the typed result for (K, T).
template <LeafKind K, class T>
typename leaf_result<K, T>::type hydrate_leaf(const Value& data, alloc_t a) {
    if constexpr (K == LeafKind::List || K == LeafKind::Traverse) {
        std::pmr::vector<T> out(a);
        if (data.is_array())
            for (const Value& e : data.as_array()) out.push_back(from_value<T>(e, a));
        return out;
    } else if constexpr (K == LeafKind::Read) {
        if (data.is_null()) return std::nullopt;
        return std::optional<T>(from_value<T>(data, a));
    } else if constexpr (K == LeafKind::Count) {
        return data.as_int();
    } else if constexpr (K == LeafKind::Delete) {
        return;  // void — nothing to hydrate (leaf_unwrap already threw on failure)
    } else {  // Create / Update / Call — T may be a scalar, struct, vector<E>, or void
        if constexpr (std::is_void_v<T>) return;            // a void-returning service call
        else return from_value<T>(data, a);                 // from_value<vector<E>> handles array returns
    }
}

// ── Typed single-operation send ──
// Builds a one-op document, dispatches it through `transport`, unwraps the leaf (throwing
// on failure), and hydrates to the leaf's result type — deriving T from the leaf so the
// caller never re-specifies it. The async policy defaults to Sync and is given explicitly
// for a deferred policy: `send<MyPolicy>(tx, leaf)`.
template <template <class> class Async = Sync, TypedLeafLike L>
    requires AsyncPolicy<Async>
Async<leaf_result_t<L>> send(Transport<Async>& transport, L leaf, Value inputs = {}, alloc_t a = {}) {
    Document<Async> doc(a);
    doc.add("q", std::move(leaf));
    return async_traits<Async>::then(doc.request(transport, std::move(inputs)),
        [a](Value resp) -> leaf_result_t<L> {
            return hydrate_leaf<L::kind, typename L::element_type>(leaf_unwrap(resp, "q"), a);
        });
}

// ── Backwards-compatible convenience helpers ──
// Thin forwarders to `send` over the typed builders (preferred form: `send(tx,
// Keyma::create<T>(...))`). Kept so existing call sites compile unchanged.

template <class T, template <class> class Async = Sync>
Async<std::pmr::vector<T>> list_as(Transport<Async>& tx, Value where = {}, Value project = {}, alloc_t a = {}) {
    return send<Async>(tx, Keyma::list<T>(std::move(where), std::move(project), a), Value{}, a);
}

template <class T, template <class> class Async = Sync>
Async<std::optional<T>> read_as(Transport<Async>& tx, Value where, Value project = {}, alloc_t a = {}) {
    return send<Async>(tx, Keyma::read<T>(std::move(where), std::move(project), a), Value{}, a);
}

template <class T, template <class> class Async = Sync>
Async<T> create_as(Transport<Async>& tx, Value data, Value project = {}, alloc_t a = {}) {
    return send<Async>(tx, Keyma::create<T>(std::move(data), std::move(project), a), Value{}, a);
}

template <class T, template <class> class Async = Sync>
Async<T> update_as(Transport<Async>& tx, Value where, Value data, Value project = {}, alloc_t a = {}) {
    return send<Async>(tx, Keyma::update<T>(std::move(where), std::move(data), std::move(project), a), Value{}, a);
}

// count_to keys off a string schema (not a record type), so it hydrates the int64 directly.
template <template <class> class Async = Sync>
Async<std::int64_t> count_to(Transport<Async>& tx, std::string_view schema, Value where = {}, alloc_t a = {}) {
    Document<Async> doc(a);
    doc.add("q", Keyma::count(schema, std::move(where), a));
    return async_traits<Async>::then(doc.request(tx),
        [](Value resp) { return leaf_unwrap(resp, "q").as_int(); });
}

}  // namespace keyma
