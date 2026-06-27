// Base class for a generated per-service client. A generated client class (`UserService`) extends
// this, is constructed with a `Transport`, and exposes one async method per service method whose
// body is a single `_call(...)`: build the encoded `CallRequest`, invoke the transport, unwrap
// the envelope (throwing `KeymaError` on failure), and hydrate the return value.

import type { ClassRef, FieldType } from "./fields.js";
import type { Transport } from "./types.js";
import { KeymaError } from "./errors.js";
import { encodeArgs, decodeResult, type ArgSpec } from "./rpc.js";

export class ServiceClient {
    constructor(protected readonly transport: Transport) {}

    /** Marshal a call, invoke the transport, and unwrap/hydrate the result. `args` carry their
     *  declared name + value type (for positional/named encoding); `returnType` drives result
     *  hydration (absent ⇒ void); `refs` resolves class-typed args/returns. */
    protected async _call(
        service: string,
        method: string,
        args: readonly ArgSpec[],
        returnType: FieldType | undefined,
        refs: ReadonlyMap<string, ClassRef> | undefined,
    ): Promise<unknown> {
        const encoding = this.transport.encoding;
        const payload = encodeArgs(encoding, args, refs);
        const result = await this.transport.invoke({ service, method, args: payload });
        if (!result.ok) throw new KeymaError(result.code, result.message, result.details);
        return decodeResult(encoding, result.data, returnType, refs);
    }
}
