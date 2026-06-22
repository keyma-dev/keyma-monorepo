#pragma once

// Field formatting for @keyma/runtime-cpp (mirror of runtime-js `format.ts`).
// Synchronous (FormatterFn is a synchronous std::move_only_function). For each present
// field, runs the formatters whose phase matches `phase`, in order, replacing the field
// value in place. Cross-field formatters read the (partially formatted) record via Context.

#include <keyma/runtime.hpp>

namespace keyma {

inline void format(const SchemaMeta& schema, Value& value, Phase phase) {
    Context ctx{value};
    for (const FieldMeta& f : schema.fields) {
        if (value.find(f.name) == nullptr) continue;
        for (const PhasedFormatter& pf : f.formatters) {
            if (pf.phase != phase) continue;
            Value formatted = pf.fn(value.at(f.name), ctx);
            value.set(f.name, std::move(formatted));
        }
    }
}

}  // namespace keyma
