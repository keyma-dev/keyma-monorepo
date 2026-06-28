// The schema-domain JS emitter pack (registered by the CLI into the generic JS backend's
// EmitterRegistry) plus the underlying builders, exported for tests.
export { schemaJsEmitterPack } from "./emitter-pack.js";
export { buildClassMetadata as buildClassData } from "../metadata-descriptor.js";
export { shapeClassDts } from "./schema-dts.js";
// `@Service` JS emission is compiler-owned: import `emitServicesJs`/`emitServicesDts`/
// `SERVICES_REF`/`ServiceEmitDeps` from `@keyma/compiler/backend-js`.
