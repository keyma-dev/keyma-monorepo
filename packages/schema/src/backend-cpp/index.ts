// The schema-domain C++ emitter pack (registered by the CLI) plus the underlying emitters.
export { schemaCppEmitterPack } from "./emitter-pack.js";
export { buildSchemaData } from "./schema-data.js";
export type { SchemaDataOptions } from "./schema-data.js";
export { emitServicesCpp, SERVICES_REF } from "./emit-service.js";
export type { ServiceEmitDeps } from "./emit-service.js";
export { emitServiceClientCpp, SERVICE_CLIENT_REF } from "./emit-service-client.js";
export type { ServiceClientEmitDeps } from "./emit-service-client.js";
