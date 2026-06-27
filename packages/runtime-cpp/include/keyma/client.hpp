#pragma once

// Generated-client support for @keyma/runtime-cpp. The C++ backend emits, per `@Service`, a
// per-service client class bound to a `transport`, with one coroutine method per RPC. Each method
// reads the transport's `wire_encoding()`, marshals its declared args into the call payload (a
// named-arg Value object in JSON mode, or the positional binary blob), round-trips the envelope
// through `client_invoke`, and decodes the OK payload into the typed return — yielding
// `keyma::task<keyma::result<T, keyma::error>>`. NO exception ever crosses the RPC boundary: a
// failure envelope becomes a `keyma::error` value in the `result`.

#include <keyma/errors.hpp>
#include <keyma/async.hpp>
#include <keyma/transport.hpp>

#include <string_view>
#include <utility>

namespace keyma {

// Build the call_request, invoke the transport, and unwrap the envelope: yields the OK data
// payload (which the generated client method then decodes into the typed return value, per the
// transport encoding), or surfaces a failure envelope as a `keyma::error`. Encoding-agnostic —
// it speaks the opaque `wire_payload`; the generated method owns the per-type encode/decode.
inline task<result<wire_payload, error>> client_invoke(transport& tx, std::string_view service,
                                                       std::string_view method, wire_payload args) {
    call_request req{std::pmr::string(service), std::pmr::string(method), std::move(args)};
    call_result res = co_await tx.invoke(std::move(req));
    if (!res.ok) {
        co_return std::unexpected(error{std::string_view(res.code), std::string_view(res.message)});
    }
    co_return result<wire_payload, error>(std::move(res.data));
}

// Optional base for a generated per-service client (the backend also inlines the two members).
// Holds the bound transport + allocator; the generated subclass adds the typed RPC methods.
class service_client {
public:
    explicit service_client(transport& tx, alloc_t a = {}) : transport_(&tx), alloc_(a) {}

protected:
    transport& client_transport() const noexcept { return *transport_; }
    alloc_t client_alloc() const noexcept { return alloc_; }

    transport* transport_;
    alloc_t alloc_;
};

}  // namespace keyma
