export { createCppBackend, emitCpp } from "./backend.js";
export type { CppTargetConfig } from "./types.js";

// The emitter-registry seam: the class, the bundle-layout refs, and the pack/contract types.
// Domain packs (the schema pack lives in `@keyma/schema/backend-cpp`) implement `CppEmitterPack`.
export { EmitterRegistry, SERVICES_REF, SERVICE_CLIENT_REF } from "./emitter-registry.js";
export type {
    CppEmitterPack,
    BuildSchemaMeta,
    EmitEnumClass,
    EmitEnumConversions,
    SchemaDataOptions,
    ServiceEmitDeps,
    ServiceClientEmitDeps,
    BundleEmitContext,
} from "./emitter-registry.js";

// ── Generic emission helpers, exported so domain emitter packs build on the same engine ──
export { typeTag, irTypeToCpp, memberType, valueBinding, irTypeGuard } from "./ir-type-to-cpp.js";
export { buildFactoryCall } from "./emit-validators.js";
export { includePath, cppSanitizer } from "./module-path.js";
export { exprToCpp } from "./emit-expression.js";
export { emitSupportHpp } from "./emit-support.js";
