// The single RPC error type. A generated client unwraps the slim `CallResult` envelope and
// throws this on failure; the host catches it (or any thrown value) and folds it back into a
// failure envelope. `code` is one of the framework codes below or a transport-owned code.

/** Framework error codes. Transports may add their own (e.g. connection/timeout) codes. */
export type KeymaErrorCode =
    | "SERVICE_NOT_FOUND"
    | "METHOD_NOT_FOUND"
    | "METHOD_NOT_IMPLEMENTED"
    | "HANDLER_ERROR"
    | (string & {});

export class KeymaError extends Error {
    constructor(
        public readonly code: KeymaErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "KeymaError";
    }
}
