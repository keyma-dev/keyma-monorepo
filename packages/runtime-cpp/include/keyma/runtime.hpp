#pragma once

// @keyma/runtime-cpp — the umbrella header generated C++ includes (a generated header does
// `#include <keyma/runtime.hpp>` and nothing else external). This file is a pure INDEX: the
// runtime is split across the sibling headers below, pulled in here in dependency order so each
// sees the complete types the next one builds on.
//
// The dependency-free core comes first — keyma::Value (value.hpp), the move_only_function call
// wrapper (function.hpp), the schema metadata + validator/formatter types (metadata.hpp), the
// JS-semantics intrinsics (intrinsics.hpp), and the value_traits<T> / from_value<T> / to_value<T>
// serialization layer (value_traits.hpp). Then the leaf errors/async, the serialization codecs
// (serialize / binary / binary-typed / json), and finally the RPC seam built on them
// (transport / service / client / service_host). Every sibling is std::pmr throughout and targets
// C++23 (std::expected, std::format, the chrono calendar, std::pmr); it ships its own
// keyma::move_only_function so std::move_only_function support is not required.
//
// (The `vendorRuntime` opt-in inlines this same set, concatenated in this order, via
// scripts/gen-runtime-header.mjs.)

// ── Dependency-free core ──
#include <keyma/value.hpp>
#include <keyma/function.hpp>
#include <keyma/metadata.hpp>
#include <keyma/intrinsics.hpp>
#include <keyma/value_traits.hpp>

// ── Leaf errors + async, the serialization codecs, then the RPC seam ──
#include <keyma/errors.hpp>
#include <keyma/async.hpp>
#include <keyma/serialize.hpp>
#include <keyma/binary.hpp>
#include <keyma/binary-typed.hpp>
#include <keyma/json.hpp>
#include <keyma/transport.hpp>
#include <keyma/service.hpp>
#include <keyma/client.hpp>
#include <keyma/service_host.hpp>
