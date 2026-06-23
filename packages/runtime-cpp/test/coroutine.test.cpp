// Proves the Async<> policy works with a GENUINELY DEFERRED C++23 coroutine task — not a
// blocking shim. It supplies:
//   * co::task<T>     — a lazy, single-consumer coroutine task (promise_type, symmetric
//                       transfer, exception capture), the kind cppcoro/folly ship;
//   * co::RunLoop     — a trivial single-threaded scheduler (a FIFO of ready handles);
//   * co::yield_to_loop — an awaitable that suspends and reschedules itself on the loop,
//                       standing in for async I/O completing "later";
//   * keyma::async_traits<co::task> — the policy that plugs it into the runtime.
// The in-memory adapter's every operation `co_await`s the loop (so it really suspends), and
// the test drives a full KeymaServer<co::task> CRUD round-trip — including a multi-op batch,
// which exercises the per-operation fold resuming across suspension. It also shows the
// ergonomic `co_await` form via a driver coroutine.
//
// Build/run by scripts/cpp-test.sh, and additionally under -fsanitize=address to catch any
// dangling reference across a suspension point.

#include <keyma/async.hpp>

#include <coroutine>
#include <cstdint>
#include <deque>
#include <exception>
#include <type_traits>
#include <utility>
#include <variant>

// ─────────────────────────── A lazy coroutine task + run loop ───────────────────────────
namespace co {

struct RunLoop {
    std::deque<std::coroutine_handle<>> ready;
    void schedule(std::coroutine_handle<> h) { ready.push_back(h); }
    void run() {
        while (!ready.empty()) {
            std::coroutine_handle<> h = ready.front();
            ready.pop_front();
            h.resume();
        }
    }
};

// Suspend the current coroutine and reschedule it on the loop — simulates async I/O.
struct yield_to_loop {
    RunLoop* loop;
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) const noexcept { loop->schedule(h); }
    void await_resume() const noexcept {}
};

template <class T> class task;

template <class T>
struct task_promise {
    std::variant<std::monostate, T, std::exception_ptr> value;
    std::coroutine_handle<> continuation = nullptr;

    task<T> get_return_object() noexcept;
    std::suspend_always initial_suspend() noexcept { return {}; }
    struct final_awaiter {
        bool await_ready() const noexcept { return false; }
        std::coroutine_handle<> await_suspend(std::coroutine_handle<task_promise> h) const noexcept {
            std::coroutine_handle<> c = h.promise().continuation;
            return c ? c : std::noop_coroutine();
        }
        void await_resume() const noexcept {}
    };
    final_awaiter final_suspend() noexcept { return {}; }
    template <class U> void return_value(U&& u) { value.template emplace<1>(std::forward<U>(u)); }
    void unhandled_exception() { value.template emplace<2>(std::current_exception()); }
    T result() {
        if (value.index() == 2) std::rethrow_exception(std::get<2>(value));
        return std::move(std::get<1>(value));
    }
};

template <>
struct task_promise<void> {
    std::exception_ptr eptr;
    std::coroutine_handle<> continuation = nullptr;

    task<void> get_return_object() noexcept;
    std::suspend_always initial_suspend() noexcept { return {}; }
    struct final_awaiter {
        bool await_ready() const noexcept { return false; }
        std::coroutine_handle<> await_suspend(std::coroutine_handle<task_promise> h) const noexcept {
            std::coroutine_handle<> c = h.promise().continuation;
            return c ? c : std::noop_coroutine();
        }
        void await_resume() const noexcept {}
    };
    final_awaiter final_suspend() noexcept { return {}; }
    void return_void() {}
    void unhandled_exception() { eptr = std::current_exception(); }
    void result() { if (eptr) std::rethrow_exception(eptr); }
};

template <class T>
class task {
public:
    using promise_type = task_promise<T>;
    using handle = std::coroutine_handle<promise_type>;

    task() noexcept = default;
    explicit task(handle h) noexcept : h_(h) {}
    task(task&& o) noexcept : h_(std::exchange(o.h_, {})) {}
    task& operator=(task&& o) noexcept {
        if (this != &o) { if (h_) h_.destroy(); h_ = std::exchange(o.h_, {}); }
        return *this;
    }
    task(const task&) = delete;
    task& operator=(const task&) = delete;
    ~task() { if (h_) h_.destroy(); }

