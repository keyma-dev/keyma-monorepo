/**
 * The Keyma C++ runtime header, for the `vendorRuntime` opt-in. The canonical source is
 * `@keyma/runtime-cpp`'s `include/keyma/*.hpp`; `scripts/gen-runtime-header.mjs` bakes a
 * SELF-CONTAINED concatenation of the umbrella header set (runtime core + errors/async +
 * the codecs + the transport/service/client/service_host RPC seam, in dependency order, with
 * the internal `#include <keyma/...>` lines stripped) into the committed
 * `runtime-header.generated.ts` at build time (mirroring the JS backend's gen scripts). This
 * keeps a single source of truth while letting the driver do NO file I/O at emit time.
 *
 * By default the C++ backend does not emit this — generated headers
 * `#include <keyma/runtime.hpp>` from the runtime package. When a target sets
 * `vendorRuntime: true`, the backend writes this header into each bundle as
 * `keyma_runtime.hpp` for a zero-dependency drop.
 */
import { RUNTIME_HPP } from "./runtime-header.generated.js";

/** The vendored, dependency-free C++23 runtime header (the umbrella header set concatenated). */
export function emitSupportHpp(): string {
    return RUNTIME_HPP;
}
