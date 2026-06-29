export { createPythonBackend, emitPython } from "./backend.js";
export type { PythonBackendOptions } from "./backend.js";
export type { PythonTargetConfig } from "./types.js";

// The neutral metadata seam: a domain supplies a `BuildClassData` as `KeymaDomain.classMetadata`
// (the data-model domain); the Python backend renders the descriptor into each class's metadata.
export type { BuildClassData, ClassDataOptions } from "../driver/index.js";

// `@Service`/RPC emission (compiler-owned, emitted directly off `ir.services` — no domain pack).
export { emitServicesPython, SERVICES_REF } from "./emit-service.js";
export type { ServiceEmitDeps } from "./emit-service.js";
export { EMITTED_PY_RUNTIME, EMITTED_PY_RUNTIME_MODULE } from "./emitted-runtime.js";

// ── Generic emission helpers, exported so external consumers build on the same engine ──
export { mkRaw, emitLiteral } from "./emit-literal.js";
export { factoryIdent, renderStatements } from "./emit-validators.js";
export { exprToPython, intrinsicImports } from "./emit-expression.js";
export { irTypeToPython, irTypeGuard, irTypeLabel } from "./ir-type-to-python.js";
