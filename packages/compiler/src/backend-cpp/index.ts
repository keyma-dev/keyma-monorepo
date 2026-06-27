export { createCppBackend, emitCpp } from "./backend.js";
export type { CppTargetConfig } from "./types.js";

// The emitter-registry seam: the class, the bundle-layout refs, and the pack/contract types.
// Domain packs (a domain pack registered by the CLI) implement `CppEmitterPack`.
export { EmitterRegistry, SERVICES_REF, SERVICE_CLIENT_REF } from "./emitter-registry.js";
export type {
    CppEmitterPack,
    BuildClassData,
    CppClassData,
    CppFieldData,
    ClassDataOptions,
    ServiceEmitDeps,
    ServiceClientEmitDeps,
    BundleEmitContext,
} from "./emitter-registry.js";

// ── Generic emission helpers, exported so domain emitter packs build on the same engine ──
export { typeTag, irTypeToCpp, memberType, valueBinding, irTypeGuard, irTypeLabel } from "./ir-type-to-cpp.js";
// Statement/return lowering + identifier/context helpers — a domain pack reuses these to emit
// the validator/formatter `ValidatorFn`/`FormatterFn` wrappers it now owns (validators.hpp/formatters.hpp).
export { factoryIdent, stmtToCpp, plainReturn, rewriteContextAccess } from "./emit-validators.js";
export type { ReturnLowerer } from "./emit-validators.js";
export { includePath, cppSanitizer } from "./module-path.js";
export { exprToCpp } from "./emit-expression.js";
export { emitSupportHpp } from "./emit-support.js";

// Built-in `@Service` emission (compiler-owned, base-language concern) — the bundle shell
// emits these directly; exported for tests and direct consumers.
export { emitServicesCpp } from "./emit-service.js";
export { emitServiceClientCpp } from "./emit-service-client.js";
