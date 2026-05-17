import type { Transport } from "./protocol.js";
import type { KeymaServer } from "./server.js";
import type { RequestContext } from "./plugin.js";

// In-process transport that hands the request directly to a KeymaServer.
// Useful for tests and for embedding the server in the same runtime as the
// client (e.g. SSR). Network transports are user-supplied.
//
// An optional contextFactory is invoked per request and forwarded to
// server.handle() — use this to supply per-request identity (e.g. derived from
// AsyncLocalStorage in a server framework).
export function createDirectTransport(
    server: KeymaServer,
    contextFactory?: () => RequestContext | Promise<RequestContext>,
): Transport {
    if (contextFactory === undefined) {
        return (request) => server.handle(request);
    }
    return async (request) => {
        const context = await contextFactory();
        return server.handle(request, context);
    };
}
