#pragma once

// Default application for @keyma/runtime-cpp (mirror of runtime-js `defaults.ts`).
// In the C++ backend, BOTH literal and expression defaults are lowered into the schema's
// single `apply_defaults` function (unlike runtime-js, which also reads a per-field
// `default` from metadata), so this is a thin call-through. Only absent keys are filled —
// that policy lives inside the generated `apply_defaults` body.

#include <keyma/runtime.hpp>

namespace keyma {

inline void apply_defaults(const SchemaMeta& schema, Value& data, alloc_t a) {
    if (schema.apply_defaults != nullptr) schema.apply_defaults(data, a);
}

}  // namespace keyma
