#pragma once

// Concrete C++23 async core for @keyma/runtime-cpp — the heavy lift of the RPC rewrite. It
// replaces the old `Async<>` policy monad (`async_traits`/`Sync`/`seq_fold`) with a real,
// promoted coroutine machine:
//
//   * keyma::task<T>           — a lazy, single-consumer coroutine task (promise_type, symmetric
//                                transfer, exception capture). The kind cppcoro/folly ship; this
//                                is the type every RPC-surface function returns.
//   * keyma::scheduler         — an UNPARAMETERIZED concept: a `schedule_return_type` typedef +
//                                `s.schedule(handle, schedule_op_result<schedule_return_type>*)`.
//   * keyma::DelayedScheduler  — refines `scheduler` with `schedule_after(handle, milliseconds)`.
//   * keyma::schedule_op_result<T> — the awaitable result bridge for a deferred scheduler op.
//   * keyma::schedule_op / schedule_on(s) — an I/O-leaf awaitable: suspend, hand the handle to
//                                the scheduler, resume later (stands in for async I/O completing).
//   * keyma::event_loop        — a pmr-allocated single-threaded reference scheduler satisfying
//                                both concepts (schedule / schedule_after / process / flush /
//                                has_immediate_work); `flush()` runs in the destructor.
//   * keyma::sync_wait(task)   — drive a root task to completion (inline, or on an event_loop).
//
// The RPC surface is SCHEDULER-AGNOSTIC: client / host / transport speak only `keyma::task<...>`,
// never naming a scheduler. A concrete async transport holds its own `event_loop` and binds to it
// at its I/O-leaf awaitables (`schedule` / `schedule_op_result<T>`). Tasks carry the value `<T>`;
// the scheduler is value-type-agnostic.

#include <algorithm>
#include <chrono>
#include <coroutine>
#include <cstddef>
#include <deque>
#include <exception>
#include <limits>
#include <memory_resource>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace keyma {

// ─────────────────────────────── task<T> (lazy coroutine) ───────────────────────────────────

template <class T> class task;

template <class T>
struct task_promise {
    // monostate (pending) | T (value) | exception_ptr (failure). Captures an exception INTO the
    // task so a throw never unwinds out of a continuation running after its caller returned.
    std::variant<std::monostate, T, std::exception_ptr> value;
    std::coroutine_handle<> continuation = nullptr;

    task<T> get_return_object() noexcept;
    std::suspend_always initial_suspend() noexcept { return {}; }  // lazy: nothing runs until awaited
    struct final_awaiter {
        bool await_ready() const noexcept { return false; }
        // Symmetric transfer: on completion, resume the awaiting coroutine (or noop if root).
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
    using value_type = T;
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

    bool valid() const noexcept { return static_cast<bool>(h_); }
    bool done() const noexcept { return h_ && h_.done(); }

    // co_await on an rvalue task: start the awaited task (symmetric transfer) and resume the
    // awaiter when it completes.
    struct awaiter {
        handle h;
        bool await_ready() const noexcept { return !h || h.done(); }
        std::coroutine_handle<> await_suspend(std::coroutine_handle<> cont) noexcept {
            h.promise().continuation = cont;
            return h;  // symmetric transfer — begin the awaited task
        }
        T await_resume() { return h.promise().result(); }
    };
    awaiter operator co_await() && noexcept { return awaiter{h_}; }

