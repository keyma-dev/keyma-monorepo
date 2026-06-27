# @keyma/runtime-cpp

The C++23 header-only runtime consumed by Keyma-generated C++ models. It is the C++
counterpart of `@keyma/runtime-js` and `keyma-runtime` (Python).

It ships a single **umbrella** header — `include/keyma/runtime.hpp` — which is the **single
source of truth** for the C++ runtime: a generated header `#include <keyma/runtime.hpp>` and
nothing else external. Its dependency-free core provides:

- `keyma::Value` — the dynamic, allocator-aware (`std::pmr`) value type used at the
  validator/formatter/defaults boundary and for `json` fields.
- The validation/formatting result types and callable typedefs (`keyma::ValidatorFn`,
  `keyma::FormatterFn`, `keyma::ValidationError`, `keyma::Context`).
- The schema-metadata structs (`keyma::ClassMetadata`, `keyma::FieldMeta`, …) and
  `keyma::Field<T>` for two-axis (optional × nullable) fields.
- The intrinsic helpers the expression lowering emits (string/array/date/regex ops,
  `keyma::to_string<E>` / `keyma::from_string<E>` enum conversions).
- The **serialization layer**: `keyma::value_traits<T>`, `keyma::from_value<T>` and
  `keyma::to_value<T>`. Generated model structs specialize `value_traits<T>` (mapping
  each field name to a member); the runtime owns all per-field coercion.

## Runtime consumer layer

The umbrella pulls in the codec + RPC headers under `include/keyma/` (in dependency order),
so all of the below are reachable from `<keyma/runtime.hpp>` alone:

- `keyma/json.hpp` — a dependency-free JSON (de)serializer for `keyma::Value`:
  `json_parse(string_view, alloc_t)` / `json_stringify(const Value&, alloc_t)` (plus a
  pretty variant). Integral tokens become `int64`, fractional ones `double`; strings carry
  full escape/`\uXXXX`-surrogate handling; bytes serialize as base64.
- `keyma/binary.hpp` + `keyma/binary-typed.hpp` — the binary wire codec: a metadata-driven
  dynamic encoder/decoder and the allocation-free typed `binary_traits<T>` twin, both
  byte-identical to the JS/Python runtimes (the cross-runtime parity oracle).
- `keyma/serialize.hpp` — record serialize (visibility & ephemeral filtering) and
  `normalize_reference_ids`.
