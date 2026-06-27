export { createPythonBackend, emitPython } from "./backend.js";
export type { PythonTargetConfig } from "./types.js";

// The emitter-registry seam: the class + the pack/contract types. Domain packs (the data-model
// domain's pack, registered by the CLI) implement `PythonEmitterPack`.
export { EmitterRegistry } from "./emitter-registry.js";
export type { PythonEmitterPack, BuildClassData, ClassDataOptions, BundleEmitContext } from "./emitter-registry.js";

// `@Service`/RPC emission (compiler-owned, emitted directly off `ir.services` — no domain pack).
export { emitServicesPython, SERVICES_REF } from "./emit-service.js";
export type { ServiceEmitDeps } from "./emit-service.js";
export { EMITTED_PY_RUNTIME, EMITTED_PY_RUNTIME_MODULE } from "./emitted-runtime.js";

// ── Generic emission helpers, exported so domain emitter packs build on the same engine ──
export { mkRaw, emitLiteral } from "./emit-literal.js";
export { factoryIdent, renderStatements } from "./emit-validators.js";
export { exprToPython, intrinsicImports } from "./emit-expression.js";
export { irTypeToPython, irTypeGuard, irTypeLabel } from "./ir-type-to-python.js";
