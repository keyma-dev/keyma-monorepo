export { createCppBackend, emitCpp } from "./backend.js";
export type { CppBackendOptions } from "./backend.js";
export type { CppTargetConfig } from "./types.js";

// The neutral metadata seam: a domain supplies a `BuildClassData` as `KeymaDomain.classMetadata`
// (the data-model domain); the C++ backend renders the descriptor into each `metadata()` aggregate.
export type { BuildClassData, ClassDataOptions } from "../driver/index.js";

// ── Generic emission helpers, exported so external consumers build on the same engine ──
export { typeTag, irTypeToCpp, memberType, valueBinding, irTypeGuard, irTypeLabel } from "./ir-type-to-cpp.js";
// Statement/return lowering + identifier/context helpers — a domain pack reuses these to emit
// the validator/formatter `ValidatorFn`/`FormatterFn` wrappers it now owns (validators.hpp/formatters.hpp).
export { factoryIdent, stmtToCpp, plainReturn, rewriteContextAccess } from "./emit-validators.js";
export type { ReturnLowerer } from "./emit-validators.js";
export { includePath, cppSanitizer } from "./module-path.js";
export { exprToCpp } from "./emit-expression.js";
export { emitSupportHpp } from "./emit-support.js";

// Built-in `@Service` emission (compiler-owned, base-language concern) — the bundle shell
// emits these directly; exported for tests and direct consumers. The bundle-layout refs +
// emitter deps live alongside their emitters.
export { emitServicesCpp, SERVICES_REF } from "./emit-service.js";
export type { ServiceEmitDeps } from "./emit-service.js";
export { emitServiceClientCpp, SERVICE_CLIENT_REF } from "./emit-service-client.js";
export type { ServiceClientEmitDeps } from "./emit-service-client.js";
