#pragma once

// Async policy core (@keyma/runtime-cpp). The runtime's I/O-bearing interfaces
// (adapter, plugin, transport, service, server) are templated on a policy
// `template<class> class Async`, defaulting to `keyma::Sync` (an identity wrapper).
// With Async=Sync everything is synchronous and zero-overhead; the whole server/client
// is written once against the `async_traits<Async>` customization point below.
//
// Bring your own scheduler: to run on std::future or a coroutine task, specialize
// `async_traits<YourAsync>` (and `is_async`/`payload` for it). For ANY non-Sync policy:
//   * `then` and `attempt`/`swallow` must capture exceptions INTO the resulting Async<T>
//     (the way std::future stores them), since a throw cannot unwind out of a deferred
//     continuation, and
//   * the policy is responsible for where continuations run — that is the scheduler the
//     runtime deliberately does not provide.
// This header is standalone (no <future>, no runtime.hpp); the std::future / task
// specializations live in user code.

#include <iterator>
#include <type_traits>
#include <utility>

namespace keyma {

// ── Sync: the identity policy. Sync<T> holds a T by value. ────────────────────────────
template <class T>
struct Sync {
    T value;
    const T& get() const& noexcept { return value; }
    T&& get() && noexcept { return std::move(value); }
};
template <>
struct Sync<void> {};

// is_async<X>: true when X is some Async<U>. Lets `then` flatten an `f` that already
// returns an Async<U> (mirrors JS `await` over a value-or-promise). Each policy adds a
// partial specialization for its own template.
template <class> struct is_async : std::false_type {};
template <class U> struct is_async<Sync<U>> : std::true_type {};
template <class X> inline constexpr bool is_async_v = is_async<std::remove_cvref_t<X>>::value;

// payload<Async<U>>::type == U.
template <class> struct payload;
template <class U> struct payload<Sync<U>> { using type = U; };
template <class X> using payload_t = typename payload<std::remove_cvref_t<X>>::type;

// ── Customization point. Primary is undefined: a missing specialization fails loudly. ──
template <template <class> class Async>
struct async_traits;

template <>
struct async_traits<Sync> {
    template <class T>
    static Sync<std::remove_cvref_t<T>> ready(T&& v) {
        return Sync<std::remove_cvref_t<T>>{std::forward<T>(v)};
    }
    static Sync<void> ready() { return Sync<void>{}; }

    // then(Sync<T>, f): f(T)->U ⇒ Sync<U>; f(T)->Sync<U> ⇒ Sync<U> (flattened); f(T)->void ⇒ Sync<void>.
    template <class T, class F>
    static auto then(Sync<T>&& m, F&& f) {
        using R = std::invoke_result_t<F, T&&>;
        if constexpr (is_async_v<R>) return std::forward<F>(f)(std::move(m.value));
        else if constexpr (std::is_void_v<R>) { std::forward<F>(f)(std::move(m.value)); return Sync<void>{}; }
        else return Sync<std::remove_cvref_t<R>>{std::forward<F>(f)(std::move(m.value))};
    }
    // then(Sync<void>, f): f()->U|Sync<U>|void.
    template <class F>
    static auto then(Sync<void>&&, F&& f) {
        using R = std::invoke_result_t<F>;
        if constexpr (is_async_v<R>) return std::forward<F>(f)();
        else if constexpr (std::is_void_v<R>) { std::forward<F>(f)(); return Sync<void>{}; }
        else return Sync<std::remove_cvref_t<R>>{std::forward<F>(f)()};
    }

    // attempt(thunk, on_error): run `thunk` (a () -> Sync<T> producer) under a guard; map
    // any thrown exception to on_error(exception_ptr) -> T. The producer is wrapped (not a
    // ready value) so the try actually guards execution — for Sync the work is eager.
    template <class Thunk, class OnError>
    static auto attempt(Thunk&& thunk, OnError&& on_error) {
        using T = payload_t<std::invoke_result_t<Thunk>>;
        try {
            return std::forward<Thunk>(thunk)();
        } catch (...) {
            return Sync<T>{std::forward<OnError>(on_error)(std::current_exception())};
        }
    }

    // swallow(thunk): run `thunk` (a () -> Sync<void> producer), discarding any exception.
    template <class Thunk>
    static Sync<void> swallow(Thunk&& thunk) {
        try {
            (void)std::forward<Thunk>(thunk)();
        } catch (...) {
        }
        return Sync<void>{};
    }
};

// ── Combinators (policy-generic, built on async_traits<Async>) ─────────────────────────

// Sequential async fold: thread `init` through `step` for each item in order, returning
// Async<Acc>. The workhorse for the plugin-hook folds and the per-operation loop in the
// server — both sequential async loops with an accumulator. `step` is (Acc, const Item&)
// -> Async<Acc>. Contract: the [first,last) range must outlive the returned Async (the
// step is invoked synchronously per item, so the item is read before any deferral).
template <template <class> class Async, class It, class Acc, class Step>
auto seq_fold(It first, It last, Acc init, Step step)
    -> decltype(async_traits<Async>::ready(std::declval<Acc>())) {
    using AT = async_traits<Async>;
    if (first == last) return AT::ready(std::move(init));
    auto stepped = step(std::move(init), *first);  // Async<Acc>
    return AT::then(std::move(stepped), [first, last, step = std::move(step)](Acc acc) mutable {
        return seq_fold<Async>(std::next(first), last, std::move(acc), std::move(step));
    });
}

// Free wrappers so call sites read uniformly without naming async_traits.
template <template <class> class Async, class Thunk, class OnError>
auto async_attempt(Thunk&& thunk, OnError&& on_error) {
    return async_traits<Async>::attempt(std::forward<Thunk>(thunk), std::forward<OnError>(on_error));
}
template <template <class> class Async, class Thunk>
auto async_swallow(Thunk&& thunk) {
    return async_traits<Async>::swallow(std::forward<Thunk>(thunk));
}

// Extract the value from a Sync<T> (tests, and the synchronous transport entrypoint).
template <class T>
T sync_get(Sync<T>&& m) { return std::move(m).get(); }
template <class T>
const T& sync_get(const Sync<T>& m) { return m.get(); }
inline void sync_get(Sync<void>&&) {}

}  // namespace keyma
