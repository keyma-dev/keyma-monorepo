export { createPythonBackend, emitPython } from "./backend.js";
export type { PythonTargetConfig } from "./types.js";

// The emitter-registry seam: the class + the pack/contract types. Domain packs (the data-model
// domain's pack, registered by the CLI) implement `PythonEmitterPack`.
export { EmitterRegistry } from "./emitter-registry.js";
export type { PythonEmitterPack, BuildClassData, ClassDataOptions, BundleEmitContext } from "./emitter-registry.js";

// ── Generic emission helpers, exported so domain emitter packs build on the same engine ──
export { mkRaw, emitLiteral } from "./emit-literal.js";
export { factoryIdent, renderStatements } from "./emit-validators.js";
export { exprToPython, intrinsicImports } from "./emit-expression.js";
export { irTypeToPython, irTypeGuard, irTypeLabel } from "./ir-type-to-python.js";
