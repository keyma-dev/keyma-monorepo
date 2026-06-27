// In-process transport — hands a `CallRequest` straight to the host with no encode/decode hop
// (the generated client already encoded the args; the host's dispatch decodes them). Useful for
// tests and for embedding the host in the same runtime as the client (SSR). Network transports
// are user-supplied.
//
// The forwarded context is caller-supplied and DEFAULT NON-SYSTEM, so visibility gating is
// exercised; `isSystem: true` opts into the in-process system identity (bypasses gating) for SSR.

import type {
    CallRequest, CallResult, RequestContext, Transport, TransportCapabilities, WireEncoding,
} from "./types.js";
import type { ServiceHost } from "./service-host.js";

const NO_STREAMING: TransportCapabilities = { serverStream: false, clientStream: false, bidi: false };

export type DirectTransportOptions = {
    /** Wire encoding a bound client marshals with. Default `"json"`. */
    encoding?: WireEncoding;
    /** Forward the context as the in-process system identity (bypasses visibility gating).
     *  Default false, so gating is exercised; opt in for trusted SSR. */
    isSystem?: boolean;
    /** Per-call context factory (e.g. request-scoped auth). */
    context?: () => RequestContext | Promise<RequestContext>;
};

export function createDirectTransport(host: ServiceHost, options: DirectTransportOptions = {}): Transport {
    const encoding: WireEncoding = options.encoding ?? "json";
    return {
        encoding,
        capabilities: NO_STREAMING,
        async invoke(request: CallRequest): Promise<CallResult> {
            const base: RequestContext = options.context ? await options.context() : {};
            const ctx: RequestContext = options.isSystem
                ? { ...base, identity: { ...(base.identity ?? {}), isSystem: true } }
                : base;
            return host.invoke(request, ctx, encoding);
        },
    };
}
