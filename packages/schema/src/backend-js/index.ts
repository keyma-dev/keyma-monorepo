// The schema-domain JS emitter pack (registered by the CLI into the generic JS backend's
// EmitterRegistry) plus the underlying builders, exported for tests.
export { schemaJsEmitterPack } from "./emitter-pack.js";
export { buildClassData } from "./schema-data.js";
export { shapeClassDts } from "./schema-dts.js";
export type { ClassDataOptions } from "./schema-data.js";
// `@Service` JS emission is compiler-owned: import `emitServicesJs`/`emitServicesDts`/
// `SERVICES_REF`/`ServiceEmitDeps` from `@keyma/compiler/backend-js`.
