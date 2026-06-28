export { createJsBackend, emitJs } from "./backend.js";
export type { JsTargetConfig } from "./types.js";

// The emitter-registry seam: the class + the pack/contract types. Domain packs (registered by
// the CLI) implement `JsEmitterPack`; the CLI registers them.
export { EmitterRegistry } from "./emitter-registry.js";
export type { JsEmitterPack, BuildClassData, ClassDataOptions, ServiceEmitDeps, BundleEmitContext, ClassDtsContext, ClassDtsShape } from "./emitter-registry.js";

// ── Generic emission helpers, exported so domain emitter packs build on the same engine ──
export { irTypeToTs, jsTypeGuard, irTypeLabel } from "./ir-type-to-ts.js";
export { exprToJs, stmtToJs } from "./emit-expression.js";
export { emitTypesJs, emitTypesDts } from "./emit-types.js";
export { emitLiteral, mkRaw } from "./emit-literal.js";
export { factoryIdent } from "./emit-validators.js";
export { relModuleSpecifier } from "./module-path.js";

// Built-in `@Service` emission (compiler-owned, base-language concern) — the bundle shell
// emits these directly; exported for tests and direct consumers.
export { emitServicesJs, emitServicesDts, SERVICES_REF } from "./emit-service.js";
export type { ServiceEmitFiles } from "./emit-service.js";
