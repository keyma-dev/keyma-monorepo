#pragma once

// Field formatting for @keyma/runtime-cpp (mirror of runtime-js `format.ts`). Synchronous
// (FormatterFn is a synchronous move_only_function). For each present field, runs the formatters
// whose phase matches `phase`, in order, replacing the field value in place. Cross-field formatters
// read the (partially formatted) record via Context. Walks the base chain for inherited fields.

#include <keyma/metadata.hpp>

#include <utility>

namespace keyma {

inline void format(const ClassMetadata& schema, Value& value, Phase phase) {
    Context ctx{value};
    // Real inheritance: walk the base chain (no allocator here; order is irrelevant for formatting).
    for (const ClassMetadata* s = &schema; s != nullptr; s = (s->base != nullptr ? &s->base() : nullptr)) {
        for (const FieldMeta& f : s->fields) {
            if (value.find(f.name) == nullptr) continue;
            for (const PhasedFormatter& pf : f.formatters) {
                if (pf.phase != phase) continue;
                Value formatted = pf.fn(value.at(f.name), ctx);
                value.set(f.name, std::move(formatted));
            }
        }
    }
}

}  // namespace keyma
