#pragma once

// RPC transport seam for @keyma/runtime-cpp. A capability-flagged `transport` with a single
// unary primitive — `invoke(call_request) -> task<call_result>`. The streaming capabilities are
// RESERVED (declared, not built) so adding them later is not a breaking reshape. Encoding
// (JSON | binary) is a TRANSPORT configuration; both ends agree statically — no negotiation.
//
// The host, client, dispatch, and `transport` all speak a payload-based envelope and are
// SCHEDULER-AGNOSTIC: nothing here is templated on a scheduler. A concrete async transport holds
// its own event_loop and binds to it at its I/O-leaf awaitables. The provided `direct_transport`
// completes its task INLINE (no event_loop needed) — the cheap synchronous path that carries the
// envelope struct in-process (no encode/decode hop; the generated client already encoded the args
// per the transport's `wire_encoding()`, and the host's generated dispatch decodes them).

#include <keyma/errors.hpp>
#include <keyma/async.hpp>
#include <keyma/binary.hpp>  // ByteBuf

#include <string_view>
#include <utility>
#include <variant>

namespace keyma {

// ── Wire encoding (transport config; no runtime negotiation) ──
enum class encoding { json, binary };

// ── wire_payload: a call's args / result payload ──
//
// JSON mode → a keyma::Value (an object of named args, or the bare return value). Binary mode →
// the positional binary blob (a ByteBuf). The live alternative matches the transport's
// `wire_encoding()`; both ends agree statically, so nothing about the encoding rides on the wire.
using wire_payload = std::variant<Value, ByteBuf>;

inline wire_payload empty_payload(encoding enc, alloc_t a = {}) {
    if (enc == encoding::binary) return wire_payload(ByteBuf(a));
    return wire_payload(Value::object(a));
}

// ── Request context: an open Value bag; `identity.isSystem` drives the visibility gate ──
using RequestContext = Value;

inline bool ctx_is_system(const RequestContext& ctx) noexcept {
    const Value* id = ctx.find("identity");
    if (id == nullptr) return false;
    const Value* sys = id->find("isSystem");
    return sys != nullptr && sys->is_bool() && sys->as_bool();
}
// Build a system context (the in-process SSR caller that bypasses the visibility gate).
inline RequestContext system_context(alloc_t a = {}) {
    Value ctx = Value::object(a);
    Value id = Value::object(a);
    id.set("isSystem", Value(true, a));
    ctx.set("identity", std::move(id));
    return ctx;
}

// ── The slim wire envelope (payload-based; the transport chooses the wire form) ──
//
// CallRequest = { service, method, args }. `service`/`method` are always PLAINTEXT (the host
// resolves them as a string header — never inside the binary args blob). `args` is the encoded
// argument payload: a named-arg Value object in JSON mode, or the positional binary blob.
struct call_request {
    std::pmr::string service;
    std::pmr::string method;
    wire_payload args;
};

// CallResult = ok{ data } | err{ code, message, details? }. `data` is the encoded return payload
// (the bare return value in JSON mode, the bare return blob in binary mode; void → null / empty
// bytes). On failure, `details` carries an optional code-specific structured payload (e.g. a
// VALIDATION_ERROR's ValidationError list) the host/dispatch copied off the thrown error —
// domain-neutral, passed through opaquely and surfaced on the client `keyma::error`.
struct call_result {
    bool ok = true;
    wire_payload data{};
    std::pmr::string code{};
    std::pmr::string message{};
    Value details{};

    static call_result success(wire_payload data) { return call_result{true, std::move(data), {}, {}, {}}; }
    static call_result failure(std::string_view code, std::string_view message) {
        return call_result{false, wire_payload{}, std::pmr::string(code), std::pmr::string(message), {}};
    }
    static call_result failure(std::string_view code, std::string_view message, Value details) {
        return call_result{false, wire_payload{}, std::pmr::string(code), std::pmr::string(message), std::move(details)};
    }
};

// ── request_handler: the host seam a transport dispatches into ──
//
// Defined here (not service_host.hpp) so a transport can target a host without depending on it —
// `service_host` implements this interface. The transport injects the `RequestContext` it carries
// and the `encoding` it is configured with (so the host's generated dispatch reads `args` and
// encodes the result the same way the client encoded them).
class request_handler {
public:
    virtual ~request_handler() = default;
    virtual task<call_result> handle(call_request req, RequestContext ctx, encoding enc) = 0;
};

// ── Capability descriptor (streaming reserved, not built) ──
struct transport_capabilities {
    bool unary = true;
    bool server_stream = false;
    bool client_stream = false;
    bool bidi = false;
};

// ── transport: the capability-flagged seam ──
class transport {
public:
    virtual ~transport() = default;
    virtual transport_capabilities capabilities() const { return {}; }
    virtual encoding wire_encoding() const = 0;
    virtual task<call_result> invoke(call_request req) = 0;
};

// ── direct_transport: in-process, completes the task INLINE (no event_loop) ──
//
// Hands a call_request straight to the handler — no encode/decode hop (the generated client
// already encoded the args per `wire_encoding()`; the host's dispatch decodes them). Forwards a
// caller-supplied ctx (default NON-system, so gating is exercised); `direct_transport::system(...)`
// opts into the system identity for SSR. The encoding is a config (default json).
class direct_transport : public transport {
public:
    explicit direct_transport(request_handler& h, encoding enc = encoding::json,
                              RequestContext ctx = {}, alloc_t a = {})
        : handler_(&h), enc_(enc), ctx_(std::move(ctx)), alloc_(a) {}

    static direct_transport system(request_handler& h, encoding enc = encoding::json, alloc_t a = {}) {
        return direct_transport(h, enc, system_context(a), a);
    }

    encoding wire_encoding() const override { return enc_; }
    task<call_result> invoke(call_request req) override {
        call_result r = co_await handler_->handle(std::move(req), RequestContext(ctx_, alloc_), enc_);
        co_return r;
    }

private:
    request_handler* handler_;
    encoding enc_;
    RequestContext ctx_;
    alloc_t alloc_;
};

// Free builder mirroring the cross-language `create_direct_transport`.
inline direct_transport create_direct_transport(request_handler& h, encoding enc = encoding::json,
                                                alloc_t a = {}) {
    return direct_transport(h, enc, RequestContext{}, a);
}

}  // namespace keyma
