#pragma once

// Slim service host for @keyma/runtime-cpp. Its entire job, per the frozen cross-language
// contract: resolve service + method (by the plaintext string header) → visibility-gate
// (probe-resistant: private ⇒ "not found" unless ctx.identity.isSystem) → inject the
// RequestContext → call the generated `dispatch(method, payload, ctx, encoding, a)` → return the
// slim envelope. Type-agnostic, encoding-agnostic, NO validation. It implements `request_handler`,
// so any transport can target it (the direct transport hands it a call_request straight, inline).

#include <keyma/errors.hpp>
#include <keyma/async.hpp>
#include <keyma/transport.hpp>
#include <keyma/service.hpp>

#include <string_view>
#include <utility>
#include <vector>

namespace keyma {

class service_host : public request_handler {
public:
    explicit service_host(alloc_t a = {}) : alloc_(a), services_(a) {}

    // Register a service instance (non-owning — the host does not own its lifetime). Keyed by
    // `meta().name` (the wire id).
    void add(service& svc) { services_.push_back(&svc); }

    task<call_result> handle(call_request req, RequestContext ctx, encoding enc) override {
        const bool is_system = ctx_is_system(ctx);

        service* svc = find_service(std::string_view(req.service));
        // Resolve + service-level visibility gate (private ⇒ "not found" unless system caller).
        if (svc == nullptr || (svc->meta().visibility == Visibility::Private && !is_system)) {
            co_return call_result::failure(error_code::service_not_found, "service not found");
        }

        const service_method_meta* method = find_method(svc->meta(), std::string_view(req.method));
        // Resolve + method-level visibility gate (probe-resistant: same "not found" shape).
        if (method == nullptr || (method->visibility == Visibility::Private && !is_system)) {
            co_return call_result::failure(error_code::method_not_found, "method not found");
        }

        // Inject ctx and dispatch. The generated dispatch owns arg-decode / call / result-encode
        // and converts any handler exception into a HANDLER_ERROR failure.
        call_result r = co_await svc->dispatch(std::string_view(req.method), req.args, ctx, enc, alloc_);
        co_return r;
    }

private:
    service* find_service(std::string_view name) const {
        for (service* s : services_) if (s->meta().name == name) return s;
        return nullptr;
    }
    static const service_method_meta* find_method(const service_meta& m, std::string_view name) {
        for (const service_method_meta& mm : m.methods) if (mm.name == name) return &mm;
        return nullptr;
    }

    alloc_t alloc_;
    std::pmr::vector<service*> services_;
};

}  // namespace keyma
