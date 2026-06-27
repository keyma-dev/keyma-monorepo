#pragma once

// Remotely-callable service contract for @keyma/runtime-cpp — the generated server base. C++ has
// no runtime reflection, so the C++ backend emits, per `@Service`, a class deriving `keyma::service`
// with three pieces:
//
//   * the typed pure-virtual methods the application overrides (each returns `keyma::task<Ret>` and
//     takes the declared params plus a trailing `const RequestContext&`, injected LAST);
//   * `meta()` — name / visibility / methods, for the host's visibility gate;
//   * `dispatch(method, payload, ctx, enc, a)` — a generated switch over the method name that
//     DECODES the `payload` (a named-arg Value object in JSON mode, or the positional binary blob),
//     calls the typed override, and ENCODES the result into the slim envelope, converting any
//     handler exception into a `HANDLER_ERROR` failure (no exception ever crosses the RPC boundary).
//
// The envelope is payload-based; the transport owns the wire form (JSON | binary) and threads its
// `encoding` through. This header ships only the metadata structs and the abstract interface.

#include <keyma/async.hpp>
#include <keyma/transport.hpp>

#include <span>
#include <string_view>

namespace keyma {

struct service_param_meta {
    std::string_view name;
};

struct service_method_meta {
    std::string_view name;
    Visibility visibility = Visibility::Public;
    std::span<const service_param_meta> params{};
};

struct service_meta {
    std::string_view name;
    Visibility visibility = Visibility::Public;
    std::span<const service_method_meta> methods{};
};

class service {
public:
    virtual ~service() = default;
    virtual const service_meta& meta() const = 0;

    // Decode `payload` for `enc` (a Value object of named arguments in JSON mode, or the positional
    // binary blob), call the typed override with the request `ctx` injected last, and encode the
    // result into the envelope. `a` is the host's allocator, threaded through hydration/serialization.
    // Generated per service.
    virtual task<call_result> dispatch(std::string_view method, const wire_payload& payload,
                                       const RequestContext& ctx, encoding enc, alloc_t a) = 0;
};

}  // namespace keyma