    struct awaiter {
        handle h;
        bool await_ready() const noexcept { return !h || h.done(); }
        std::coroutine_handle<> await_suspend(std::coroutine_handle<> cont) noexcept {
            h.promise().continuation = cont;
            return h;  // symmetric transfer — start the awaited task
        }
        T await_resume() { return h.promise().result(); }
    };
    awaiter operator co_await() && noexcept { return awaiter{h_}; }

    // Driving (root): start from the initial suspend.
    void start() { if (h_ && !h_.done()) h_.resume(); }
    T take() { return h_.promise().result(); }

private:
    handle h_{};
};

template <class T>
inline task<T> task_promise<T>::get_return_object() noexcept {
    return task<T>{std::coroutine_handle<task_promise>::from_promise(*this)};
}
inline task<void> task_promise<void>::get_return_object() noexcept {
    return task<void>{std::coroutine_handle<task_promise>::from_promise(*this)};
}

// Drive a root task to completion on the loop and return its result (rethrowing on error).
template <class T>
T sync_wait(task<T> t, RunLoop& loop) {
    t.start();
    loop.run();
    if constexpr (std::is_void_v<T>) (void)t.take();
    else return t.take();
}

}  // namespace co

// ─────────────────────────── Plug co::task into the runtime ─────────────────────────────
namespace keyma {
template <class U> struct is_async<co::task<U>> : std::true_type {};
template <class U> struct payload<co::task<U>> { using type = U; };

// then's value type: U for f->U, void for f->void, payload for f->task<U> (flatten).
template <class R, bool = is_async_v<R>>
struct co_then_value { using type = std::conditional_t<std::is_void_v<R>, void, R>; };
template <class R>
struct co_then_value<R, true> { using type = payload_t<R>; };
template <class R> using co_then_value_t = typename co_then_value<R>::type;

template <>
struct async_traits<co::task> {
    // ready takes its value BY VALUE: a lazy coroutine's body runs after its caller's
    // full-expression ends, so a by-reference parameter would dangle (the argument
    // temporary is already gone). By value, the coroutine frame owns the value.
    template <class T>
    static co::task<T> ready(T v) { co_return std::move(v); }
    static co::task<void> ready() { co_return; }

    // then: bind via explicit locals (no nested co_await in one expression) so every
    // intermediate task/value has a named lifetime spanning its suspension.
    template <class T, class F>
    static auto then(co::task<T> m, F f) -> co::task<co_then_value_t<std::invoke_result_t<F, T&&>>> {
        using R = std::invoke_result_t<F, T&&>;
        if constexpr (is_async_v<R>) {
            T v = co_await std::move(m);
            R next = std::move(f)(std::move(v));
            co_return co_await std::move(next);
        } else if constexpr (std::is_void_v<R>) {
            T v = co_await std::move(m);
            std::move(f)(std::move(v));
            co_return;
        } else {
            T v = co_await std::move(m);
            co_return std::move(f)(std::move(v));
        }
    }
    template <class F>
    static auto then(co::task<void> m, F f) -> co::task<co_then_value_t<std::invoke_result_t<F>>> {
        using R = std::invoke_result_t<F>;
        co_await std::move(m);
        if constexpr (is_async_v<R>) {
            R next = std::move(f)();
            co_return co_await std::move(next);
        } else if constexpr (std::is_void_v<R>) {
            std::move(f)();
            co_return;
        } else {
            co_return std::move(f)();
        }
    }

