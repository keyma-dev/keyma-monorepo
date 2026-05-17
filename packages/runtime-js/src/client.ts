import type { Transport } from "./protocol.js";
import type { KeymaServer } from "./server.js";

// In-process transport that hands the request directly to a KeymaServer.
// Useful for tests and for embedding the server in the same runtime as the
// client (e.g. SSR). Network transports are user-supplied.
export function createDirectTransport(server: KeymaServer): Transport {
    return (request) => server.handle(request);
}
