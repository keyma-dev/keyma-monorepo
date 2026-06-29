export { createJsBackend, emitJs } from "./backend.js";
export type { JsBackendOptions } from "./backend.js";
export type { JsTargetConfig } from "./types.js";

// The neutral metadata seam: a domain supplies a `BuildClassData` as `KeymaDomain.classMetadata`
// (the data-model domain); the JS backend renders the descriptor into `<Class>.metadata`.
export type { BuildClassData, ClassDataOptions } from "../driver/index.js";

// ── Generic emission helpers, exported so external consumers build on the same engine ──
export { irTypeToTs, jsTypeGuard, irTypeLabel } from "./ir-type-to-ts.js";
export { exprToJs, stmtToJs } from "./emit-expression.js";
export { emitTypesJs, emitTypesDts } from "./emit-types.js";
export { emitLiteral, mkRaw } from "./emit-literal.js";
export { factoryIdent } from "./emit-validators.js";
export { relModuleSpecifier } from "./module-path.js";

// Built-in `@Service` emission (compiler-owned, base-language concern) — the bundle shell
// emits these directly; exported for tests and direct consumers.
export { emitServicesJs, emitServicesDts, SERVICES_REF } from "./emit-service.js";
export type { ServiceEmitFiles, ServiceEmitDeps } from "./emit-service.js";
