// The single RPC error type. A generated client unwraps the slim `CallResult` envelope and
// throws this on failure; the host catches it (or any thrown value) and folds it back into a
// failure envelope. `code` is one of the framework codes below or a transport-owned code.

/** Framework error codes. Transports may add their own (e.g. connection/timeout) codes.
 *  `VALIDATION_ERROR` is the conventional code an impl throws (carrying structured `details`)
 *  after an opt-in `validate(Model.metadata, arg)` rejects an inbound model argument. */
export type KeymaErrorCode =
    | "SERVICE_NOT_FOUND"
    | "METHOD_NOT_FOUND"
    | "METHOD_NOT_IMPLEMENTED"
    | "HANDLER_ERROR"
    | "VALIDATION_ERROR"
    | (string & {});

export class KeymaError extends Error {
    /** Structured, code-specific error payload carried over the wire alongside `code`/`message`
     *  — e.g. the `ValidationError[]` a `VALIDATION_ERROR` carries. Domain-neutral (`unknown`):
     *  the RPC stack never inspects it; the host folds it into the failure envelope and the
     *  generated client re-throws it. */
    readonly details?: unknown;

    constructor(
        public readonly code: KeymaErrorCode,
        message: string,
        details?: unknown,
    ) {
        super(message);
        this.name = "KeymaError";
        if (details !== undefined) this.details = details;
    }
}
