#pragma once

// Keyma runtime error model (@keyma/runtime-cpp), slim RPC edition. The C++ counterpart of
// the cross-language `KeymaError { code, message }`. The C++ RPC boundary never throws across
// the coroutine seam: the generated client returns `keyma::result<T, keyma::error>` (an alias
// for `std::expected`), where `keyma::error` carries the `{ code, message }` pair. The slim
// `KeymaRuntimeError` exception survives only as the JSON-parser failure type (json.hpp); it is
// never thrown across a transport.
//
// Depends only on keyma/value.hpp (itself stdlib-only, with no keyma include — so no cycle): a
// failure may carry a structured `details` payload as a keyma::Value (e.g. a VALIDATION_ERROR's
// ValidationError list). It still pulls in no keyma/runtime.hpp, so it composes into the umbrella
// runtime header without an include cycle.

#include <keyma/value.hpp>

#include <expected>
#include <memory_resource>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace keyma {

// ── error: the value-typed RPC failure (the `{ code, message }` pair) ──────────────────────
//
// The cross-language wire failure. Carried by `keyma::result<T, error>` out of every generated
// client method — so an RPC failure is an ordinary return value, never an exception unwinding
// across a co_await.
struct error {
    std::pmr::string code;
    std::pmr::string message;
    // Optional code-specific structured payload (e.g. a VALIDATION_ERROR's ValidationError list),
    // carried opaquely off the failure envelope. Null (`Value{}`) when absent.
    Value details{};

    error() = default;
    error(std::string_view c, std::string_view m) : code(c), message(m) {}
    error(std::string_view c, std::string_view m, Value d) : code(c), message(m), details(std::move(d)) {}
};

// ── result<T, E>: success-or-failure, alias of std::expected ────────────────────────────────
//
// The whole RPC surface speaks `keyma::task<keyma::result<T, error>>`. `result<void, error>`
// models a no-return method. Build a failure with `keyma::err(code, message)`.
template <class T, class E = error>
using result = std::expected<T, E>;

// Convenience: an `std::unexpected<error>` from a code/message pair (+ optional structured details).
inline std::unexpected<error> err(std::string_view code, std::string_view message) {
    return std::unexpected<error>(error{code, message});
}
inline std::unexpected<error> err(std::string_view code, std::string_view message, Value details) {
    return std::unexpected<error>(error{code, message, std::move(details)});
}

// ── The frozen cross-language error-code taxonomy ──────────────────────────────────────────
namespace error_code {
inline constexpr std::string_view service_not_found = "SERVICE_NOT_FOUND";
inline constexpr std::string_view method_not_found = "METHOD_NOT_FOUND";
inline constexpr std::string_view method_not_implemented = "METHOD_NOT_IMPLEMENTED";
inline constexpr std::string_view handler_error = "HANDLER_ERROR";
// Conventional code an impl raises (carrying structured `details`) after an opt-in
// keyma::validate(Model::metadata(), arg, a) rejects an inbound model argument.
inline constexpr std::string_view validation_error = "VALIDATION_ERROR";
}  // namespace error_code

// ── KeymaRuntimeError: the exception an impl throws to signal a coded failure ─────────────────
//
// Used by the JSON parser (json.hpp) to report a malformed document, AND as the opt-in
// error-signaling type a service impl throws (e.g. a VALIDATION_ERROR carrying structured
// `details`) — the generated `dispatch` catches it and folds its `code`/`message`/`details` into
// the failure envelope, preserving the code (a plain `std::exception` still collapses to
// HANDLER_ERROR). Kept minimal: a stable `code`, the human message in `what()`, and an optional
// structured `details` Value.
class KeymaRuntimeError : public std::runtime_error {
public:
    KeymaRuntimeError(std::string_view code, std::string_view message)
        : std::runtime_error(std::string(message)), code_(code) {}
    KeymaRuntimeError(std::string_view code, std::string_view message, Value details)
        : std::runtime_error(std::string(message)), code_(code), details_(std::move(details)) {}
    std::string_view code() const noexcept { return code_; }
    const Value& details() const noexcept { return details_; }

private:
    std::string code_;
    Value details_{};
};

}  // namespace keyma
