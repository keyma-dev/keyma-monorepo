#pragma once

// Keyma runtime error model (@keyma/runtime-cpp). The C++ counterpart of
// runtime-js `errors.ts`: a small KeymaError hierarchy carrying a stable string
// `code`, an `ErrorSource`, and (for plugin/adapter errors) an `origin` package
// name, plus `error_to_result` which renders any caught exception into the
// failure-shaped keyma::Value the server returns. Errors propagate as ordinary
// C++ exceptions; the server catches them per-operation and converts here.

#include <keyma/runtime.hpp>

#include <exception>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace keyma {

enum class ErrorSource { Runtime, Plugin, Adapter };

inline std::string_view error_source_name(ErrorSource s) noexcept {
    switch (s) {
        case ErrorSource::Runtime: return "runtime";
        case ErrorSource::Plugin:  return "plugin";
        case ErrorSource::Adapter: return "adapter";
    }
    return "runtime";
}

// Abstract base. The human-readable message lives in std::runtime_error::what().
class KeymaError : public std::runtime_error {
public:
    explicit KeymaError(std::string_view message) : std::runtime_error(std::string(message)) {}
    virtual std::string_view code() const noexcept = 0;
    virtual ErrorSource source() const noexcept = 0;
    // Package name of the originator (plugin/adapter). Empty for runtime errors.
    virtual std::string_view origin() const noexcept { return {}; }
    // Merge any free-form extras into the failure object (e.g. {errors:[...]} for a
    // validation failure). Default: nothing.
    virtual void add_failure_extras(Value& /*failure*/, alloc_t /*a*/) const {}
};

class KeymaRuntimeError : public KeymaError {
public:
    KeymaRuntimeError(std::string_view code, std::string_view message)
        : KeymaError(message), code_(code) {}
    std::string_view code() const noexcept override { return code_; }
    ErrorSource source() const noexcept override { return ErrorSource::Runtime; }
protected:
    std::string code_;
};

class KeymaPluginError : public KeymaError {
public:
    KeymaPluginError(std::string_view code, std::string_view message, std::string_view origin)
        : KeymaError(message), code_(code), origin_(origin) {}
    std::string_view code() const noexcept override { return code_; }
    ErrorSource source() const noexcept override { return ErrorSource::Plugin; }
    std::string_view origin() const noexcept override { return origin_; }
private:
    std::string code_;
    std::string origin_;
};

class KeymaAdapterError : public KeymaError {
public:
    KeymaAdapterError(std::string_view code, std::string_view message, std::string_view origin)
        : KeymaError(message), code_(code), origin_(origin) {}
    std::string_view code() const noexcept override { return code_; }
    ErrorSource source() const noexcept override { return ErrorSource::Adapter; }
    std::string_view origin() const noexcept override { return origin_; }
private:
    std::string code_;
    std::string origin_;
};

// Thrown by create/update/call when field validation fails. Carries the structured
// errors so they surface under `errors` in the failure object (code VALIDATION_FAILED).
class ValidationFailedError : public KeymaRuntimeError {
public:
    explicit ValidationFailedError(std::pmr::vector<ValidationError> errors)
        : KeymaRuntimeError("VALIDATION_FAILED", "Validation failed"), errors_(std::move(errors)) {}
    const std::pmr::vector<ValidationError>& errors() const noexcept { return errors_; }
    void add_failure_extras(Value& failure, alloc_t a) const override {
        Value arr = Value::array(a);
        for (const ValidationError& e : errors_) {
            Value o = Value::object(a);
            o.set("field", Value(std::string_view(e.field), a));
            o.set("code", Value(std::string_view(e.code), a));
            o.set("message", Value(std::string_view(e.message), a));
            arr.push(std::move(o));
        }
        failure.set("errors", std::move(arr));
    }
private:
    std::pmr::vector<ValidationError> errors_;
};

// Render a caught exception into a leaf-failure Value:
//   { ok:false, error, code, source[, origin], ...extras }
// A KeymaError carries its own code/source/origin/extras; anything else becomes a
// generic runtime INTERNAL_ERROR (mirrors runtime-js errorToResult).
inline Value error_to_result(std::exception_ptr eptr, alloc_t a) {
    Value out = Value::object(a);
    out.set("ok", Value(false, a));
    auto fill_generic = [&](std::string_view message) {
        out.set("error", Value(message, a));
        out.set("code", Value(std::string_view("INTERNAL_ERROR"), a));
        out.set("source", Value(std::string_view("runtime"), a));
    };
    try {
        std::rethrow_exception(eptr);
    } catch (const KeymaError& e) {
        out.set("error", Value(std::string_view(e.what()), a));
        out.set("code", Value(e.code(), a));
        out.set("source", Value(error_source_name(e.source()), a));
        if (!e.origin().empty()) out.set("origin", Value(e.origin(), a));
        e.add_failure_extras(out, a);
    } catch (const std::exception& e) {
        fill_generic(std::string_view(e.what()));
    } catch (...) {
        fill_generic(std::string_view("Unknown error"));
    }
    return out;
}

}  // namespace keyma
