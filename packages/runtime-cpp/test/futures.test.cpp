// Proves the Async<> policy template is not accidentally coupled to keyma::Sync: it
// supplies a (blocking) std::future policy — the kind of thing a "bring your own
// scheduler" user writes — and drives a full KeymaServer<std::future> CRUD round-trip
// through it. The policy below is illustrative (its `then` blocks via .get()); a real
// deferred policy would attach continuations to its executor instead.
//
// Compiled and run by scripts/cpp-test.sh.

#include <keyma/async.hpp>

#include <future>
#include <type_traits>
#include <utility>

// ── A blocking std::future policy (user-supplied; not part of the runtime). ──
namespace keyma {
template <class U> struct is_async<std::future<U>> : std::true_type {};
template <class U> struct payload<std::future<U>> { using type = U; };

template <>
struct async_traits<std::future> {
    template <class T>
    static std::future<std::remove_cvref_t<T>> ready(T&& v) {
        std::promise<std::remove_cvref_t<T>> p;
        p.set_value(std::forward<T>(v));
        return p.get_future();
    }
    static std::future<void> ready() {
        std::promise<void> p;
        p.set_value();
        return p.get_future();
    }
    template <class T, class F>
    static auto then(std::future<T>&& m, F&& f) {
        T v = m.get();
        using R = std::invoke_result_t<F, T&&>;
        if constexpr (is_async_v<R>) return std::forward<F>(f)(std::move(v));
        else if constexpr (std::is_void_v<R>) { std::forward<F>(f)(std::move(v)); return ready(); }
        else return ready(std::forward<F>(f)(std::move(v)));
    }
    template <class F>
    static auto then(std::future<void>&& m, F&& f) {
        m.get();
        using R = std::invoke_result_t<F>;
        if constexpr (is_async_v<R>) return std::forward<F>(f)();
        else if constexpr (std::is_void_v<R>) { std::forward<F>(f)(); return ready(); }
        else return ready(std::forward<F>(f)());
    }
    template <class Thunk, class OnError>
    static auto attempt(Thunk&& thunk, OnError&& on_error) {
        try {
            return std::forward<Thunk>(thunk)();
        } catch (...) {
            return ready(std::forward<OnError>(on_error)(std::current_exception()));
        }
    }
    template <class Thunk>
    static std::future<void> swallow(Thunk&& thunk) {
        try { std::forward<Thunk>(thunk)().get(); } catch (...) {}
        return ready();
    }
};
}  // namespace keyma

#include <keyma/client.hpp>
#include <keyma/server.hpp>

#include <cassert>
#include <format>
#include <memory_resource>
#include <span>
#include <string_view>

using namespace keyma;

struct FutAdapter : KeymaDatabaseAdapter<std::future> {
    std::pmr::monotonic_buffer_resource* pool;
    std::pmr::vector<Value> rows;
    long seq = 0;
    explicit FutAdapter(std::pmr::monotonic_buffer_resource* p) : pool(p), rows(alloc_t{p}) {}
    alloc_t a() { return alloc_t{pool}; }
    static bool matches(const Value& r, const Value& w) {
        if (!w.is_object()) return true;
        for (const Value::Member& m : w.as_object()) {
            const Value* fv = r.find(m.key);
            if (!fv || !(*fv == m.value)) return false;
        }
        return true;
    }
    std::future<void> ensure_schema(const SchemaMeta&) override { return async_traits<std::future>::ready(); }
    std::future<Value> create(const SchemaMeta& s, Value d, AdapterProjection) override {
        if (d.find("id") == nullptr)
            d.set("id", to_value(std::pmr::string(std::format("{}-{}", s.name, ++seq), a()), a()));
        rows.push_back(Value(d, a()));
        return async_traits<std::future>::ready(std::move(d));
    }
    std::future<Value> read(const SchemaMeta&, Value w, AdapterProjection) override {
        for (const Value& r : rows) if (matches(r, w)) return async_traits<std::future>::ready(Value(r, a()));
        return async_traits<std::future>::ready(Value(nullptr, a()));
    }
    std::future<std::pmr::vector<Value>> list(const SchemaMeta&, ListQuery q) override {
        std::pmr::vector<Value> out(a());
        for (const Value& r : rows) if (matches(r, q.where)) out.push_back(Value(r, a()));
        return async_traits<std::future>::ready(std::move(out));
    }
    std::future<Value> update(const SchemaMeta&, Value w, Value d, AdapterProjection) override {
        for (Value& r : rows) if (matches(r, w)) {
            for (const Value::Member& m : d.as_object()) r.set(m.key, Value(m.value, a()));
            return async_traits<std::future>::ready(Value(r, a()));
        }
        throw KeymaRuntimeError("NOT_FOUND", "nf");
    }
    std::future<void> del(const SchemaMeta&, Value w) override {
        for (std::size_t i = 0; i < rows.size(); ++i) if (matches(rows[i], w)) { rows.erase(rows.begin() + static_cast<long>(i)); break; }
        return async_traits<std::future>::ready();
    }
    std::future<std::int64_t> count(const SchemaMeta&, Value w) override {
        long n = 0;
        for (const Value& r : rows) if (matches(r, w)) ++n;
        return async_traits<std::future>::ready(static_cast<std::int64_t>(n));
    }
};

int main() {
    std::pmr::monotonic_buffer_resource pool;
    alloc_t a{&pool};
    static const FieldMeta fields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id},
        FieldMeta{.name = "name", .type = TypeTag::String},
    };
    static const SchemaMeta user{.name = "user", .source_name = "User", .fields = std::span<const FieldMeta>(fields)};
    const SchemaMeta* schemas[] = {&user};

    static std::pmr::monotonic_buffer_resource adapter_pool;
    FutAdapter adapter(&adapter_pool);
    KeymaServer<std::future> server(KeymaServer<std::future>::Options{
        .schemas = std::span<const SchemaMeta* const>(schemas),
        .adapter = &adapter,
        .alloc = a,
    });
    server.ensure_schemas().get();
    Transport<std::future> tx = create_direct_transport<std::future>(server);

    // Drive a create then a read through the future policy.
    Value data = Value::object(a);
    data.set("name", Value(std::string_view("Grace"), a));
    Document<std::future> doc(a);
    doc.add("c", Keyma::create("user", std::move(data), Value{}, a));
    Value resp = doc.request(tx).get();
    assert(proto::leaf_ok(resp.at("results").at("c")));
    assert(resp.at("results").at("c").at("data").at("name").as_string() == "Grace");

    std::int64_t n = count_to<std::future>(tx, "user", Value{}, a).get();
    assert(n == 1);
    return 0;
}
