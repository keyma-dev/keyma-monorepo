// VALIDATION_ERROR + structured `details` round-trip over @keyma/runtime-cpp. The opt-in
// validation pattern: an impl runs keyma::validate(Model::metadata(), arg, a) and, on failure,
// throws a KeymaRuntimeError(error_code::validation_error, msg, details). The generated dispatch
// folds its code + details into the slim envelope (a plain std::exception still collapses to
// HANDLER_ERROR); the host returns it; the generated client surfaces it as a keyma::error carrying
// the same code + details. This pins the runtime pieces (errors.hpp / transport.hpp / client.hpp)
// the C++ backend's emit-service catch clause relies on. Compiled + run by scripts/cpp-test.sh.

#include <keyma/runtime.hpp>

#include <cassert>
#include <memory_resource>
#include <string_view>

using namespace keyma;

// The structured payload a VALIDATION_ERROR carries — a ValidationError[] shape as a keyma::Value.
static Value make_details(alloc_t a) {
    Value arr = Value::array(a);
    Value e0 = Value::object(a);
    e0.set("field", Value(std::string_view("name"), a));
    e0.set("code", Value(std::string_view("required"), a));
    e0.set("message", Value(std::string_view("name is required"), a));
    arr.push(std::move(e0));
    return arr;
}

// A minimal handler whose dispatch mirrors the generated catch (emit-service.ts): a thrown
// KeymaRuntimeError folds its code + details into the failure envelope; any other exception
// collapses to HANDLER_ERROR.
class rejecting_handler : public request_handler {
public:
    explicit rejecting_handler(alloc_t a) : a_(a) {}
    task<call_result> handle(call_request req, RequestContext, encoding) override {
        try {
            if (req.method == "reject")
                throw KeymaRuntimeError(error_code::validation_error, "validation failed", make_details(a_));
            if (req.method == "boom")
                throw std::runtime_error("kaboom");
            co_return call_result::failure(error_code::method_not_found, "method not found");
        } catch (const KeymaRuntimeError& e) {
            co_return call_result::failure(e.code(), e.what(), Value(e.details(), a_));
        } catch (const std::exception& e) {
            co_return call_result::failure(error_code::handler_error, e.what());
        }
    }
    alloc_t a_;
};

int main() {
    std::pmr::monotonic_buffer_resource pool;
    alloc_t a{&pool};

    // 1) The failure envelope carries the folded code + structured details.
    {
        rejecting_handler h(a);
        direct_transport tx = create_direct_transport(h, encoding::json, a);
        call_request req{std::pmr::string("S"), std::pmr::string("reject"), wire_payload(Value::object(a))};
        call_result res = sync_wait(tx.invoke(std::move(req)));
        assert(!res.ok);
        assert(std::string_view(res.code) == error_code::validation_error);
        assert(res.details.is_array() && res.details.as_array().size() == 1);
        assert(res.details.as_array()[0].at("code").as_string() == "required");
        assert(res.details.as_array()[0].at("field").as_string() == "name");
    }

    // 2) The client surfaces the failure as a keyma::error carrying the same code + details.
    {
        rejecting_handler h(a);
        direct_transport tx = create_direct_transport(h, encoding::json, a);
        result<wire_payload, error> r =
            sync_wait(client_invoke(tx, "S", "reject", wire_payload(Value::object(a))));
        assert(!r.has_value());
        const error& e = r.error();
        assert(std::string_view(e.code) == error_code::validation_error);
        assert(e.details.is_array() && e.details.as_array().size() == 1);
        assert(e.details.as_array()[0].at("message").as_string() == "name is required");
    }

    // 3) A plain exception still collapses to HANDLER_ERROR with no details (regression).
    {
        rejecting_handler h(a);
        direct_transport tx = create_direct_transport(h, encoding::json, a);
        call_request req{std::pmr::string("S"), std::pmr::string("boom"), wire_payload(Value::object(a))};
        call_result res = sync_wait(tx.invoke(std::move(req)));
        assert(!res.ok && std::string_view(res.code) == error_code::handler_error);
        assert(!res.details.is_array());  // null Value — no structured details
    }

    // 4) The value-typed factories carry details too.
    {
        call_result cr = call_result::failure(error_code::validation_error, "x", make_details(a));
        assert(cr.details.as_array().size() == 1);
        std::unexpected<error> ue = err(error_code::validation_error, "x", make_details(a));
        assert(ue.error().details.as_array().size() == 1);
    }

    return 0;
}
