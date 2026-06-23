#pragma once

// Concepts for @keyma/runtime-cpp — pure compile-time guards over the template
// parameters the client/query-builder layer already uses. They change no runtime
// behaviour and touch none of the erased internals; they exist to turn the
// "missing value_traits / schema() / async_traits specialization" deep template
// errors into readable, named diagnostics at the call site.
//
// This header is consumed only by the hand-written client headers (client.hpp /
// query.hpp), never by generated model code, so it is NOT part of the runtime-header
// baking/vendoring pipeline (only runtime.hpp is baked).

#include <keyma/async.hpp>
#include <keyma/runtime.hpp>

#include <concepts>
#include <exception>
#include <type_traits>
#include <utility>

namespace keyma {

// A type the runtime can serialize: its keyma::value_traits<T> is a complete
// specialization providing from_value / to_value. The primary value_traits template
// is declared-but-undefined, so an unspecialized T fails this requirement cleanly
// (rather than hard-erroring on an incomplete type at the use site).
template <class T>
concept Serializable = requires(const Value& v, const T& x, alloc_t a) {
    { value_traits<T>::from_value(v, a) } -> std::same_as<T>;
    { value_traits<T>::to_value(x, a) } -> std::same_as<Value>;
};

// A generated Keyma record: serializable AND exposing its schema metadata. This is
// what the typed Keyma::*<T> builders and *_as<T> helpers should constrain on, so a
// non-record T (a scalar, or a struct without schema()) is rejected by name.
template <class T>
concept KeymaRecord = Serializable<T> && requires {
    { T::schema() } -> std::convertible_to<const SchemaMeta&>;
};

// A valid async policy: async_traits<Async> provides the four operations the runtime
// is written against (ready / then / attempt / swallow). The primary async_traits
// template is undefined (async.hpp), so a missing specialization fails this concept
// with a named requirement instead of an opaque instantiation error. The default
// Sync policy and the test std::future / coroutine-task policies all satisfy it.
template <template <class> class Async>
concept AsyncPolicy =
    requires {
        { async_traits<Async>::ready() } -> std::same_as<Async<void>>;
    } &&
    requires(Async<int> m, Async<void> mv) {
        { async_traits<Async>::ready(0) } -> std::same_as<Async<int>>;
        async_traits<Async>::then(std::move(m), [](int) { return 0; });
        async_traits<Async>::then(std::move(mv), [] { return 0; });
        async_traits<Async>::attempt([] { return async_traits<Async>::ready(0); },
                                     [](std::exception_ptr) { return 0; });
        async_traits<Async>::swallow([] { return async_traits<Async>::ready(); });
    };

}  // namespace keyma