    template <class Thunk, class OnError>
    static auto attempt(Thunk thunk, OnError on_error)
        -> co::task<payload_t<std::invoke_result_t<Thunk>>> {
        try {
            co_return co_await thunk();
        } catch (...) {
            co_return on_error(std::current_exception());
        }
    }
    template <class Thunk>
    static co::task<void> swallow(Thunk thunk) {
        try { co_await thunk(); } catch (...) {}
        co_return;
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

// A test-only in-memory adapter whose every operation genuinely SUSPENDS (co_await the loop)
// before doing its work — so the whole server chain is driven across real suspension points.
struct CoroAdapter : KeymaDatabaseAdapter<co::task> {
    co::RunLoop* loop;
    std::pmr::monotonic_buffer_resource* pool;
    std::pmr::vector<Value> rows;
    long seq = 0;
    CoroAdapter(co::RunLoop* l, std::pmr::monotonic_buffer_resource* p)
        : loop(l), pool(p), rows(alloc_t{p}) {}
    alloc_t a() { return alloc_t{pool}; }
    static bool matches(const Value& r, const Value& w) {
        if (!w.is_object()) return true;
        for (const Value::Member& m : w.as_object()) {
            const Value* fv = r.find(m.key);
            if (!fv || !(*fv == m.value)) return false;
        }
        return true;
    }
    co::task<void> ensure_schema(const SchemaMeta&) override { co_await co::yield_to_loop{loop}; co_return; }
    co::task<Value> create(const SchemaMeta& s, Value data, AdapterProjection) override {
        co_await co::yield_to_loop{loop};
        if (data.find("id") == nullptr)
            data.set("id", to_value(std::pmr::string(std::format("{}-{}", s.name, ++seq), a()), a()));
        rows.push_back(Value(data, a()));
        co_return std::move(data);
    }
    co::task<Value> read(const SchemaMeta&, Value w, AdapterProjection) override {
        co_await co::yield_to_loop{loop};
        for (const Value& r : rows) if (matches(r, w)) co_return Value(r, a());
        co_return Value(nullptr, a());
    }
    co::task<std::pmr::vector<Value>> list(const SchemaMeta&, ListQuery q) override {
        co_await co::yield_to_loop{loop};
        std::pmr::vector<Value> out(a());
        for (const Value& r : rows) if (matches(r, q.where)) out.push_back(Value(r, a()));
        co_return std::move(out);
    }
    co::task<Value> update(const SchemaMeta&, Value w, Value d, AdapterProjection) override {
        co_await co::yield_to_loop{loop};
        for (Value& r : rows) if (matches(r, w)) {
            for (const Value::Member& m : d.as_object()) r.set(m.key, Value(m.value, a()));
            co_return Value(r, a());
        }
        throw KeymaRuntimeError("NOT_FOUND", "not found");
    }
    co::task<void> del(const SchemaMeta&, Value w) override {
        co_await co::yield_to_loop{loop};
        for (std::size_t i = 0; i < rows.size(); ++i)
            if (matches(rows[i], w)) { rows.erase(rows.begin() + static_cast<long>(i)); break; }
        co_return;
    }
    co::task<std::int64_t> count(const SchemaMeta&, Value w) override {
        co_await co::yield_to_loop{loop};
        long n = 0;
        for (const Value& r : rows) if (matches(r, w)) ++n;
        co_return static_cast<std::int64_t>(n);
    }
};

// A plugin with a genuinely async (suspending) hook, to drive the hook folds across suspension.
struct AsyncPlugin : KeymaServerPlugin<co::task> {
    co::RunLoop* loop;
    int* after;
    AsyncPlugin(co::RunLoop* l, int* c) : loop(l), after(c) {}
    std::string_view name() const override { return "async"; }
    bool has_after_operation() const override { return true; }
    co::task<void> after_operation(const RequestContext&, const Value&, const Value& result) override {
        co_await co::yield_to_loop{loop};   // suspend BEFORE reading `result` — exercises the
        if (proto::leaf_ok(result)) ++*after;  // server's afterOperation result-snapshot fix
        co_return;
    }
};

namespace app {
struct User {
    using allocator_type = alloc_t;
    std::pmr::string id, name;
    User() = default;
    explicit User(const allocator_type& al) : id(al), name(al) {}
    User(const User& o, const allocator_type& al) : id(o.id, al), name(o.name, al) {}
    User(User&& o, const allocator_type& al) : id(std::move(o.id), al), name(std::move(o.name), al) {}
    User(const User&) = default;
    User(User&&) = default;
    User& operator=(const User&) = default;
    User& operator=(User&&) = default;
    allocator_type get_allocator() const noexcept { return id.get_allocator(); }
    static const SchemaMeta& schema();
};
}  // namespace app
template <>
struct keyma::value_traits<app::User> {
    using T = app::User;
    static T from_value(const Value& v, alloc_t a) {
        T o(a);
        if (v.is_object()) {
            o.id = keyma::from_value<std::pmr::string>(v.at("id"), a);
            o.name = keyma::from_value<std::pmr::string>(v.at("name"), a);
        }
        return o;
    }
    static Value to_value(const T& o, alloc_t a) {
        Value v = Value::object(a);
        v.set("id", keyma::to_value(o.id, a));
        v.set("name", keyma::to_value(o.name, a));
        return v;
    }
};
namespace app {
const SchemaMeta& User::schema() {
    static const FieldMeta fields[] = {
        FieldMeta{.name = "id", .type = TypeTag::Id},
        FieldMeta{.name = "name", .type = TypeTag::String},
    };
    static const SchemaMeta m{.name = "user", .source_name = "User", .fields = std::span<const FieldMeta>(fields)};
    return m;
}
}  // namespace app

// A driver coroutine demonstrating the ergonomic `co_await` form end to end.
static co::task<std::pmr::string> scenario(Transport<co::task>& tx, alloc_t a) {
    Value data = Value::object(a);
    data.set("name", Value(std::string_view("Lin"), a));
    app::User created = co_await create_as<app::User, co::task>(tx, std::move(data), Value{}, a);
    Value where = Value::object(a);
    where.set("id", Value(std::string_view(created.id), a));
    std::optional<app::User> got = co_await read_as<app::User, co::task>(tx, std::move(where), Value{}, a);
    co_return got.has_value() ? got->name : std::pmr::string("<none>", a);
}

int main() {
    std::pmr::monotonic_buffer_resource pool;
    alloc_t a{&pool};
    co::RunLoop loop;
    static std::pmr::monotonic_buffer_resource adapter_pool;

    const SchemaMeta* schemas[] = {&app::User::schema()};
    CoroAdapter adapter(&loop, &adapter_pool);
    int after = 0;
    AsyncPlugin plugin(&loop, &after);
    KeymaServerPlugin<co::task>* plugins[] = {&plugin};

    KeymaServer<co::task> server(KeymaServer<co::task>::Options{
        .schemas = std::span<const SchemaMeta* const>(schemas),
        .adapter = &adapter,
        .plugins = std::span<KeymaServerPlugin<co::task>* const>(plugins),
        .alloc = a,
    });
    co::sync_wait(server.ensure_schemas(), loop);
    Transport<co::task> tx = create_direct_transport<co::task>(server);

    // 1) Ergonomic co_await driver: create then read, all genuinely suspending.
    std::pmr::string name = co::sync_wait(scenario(tx, a), loop);
    assert(name == "Lin");

    // 2) Typed list after another create.
    Value d2 = Value::object(a);
    d2.set("name", Value(std::string_view("Mara"), a));
    app::User u2 = co::sync_wait(create_as<app::User, co::task>(tx, std::move(d2), Value{}, a), loop);
    assert(u2.name == "Mara" && !u2.id.empty());
    auto all = co::sync_wait(list_as<app::User, co::task>(tx, Value{}, Value{}, a), loop);
    assert(all.size() == 2);

    // 3) Multi-op batched document — the per-operation fold resumes across suspension.
    Document<co::task> doc(a);
    doc.add("n", Keyma::count("user", Value{}, a));
    Value byName = Value::object(a);
    byName.set("name", Value(std::string_view("Lin"), a));
    doc.add("one", Keyma::read("user", std::move(byName), Value{}, a));
    Value resp = co::sync_wait(doc.request(tx), loop);
    assert(resp.at("results").at("n").at("data").as_int() == 2);
    assert(resp.at("results").at("one").at("data").at("name").as_string() == "Lin");

    // 4) Error path still surfaces through the coroutine chain.
    Value ghost = co::sync_wait(server.handle(proto::request([&] {
        Value ops = Value::object(a);
        Value w = Value::object(a);
        w.set("id", Value(std::string_view("nope"), a));
        ops.set("g", proto::read_op("ghost", w, Value{}, a));
        return ops;
    }(), a)), loop);
    assert(proto::leaf_code(ghost.at("results").at("g")) == "SCHEMA_NOT_FOUND");

    // afterOperation (a suspending hook that reads the result after its own suspension)
    // counted every OK op: create+read (scenario), create (Mara), list, count+read (batch).
    // The ghost op errored, so it is not counted.
    assert(after == 6);
    return 0;
}
