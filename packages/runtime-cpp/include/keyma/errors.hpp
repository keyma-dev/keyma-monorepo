#pragma once

// Keyma runtime error model (@keyma/runtime-cpp), slim RPC edition. The C++ counterpart of
// the cross-language `KeymaError { code, message }`. The C++ RPC boundary never throws across
// the coroutine seam: the generated client returns `keyma::result<T, keyma::error>` (an alias
// for `std::expected`), where `keyma::error` carries the `{ code, message }` pair. The slim
// `KeymaRuntimeError` exception survives only as the JSON-parser failure type (json.hpp); it is
// never thrown across a transport.
//
// Dependency-free (no keyma/runtime.hpp): only the standard library, so it composes into the
// umbrella runtime header without an include cycle.

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

    error() = default;
    error(std::string_view c, std::string_view m) : code(c), message(m) {}
};

// ── result<T, E>: success-or-failure, alias of std::expected ────────────────────────────────
//
// The whole RPC surface speaks `keyma::task<keyma::result<T, error>>`. `result<void, error>`
// models a no-return method. Build a failure with `keyma::err(code, message)`.
template <class T, class E = error>
using result = std::expected<T, E>;

// Convenience: an `std::unexpected<error>` from a code/message pair.
inline std::unexpected<error> err(std::string_view code, std::string_view message) {
    return std::unexpected<error>(error{code, message});
}

// ── The frozen cross-language error-code taxonomy ──────────────────────────────────────────
namespace error_code {
inline constexpr std::string_view service_not_found = "SERVICE_NOT_FOUND";
inline constexpr std::string_view method_not_found = "METHOD_NOT_FOUND";
inline constexpr std::string_view method_not_implemented = "METHOD_NOT_IMPLEMENTED";
inline constexpr std::string_view handler_error = "HANDLER_ERROR";
}  // namespace error_code

// ── KeymaRuntimeError: the lone surviving exception type ─────────────────────────────────────
//
// Used only by the JSON parser (json.hpp) to report a malformed document. It is NOT part of the
// RPC error path (which is value-typed via `result`). Kept minimal: a stable `code` plus the
// human-readable message in `std::runtime_error::what()`.
class KeymaRuntimeError : public std::runtime_error {
public:
    KeymaRuntimeError(std::string_view code, std::string_view message)
        : std::runtime_error(std::string(message)), code_(code) {}
    std::string_view code() const noexcept { return code_; }

private:
    std::string code_;
};

}  // namespace keyma
