#pragma once

// Remotely-callable service contract for @keyma/runtime-cpp (the C++ mirror of the
// `@Service` surface consumed by runtime-js `handleCall`). C++ has no runtime reflection,
// so a generated service base exposes two virtuals: `meta()` (name/visibility/methods/params
// for visibility gating and argument validation) and `dispatch()` (a generated switch over
// method names that unpacks args, calls the typed override, and returns a Value). This
// header ships only the metadata structs and the abstract interface.

#include <keyma/async.hpp>
#include <keyma/protocol.hpp>
#include <keyma/runtime.hpp>

#include <span>
#include <string_view>

namespace keyma {

struct ServiceParamMeta {
    std::string_view name;
    std::string_view schema;  // input-schema name for schema-typed params; empty otherwise
};

struct ServiceMethodMeta {
    std::string_view name;
    Visibility visibility = Visibility::Public;
    std::span<const ServiceParamMeta> params{};
};

struct ServiceMeta {
    std::string_view name;
    Visibility visibility = Visibility::Public;
    std::span<const ServiceMethodMeta> methods{};
};

template <template <class> class Async = Sync>
struct Service {
    virtual ~Service() = default;
    virtual const ServiceMeta& meta() const = 0;
    // Invoke `method` with `args` (keyed by declared param name) and the request context;
    // returns the method's result wrapped in a Value (null for a void method).
    virtual Async<Value> dispatch(std::string_view method, const Value& args, const RequestContext& ctx) = 0;
};

}  // namespace keyma
