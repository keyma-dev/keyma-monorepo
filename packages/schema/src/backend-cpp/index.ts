// The schema-domain C++ emitter pack (registered by the CLI) plus the underlying emitters.
export { schemaCppEmitterPack } from "./emitter-pack.js";
export { buildClassMetadata as buildClassData } from "../metadata-descriptor.js";
// `@Service` C++ emission is compiler-owned: import `emitServicesCpp`/`emitServiceClientCpp`/
// `SERVICES_REF`/`SERVICE_CLIENT_REF`/`ServiceEmitDeps`/`ServiceClientEmitDeps` from
// `@keyma/compiler/backend-cpp`.
