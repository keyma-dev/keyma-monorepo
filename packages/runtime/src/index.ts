// @keyma/runtime — the authored source-of-truth + isolated test bed for the JS runtime the
// compiler BAKES into self-contained generated bundles. Generated code never imports this
// package; the codec + RPC stack here are copied verbatim into bundle-local modules.

// ── Codec (the kept base) ──────────────────────────────────────────────────
export { serialize, serializeValue } from "./serialize.js";
export type { Refs } from "./serialize.js";
export { deserialize, deserializeValue } from "./deserialize.js";
export {
    encodeBinary, decodeBinary, encodeRecord, decodeRecord,
    encodePayload, decodeValue, wiretypeOf,
} from "./binary.js";
export type { Reader } from "./binary.js";
export { allFields, allRefs, targetOf } from "./fields.js";
export type { ClassMeta, ClassRef, FieldMeta, FieldType } from "./fields.js";

// ── RPC stack ──────────────────────────────────────────────────────────────
export { ServiceHost } from "./service-host.js";
export type { ServiceHostOptions } from "./service-host.js";
export { createDirectTransport } from "./direct-transport.js";
export type { DirectTransportOptions } from "./direct-transport.js";
export { ServiceClient } from "./client.js";
export { encodeArgs, decodeArgs, encodeResult, decodeResult } from "./rpc.js";
export type { ArgSpec, ParamSpec, RpcRefs } from "./rpc.js";
export { KeymaError } from "./errors.js";
export type { KeymaErrorCode } from "./errors.js";

// ── Wire + service types ────────────────────────────────────────────────────
export type {
    WireEncoding,
    Transport,
    TransportCapabilities,
    CallRequest,
    CallResult,
    ServiceMetadata,
    ServiceMethodMetadata,
    ServiceClass,
    ServiceInstance,
    ServiceProvider,
    RequestContext,
} from "./types.js";
