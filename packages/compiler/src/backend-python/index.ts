export { createPythonBackend, emitPython } from "./backend.js";
export type { PythonTargetConfig } from "./types.js";

// The emitter-registry seam: the class + the pack/contract types. Domain packs (the schema
// pack lives in `@keyma/schema/backend-python`) implement `PythonEmitterPack`.
export { EmitterRegistry } from "./emitter-registry.js";
export type { PythonEmitterPack, BuildSchemaData, SchemaDataOptions, BundleEmitContext } from "./emitter-registry.js";

// ── Generic emission helpers, exported so domain emitter packs build on the same engine ──
export { mkRaw, emitLiteral } from "./emit-literal.js";
export { factoryIdent, moduleHeader, renderStatements } from "./emit-validators.js";
export { exprToPython, intrinsicImports } from "./emit-expression.js";
export { irTypeToPython, irTypeGuard, irTypeLabel } from "./ir-type-to-python.js";
