/** Target configuration for the C++ backend. */
export type CppTargetConfig = {
    language: "cpp";
    outDir: string;
    /** Emit a client bundle (public schemas, no private fields, no index metadata). Default: true. */
    client?: boolean;
    /** Emit a server bundle (all schemas, all fields, index metadata, materializers). Default: true. */
    server?: boolean;
    /**
     * Emit a single unified bundle directly into outDir (all schemas/fields/materializers).
     * When true, `client` and `server` are ignored and no client/ or server/ subdirectory is created.
     */
    library?: boolean;
    /**
     * Root C++ namespace for the GENERATED user code (models, validators, formatters,
     * functions, services, enums). Default: "app". The `keyma::` namespace is reserved
     * for the dependency-free support/runtime types and must not be used here.
     */
    namespace?: string;
    /**
     * Inline the runtime (`@keyma/runtime-cpp`) into every bundle as a self-contained
     * `keyma_runtime.hpp` instead of depending on it. Generated headers then include it
     * by quoted local name, restoring the zero-dependency drop. Default: false — headers
     * `#include <keyma/runtime.hpp>` and the consumer puts the package's `include/` on
     * the compiler include path (`-I node_modules/@keyma/runtime-cpp/include`).
     */
    vendorRuntime?: boolean;
    /**
     * The `#include` token (WITH delimiters) generated headers use for the runtime.
     * Default: `<keyma/runtime.hpp>`. Ignored when `vendorRuntime` is true (forced to the
     * quoted vendored filename `"keyma_runtime.hpp"`).
     */
    runtimeInclude?: string;
};

/** Resolved emit flags after applying defaults. */
export type ResolvedCppTarget = {
    outDir: string;
    namespaceRoot: string;
    emitClient: boolean;
    emitServer: boolean;
    emitLibrary: boolean;
    vendorRuntime: boolean;
    /** Complete `#include` token (with `<...>` or `"..."`) for the runtime header. */
    runtimeInclude: string;
};

/** The default angle-bracket include for the @keyma/runtime-cpp header. */
const DEFAULT_RUNTIME_INCLUDE = "<keyma/runtime.hpp>";
/** The vendored, bundle-local runtime header filename (and its quoted include token). */
export const VENDOR_RUNTIME_HEADER = "keyma_runtime.hpp";

/** Resolve a C++ target config (defaults to both client and server, mirroring the JS backend). */
export function resolveCppTarget(target: CppTargetConfig): ResolvedCppTarget {
    const emitLibrary = target.library === true;
    const vendorRuntime = target.vendorRuntime === true;
    return {
        outDir: target.outDir,
        namespaceRoot: target.namespace ?? "app",
        emitClient: !emitLibrary && target.client !== false,
        emitServer: !emitLibrary && target.server !== false,
        emitLibrary,
        vendorRuntime,
        runtimeInclude: vendorRuntime
            ? `"${VENDOR_RUNTIME_HEADER}"`
            : target.runtimeInclude ?? DEFAULT_RUNTIME_INCLUDE,
    };
}
