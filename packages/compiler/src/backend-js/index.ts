export { createJsBackend, emitJs } from "./backend.js";
export type { JsTargetConfig } from "./types.js";

// The emitter-registry seam: the class + the pack/contract types. Domain packs (the schema
// pack lives in `@keyma/schema/backend-js`) implement `JsEmitterPack`; the CLI registers them.
export { EmitterRegistry } from "./emitter-registry.js";
export type { JsEmitterPack, BuildSchemaData, SchemaDataOptions, ServiceEmitDeps, BundleEmitContext, SchemaDtsContext, SchemaDtsShape } from "./emitter-registry.js";

// ── Generic emission helpers, exported so domain emitter packs build on the same engine ──
export { irTypeToTs } from "./ir-type-to-ts.js";
export { exprToJs } from "./emit-expression.js";
export { emitTypesJs, emitTypesDts } from "./emit-types.js";
export { emitLiteral, mkRaw } from "./emit-literal.js";
export { buildFactoryCall } from "./emit-validators.js";
export { buildApplyDefaults } from "./emit-defaults.js";
export { relModuleSpecifier } from "./module-path.js";
