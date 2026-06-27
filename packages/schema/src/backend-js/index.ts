// The schema-domain JS emitter pack (registered by the CLI into the generic JS backend's
// EmitterRegistry) plus the underlying builders, exported for tests.
export { schemaJsEmitterPack } from "./emitter-pack.js";
export { buildSchemaData } from "./schema-data.js";
export { shapeSchemaDts } from "./schema-dts.js";
export type { SchemaDataOptions } from "./schema-data.js";
// `@Service` JS emission is compiler-owned: import `emitServicesJs`/`emitServicesDts`/
// `SERVICES_REF`/`ServiceEmitDeps` from `@keyma/compiler/backend-js`.
