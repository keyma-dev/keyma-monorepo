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

## Usage

Generated model headers `#include <keyma/runtime.hpp>` by default. Put this package's
`include/` directory on your compiler's include path:

```sh
npm install @keyma/runtime-cpp
c++ -std=c++23 -I node_modules/@keyma/runtime-cpp/include -I <generated-bundle-dir> main.cpp
```

If you prefer a self-contained drop with no external include path, set
`vendorRuntime: true` on the C++ target in `keyma.config.ts`. The backend then emits a
verbatim copy of this header as `keyma_runtime.hpp` into each bundle, and generated
headers include it by quoted local name. Either way this header remains the source of
truth — the backend's vendored copy is auto-generated from it
(`scripts/gen-runtime-header.mjs`) and must not be edited by hand.

## C++23 requirement

The header uses `std::move_only_function`, `std::expected`, `std::pmr`, `std::format`,
and the chrono calendar. A C++23 standard library that provides `std::move_only_function`
is required — libstdc++ 14+ works; Apple clang's libc++ does not yet. On macOS, install a
recent GCC and set `KEYMA_CXX=g++-14` (or `g++-15`).
