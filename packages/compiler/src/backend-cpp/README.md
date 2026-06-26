# @keyma/compiler-backend-cpp

C++23 backend for [Keyma](https://github.com/keyma-dev/keyma-monorepo). Given a Keyma
IR document, it emits header-only C++ model modules that mirror the source file layout.

Each generated `struct` is `std::pmr`-allocator-aware and specializes
`keyma::value_traits<T>`, so the runtime's generic `keyma::from_value<T>` /
`keyma::to_value<T>` own all per-field coercion and the per-struct code stays thin.
Validators and formatters are emitted as direct-ref factory functions in
`validators.hpp` / `formatters.hpp` (no registry).

## Runtime dependency

Generated headers `#include <keyma/runtime.hpp>` from
[`@keyma/runtime-cpp`](https://github.com/keyma-dev/keyma-monorepo/tree/main/packages/runtime-cpp)
by default — compile your consuming program with
`-I node_modules/@keyma/runtime-cpp/include`. Set the `vendorRuntime: true` target
option to instead emit a self-contained `keyma_runtime.hpp` per bundle (restoring the
zero-dependency property).

> One translation unit must include exactly one generated bundle (client XOR server XOR
> library): the per-bundle `keyma::value_traits<T>` specializations make mixing two
> bundles in one TU an ODR violation by design.

## Usage

This package is a backend plugin for `@keyma/compiler`'s `drive()`; it is normally used
via `@keyma/cli` rather than directly.

## License

MIT
