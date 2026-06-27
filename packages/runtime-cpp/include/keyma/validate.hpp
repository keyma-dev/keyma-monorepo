#pragma once

// Field validation for @keyma/runtime-cpp (mirror of runtime-js `validate.ts`). Synchronous: the
// C++ ValidatorFn is a synchronous move_only_function. An absent required field yields a "required"
// error; otherwise each field validator runs against the present value. Returns the collected
// errors. Operates on the metadata-driven `ClassMetadata` the C++ backend still emits (`validators`
// span per field) — distinct from the codec, which ignores those callables.

#include <keyma/metadata.hpp>

#include <expected>
#include <format>
#include <string>
#include <string_view>
#include <utility>

namespace keyma {

// validate_if: like validate, but only the fields for which `include_field(f)` is true are
// considered. A caller can use this to drop `id` on create, or to validate only the supplied
// fields on a partial update (so absent fields never trip the required check).
template <class Pred>
std::pmr::vector<ValidationError> validate_if(const ClassMetadata& schema, const Value& value,
                                              alloc_t a, Pred include_field) {
    std::pmr::vector<ValidationError> errors(a);
    Context ctx{value};
    for (const FieldMeta& f : all_fields(schema, a)) {  // own + inherited (real inheritance)
        if (!include_field(f)) continue;
        const Value* present = value.find(f.name);
        if (present == nullptr) {
            if (f.required) {
                std::string msg = std::format("{} is required", f.name);
                errors.push_back(ValidationError{
                    std::pmr::string(f.name, a),
                    std::pmr::string(std::string_view("required"), a),
                    std::pmr::string(std::string_view(msg), a)});
            }
            continue;
        }
        for (const ValidatorFn& fn : f.validators) {
            std::expected<void, ValidationError> r = fn(*present, f.name, ctx);
            if (!r.has_value()) errors.push_back(std::move(r.error()));
        }
    }
    return errors;
}

inline std::pmr::vector<ValidationError> validate(const ClassMetadata& schema, const Value& value, alloc_t a) {
    return validate_if(schema, value, a, [](const FieldMeta&) { return true; });
}

}  // namespace keyma
