# @keyma/runtime-cpp

The C++23 header-only runtime consumed by Keyma-generated C++ models. It is the C++
counterpart of `@keyma/runtime-js` and `keyma-runtime` (Python).

It ships a single header — `include/keyma/runtime.hpp` — which is the **single source of
truth** for the C++ runtime. It provides:

- `keyma::Value` — the dynamic, allocator-aware (`std::pmr`) value type used at the
  validator/formatter/defaults boundary and for `json` fields.
- The validation/formatting result types and callable typedefs (`keyma::ValidatorFn`,
  `keyma::FormatterFn`, `keyma::ValidationError`, `keyma::Context`).
- The schema-metadata structs (`keyma::SchemaMeta`, `keyma::FieldMeta`, …) and
  `keyma::Field<T>` for two-axis (optional × nullable) fields.
- The intrinsic helpers the expression lowering emits (string/array/date/regex ops,
  `keyma::to_string<E>` / `keyma::from_string<E>` enum conversions).
- The **serialization layer**: `keyma::value_traits<T>`, `keyma::from_value<T>` and
  `keyma::to_value<T>`. Generated model structs specialize `value_traits<T>` (mapping
  each field name to a member); the runtime owns all per-field coercion.

## Runtime consumer layer

Beyond the model substrate, the package ships the C++ counterpart of the
`@keyma/runtime-js` server/client stack as additional headers under `include/keyma/`
(each `#include <keyma/runtime.hpp>` and compose):

- `keyma/json.hpp` — a dependency-free JSON (de)serializer for `keyma::Value`:
  `json_parse(string_view, alloc_t)` / `json_stringify(const Value&, alloc_t)` (plus a
  pretty variant). Integral tokens become `int64`, fractional ones `double`; strings carry
  full escape/`\uXXXX`-surrogate handling; bytes serialize as base64.
- `keyma/errors.hpp` — the `KeymaError` hierarchy (`KeymaRuntimeError`,
  `KeymaPluginError`, `KeymaAdapterError`, `ValidationFailedError`) and `error_to_result`.
- `keyma/protocol.hpp` — `proto::` builders/accessors for the wire operations, requests,
  and responses (all plain `keyma::Value` objects), and `RequestContext`.
- `keyma/adapter.hpp` — the pure-virtual `KeymaDatabaseAdapter<Async>` plus the
  adapter-facing structs (`AdapterProjection`, `ListQuery`, `AdapterTraversalContext`, …).
- `keyma/plugin.hpp` — the pure-virtual `KeymaServerPlugin<Async>` (seven optional hooks
  with `has_*()` predicates) and `PluginServerHandle<Async>`.
- `keyma/service.hpp` — `ServiceMeta`/`ServiceMethodMeta`/`ServiceParamMeta` and the
  pure-virtual `Service<Async>` (`meta()` + `dispatch()`).
- `keyma/validate.hpp`, `keyma/format.hpp`, `keyma/defaults.hpp`, `keyma/serialize.hpp` —
  synchronous validate / format / apply-defaults / serialize (visibility & ephemeral
  filtering) and `normalize_reference_ids`.
- `keyma/server.hpp` — `KeymaServer<Async>`: `ensure_schemas` / `handle` / `close`, the
  full eight-operation dispatch (list/read/create/update/delete/count/traverse/call), the
  plugin-hook folds, and the adapter-projection builder.
- `keyma/client.hpp` — `Transport<Async>`, the `Keyma` query builder (dynamic and typed
  `Keyma::list<T>(…)`), `Document<Async>` batching with `input(…)` placeholders, the typed
  `*_as<T>` convenience helpers, and `create_direct_transport`.

Adapters and plugins are **interfaces only** — concrete database adapters and plugins are
separate `@keyma/adapter-*-cpp` / `@keyma/plugin-*-cpp` packages.

> Note on wire format: a `dateTime` is an epoch-ms `int64` and a `bytes` is a base64 string
> on the wire — the canonical cross-runtime format the JS, Python, and C++ runtimes all share,
> so `serialize` passes both through unchanged with no conversion. (`keyma::to_iso8601` /
> `keyma::date_parse` are application-logic helpers backing the `date.toISOString()` /
> `new Date("…")` body intrinsics, not wire helpers.)

## Async policy — bring your own scheduler

C++23 has no standard event loop, so the I/O-bearing interfaces are templated on a policy
`template<class> class Async`, defaulting to `keyma::Sync` (an identity wrapper): with the
default everything is synchronous and zero-overhead. To run on `std::future`, a coroutine
task, or any executor, specialize the single `async_traits<YourAsync>` customization point
(`ready` / `then` / `attempt` / `swallow`) and `is_async`/`payload` for your type — the
runtime never spawns threads or assumes an executor. `async.hpp` documents the exact
contract; `test/coroutine.test.cpp` is a worked, genuinely-suspending C++23 coroutine-task
policy with a single-threaded run loop, and `test/futures.test.cpp` a (blocking)
`std::future` policy.

```cpp
keyma::KeymaServer<> server({ .schemas = schemas, .adapter = &adapter, .alloc = a });
keyma::Transport<> tx = keyma::create_direct_transport(server);
User u = keyma::sync_get(keyma::create_as<User>(tx, data, {}, a));
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
verbatim copy of this header as `keyma_runtime.hpp` into each bundle, and generated
headers include it by quoted local name. Either way this header remains the source of
truth — the backend's vendored copy is auto-generated from it
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