    // Root driving: resume from the initial suspend.
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

// ──────────────────────────── scheduler concept + result bridge ─────────────────────────────

// schedule_op_result<T>: the result slot + completion bridge a deferred scheduler op fills. An
// I/O-leaf awaitable owns one; the scheduler resumes the awaiting coroutine, after which the
// awaiter's await_resume() reads the (possibly exceptional) result out of the slot. For a
// value-less leaf (the common "resume me later" case) `T` is void and the slot only carries an
// optional error.
template <class T>
struct schedule_op_result {
    std::variant<std::monostate, T, std::exception_ptr> slot{};
    void set_value(T v) { slot.template emplace<1>(std::move(v)); }
    void set_error(std::exception_ptr e) { slot.template emplace<2>(std::move(e)); }
    T result() {
        if (slot.index() == 2) std::rethrow_exception(std::get<2>(slot));
        return std::move(std::get<1>(slot));
    }
};
template <>
struct schedule_op_result<void> {
    std::exception_ptr error{};
    void set_error(std::exception_ptr e) { error = std::move(e); }
    void result() { if (error) std::rethrow_exception(error); }
};

// scheduler: a value-type-agnostic executor. It publishes the value type its ops bridge through
// (`schedule_return_type`) and accepts a coroutine handle + a result-slot pointer to resume.
template <class S>
concept scheduler = requires(S& s, std::coroutine_handle<> h,
                             schedule_op_result<typename S::schedule_return_type>* r) {
    typename S::schedule_return_type;
    { s.schedule(h, r) };
};

// DelayedScheduler: a scheduler that can also defer a resume by a wall-clock delay.
template <class S>
concept DelayedScheduler = scheduler<S> && requires(S& s, std::coroutine_handle<> h,
                                                     std::chrono::milliseconds d) {
    { s.schedule_after(h, d) };
};

// schedule_op<S>: the I/O-leaf awaitable. `co_await schedule_on(loop)` suspends the current
// coroutine and hands its handle to `S` (which resumes it later) — the suspension point a real
// async transport binds its I/O completion to.
template <class S>
struct schedule_op {
    S* sched;
    schedule_op_result<typename S::schedule_return_type> slot{};
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) { sched->schedule(h, &slot); }
    auto await_resume() { return slot.result(); }
};
template <class S>
schedule_op<S> schedule_on(S& s) { return schedule_op<S>{&s}; }

// ──────────────────────────────────── event_loop ───────────────────────────────────────────

// The provided single-threaded reference scheduler. pmr-allocated, satisfies `scheduler` +
// `DelayedScheduler`. Immediate work is a FIFO of ready handles; delayed work is a min-heap keyed
// on a LOGICAL clock that `flush()` advances (so tests never sleep). `flush()` runs in the dtor.
class event_loop {
public:
    using schedule_return_type = void;
    using alloc_t = std::pmr::polymorphic_allocator<std::byte>;

    explicit event_loop(const alloc_t& a = {}) : ready_(a), timers_(a) {}
    event_loop(const event_loop&) = delete;
    event_loop& operator=(const event_loop&) = delete;
    ~event_loop() { flush(); }

    // scheduler: resume `h` on the next tick. The result slot is unused (a value-less resume).
    void schedule(std::coroutine_handle<> h, schedule_op_result<void>* = nullptr) {
        ready_.push_back(h);
    }
    // DelayedScheduler: resume `h` once the logical clock reaches now + delay.
    void schedule_after(std::coroutine_handle<> h, std::chrono::milliseconds delay) {
        timers_.push_back(timer{now_ + delay, h});
        std::push_heap(timers_.begin(), timers_.end(), later);
    }

    bool has_immediate_work() const noexcept { return !ready_.empty(); }

    // A bounded tick: promote any due timers, then run up to `max` ready handles. Returns the
    // number of handles resumed.
    std::size_t process(std::size_t max = (std::numeric_limits<std::size_t>::max)()) {
        promote_due();
        std::size_t n = 0;
        while (n < max && !ready_.empty()) {
            std::coroutine_handle<> h = ready_.front();
            ready_.pop_front();
            h.resume();
            ++n;
            promote_due();
        }
        return n;
    }

    // Drain everything to quiescence, advancing the logical clock past pending timers.
    void flush() {
        while (!ready_.empty() || !timers_.empty()) {
            if (ready_.empty()) advance_to_next_timer();
            process();
        }
    }

private:
    using clock = std::chrono::steady_clock;
    struct timer {
        clock::time_point due;
        std::coroutine_handle<> h;
    };
    // Min-heap on `due` (std::*_heap are max-heaps, so invert the comparator).
    static bool later(const timer& a, const timer& b) noexcept { return a.due > b.due; }

    void promote_due() {
        while (!timers_.empty() && timers_.front().due <= now_) {
            std::pop_heap(timers_.begin(), timers_.end(), later);
            ready_.push_back(timers_.back().h);
            timers_.pop_back();
        }
    }
    void advance_to_next_timer() {
        if (timers_.empty()) return;
        now_ = timers_.front().due;
        promote_due();
    }

    std::pmr::deque<std::coroutine_handle<>> ready_;
    std::pmr::vector<timer> timers_;
    clock::time_point now_ = clock::now();
};

static_assert(scheduler<event_loop>);
static_assert(DelayedScheduler<event_loop>);

// ───────────────────────────────────── sync_wait ───────────────────────────────────────────

// Drive a root task to completion INLINE (the synchronous path — e.g. the inline-completing
// direct transport). The task must not suspend on an external scheduler; if it does this returns
// before completion and `take()` is ill-formed. Use the event_loop overload for deferred tasks.
template <class T>
T sync_wait(task<T> t) {
    t.start();
    if constexpr (std::is_void_v<T>) (void)t.take();
    else return t.take();
}

// Drive a root task to completion ON an event_loop: start it (runs to its first I/O-leaf
// suspension), then drain the loop, then read the result.
template <class T>
T sync_wait(task<T> t, event_loop& loop) {
    t.start();
    loop.flush();
    if constexpr (std::is_void_v<T>) (void)t.take();
    else return t.take();
}

}  // namespace keyma