- `keyma/errors.hpp` — the slim RPC error model: `keyma::error { code, message }`,
  `keyma::result<T, E>` (an alias of `std::expected`), the frozen error-code taxonomy, and
  the lone surviving `KeymaRuntimeError` (the JSON parser's failure type).
- `keyma/async.hpp` — the concrete C++23 coroutine async core: `keyma::task<T>` (the type
  every RPC-surface function returns), the unparameterized `scheduler` / `DelayedScheduler`
  concepts, the pmr-allocated reference `keyma::event_loop`, and `keyma::sync_wait`.
- `keyma/transport.hpp` — the capability-flagged `keyma::transport` (`invoke(call_request)
  -> task<call_result>`; streaming reserved), the `wire_payload` envelope (a `keyma::Value`
  in JSON mode, a `ByteBuf` in binary mode), and the inline-completing `direct_transport`.
- `keyma/service.hpp` — the generated server base `keyma::service` (`meta()` + a generated
  `dispatch(method, payload, ctx, encoding, a)` switch) plus the service metadata structs.
- `keyma/client.hpp` — `keyma::client_invoke` and the `service_client` base a generated
  per-service client binds to a transport.
- `keyma/service_host.hpp` — the slim `keyma::service_host`: resolve + visibility-gate +
  inject `RequestContext` + dispatch, encoding-agnostic and validation-free.

### @Service RPC

The C++ backend emits, per `@Service`, a server base deriving `keyma::service` (the app
overrides its typed `keyma::task<Ret>` virtuals; the generated `dispatch` decodes args,
calls the override, encodes the result) and a typed client returning
`keyma::task<keyma::result<Ret, keyma::error>>` — no exception ever crosses the RPC
boundary. Args/results marshal through the same per-type codec the model serializer uses
(JSON: named-arg object + bare result; binary: positional payloads, no names). A
`keyma::service_host` resolves + visibility-gates the call; the `direct_transport` carries
the envelope in-process and completes inline.

> Note on wire format: a `dateTime` is an epoch-ms `int64` and a `bytes` is a base64 string
> on the wire — the canonical cross-runtime format the JS, Python, and C++ runtimes all share,
> so `serialize` passes both through unchanged with no conversion. (`keyma::to_iso8601` /
> `keyma::date_parse` are application-logic helpers backing the `date.toISOString()` /
> `new Date("…")` body intrinsics, not wire helpers.)

## Async core — coroutines, bring your own scheduler

C++23 has no standard event loop. Every RPC-surface function returns a lazy
`keyma::task<T>` (promise type, symmetric transfer, exception capture); the surface is
**scheduler-agnostic** — client / host / transport speak only `keyma::task<…>`, never naming
a scheduler. A concrete async transport binds its I/O-leaf awaitables to a scheduler
satisfying the unparameterized `keyma::scheduler` / `DelayedScheduler` concepts. The package
ships a pmr-allocated single-threaded reference `keyma::event_loop` (logical-clock timers, so
tests never sleep) and `keyma::sync_wait` to drive a root task inline or on a loop.
`async.hpp` documents the contract; `test/coroutine.test.cpp` exercises it and
`test/rpc.test.cpp` drives an end-to-end `@Service` call over a genuinely-suspending
transport on an `event_loop`.

```cpp
keyma::service_host host(a);
host.add(impl);                                    // impl extends the generated service base
keyma::direct_transport tx = keyma::create_direct_transport(host, keyma::encoding::json, a);
app::client::UserService client(tx, a);
keyma::result<User, keyma::error> r = keyma::sync_wait(client.get(id));
```

## Usage

Generated model headers `#include <keyma/runtime.hpp>` by default. Put this package's
`include/` directory on your compiler's include path:

```sh
npm install @keyma/runtime-cpp
c++ -std=c++23 -I node_modules/@keyma/runtime-cpp/include -I <generated-bundle-dir> main.cpp
```

> **GCC on macOS:** the macOS SDK headers (reached transitively through `<cstdlib>`) use
> the C11 keyword `_Alignof`, which GCC's C++ frontend rejects with `'_Alignof' was not
> declared in this scope` (Apple Clang accepts it as an extension, so it only affects
> GCC). Add `-D'_Alignof(x)=alignof(x)'` to the compile line — `_Alignof` is not a GCC C++
> keyword, so the macro is safe and `alignof` is exactly equivalent. The CMake target
> applies this automatically for GCC builds on macOS.

### CMake

A `CMakeLists.txt` ships with the package, exposing a header-only INTERFACE target
`keyma::runtime` (adds `include/` to the path and requests C++23). Integrate it any of the
usual ways:

```cmake
# vendored / monorepo
add_subdirectory(path/to/runtime-cpp)

# FetchContent
include(FetchContent)
FetchContent_Declare(keyma-runtime-cpp GIT_REPOSITORY <repo> GIT_TAG <tag>
                     SOURCE_SUBDIR packages/runtime-cpp)
FetchContent_MakeAvailable(keyma-runtime-cpp)

# installed (cmake --install . --prefix <p>) or npm-installed package
find_package(keyma-runtime-cpp CONFIG REQUIRED)

target_link_libraries(my_app PRIVATE keyma::runtime)
```

Building the package standalone (`cmake -S . -B build && ctest --test-dir build`) compiles
and runs the test suite; tests and install rules default off when consumed via
`add_subdirectory` / `FetchContent` (toggle with `KEYMA_RUNTIME_CPP_BUILD_TESTS` /
`KEYMA_RUNTIME_CPP_INSTALL`). On macOS configure with `-DCMAKE_CXX_COMPILER=g++-14`.

### Vendored runtime

If you prefer a self-contained drop with no external include path, set
`vendorRuntime: true` on the C++ target in `keyma.config.ts`. The backend then emits a
self-contained concatenation of the umbrella header set as `keyma_runtime.hpp` into each
bundle, and generated headers include it by quoted local name. Either way these headers
remain the source of truth — the backend's vendored copy is auto-generated from them
(`scripts/gen-runtime-header.mjs`) and must not be edited by hand.

## C++23 requirement

The runtime uses `std::expected`, `std::pmr`, `std::format`, and the chrono calendar, and
ships its own `keyma::move_only_function` rather than depending on `std::move_only_function`.
Any C++23 standard library that provides those features works — both libstdc++ 14+ and Apple
clang 17's libc++ (whose `std::move_only_function` is missing, which is why the runtime
carries its own). The test runner honours a `KEYMA_CXX` override and otherwise picks the
first `g++`/`clang++` on `PATH`.


## Future work

- Use of C++26 compile-time reflection to simplify generated code.