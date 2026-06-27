// The slim RPC host. Its entire job: resolve a service + method by the plaintext call header,
// visibility-gate it (probe-resistant — a private service/method is "not found" unless the
// caller is the in-process system identity), inject the `RequestContext`, call the generated
// `dispatch(method, payload, ctx, encoding)`, and wrap the result in the slim envelope. It is
// type-agnostic and encoding-agnostic, and does NO validation — all marshalling is in the
// generated dispatch.

import type {
    CallRequest, CallResult, RequestContext, ServiceMetadata, ServiceProvider, WireEncoding,
} from "./types.js";
import { KeymaError } from "./errors.js";

/** The generated dispatch surface every registered service exposes. */
interface Dispatchable {
    dispatch(method: string, payload: unknown, ctx: RequestContext, encoding: WireEncoding): unknown | Promise<unknown>;
}

type ServiceEntry = { instance: Dispatchable; metadata: ServiceMetadata };

export type ServiceHostOptions = {
    /** Service instances (or zero-arg factories producing them) to register up front. */
    services?: ServiceProvider[];
};

export class ServiceHost {
    private readonly services = new Map<string, ServiceEntry>();

    constructor(options: ServiceHostOptions = {}) {
        for (const provider of options.services ?? []) this.register(provider);
    }

    /** Register a service instance (or factory). The contract is read off the instance's
     *  constructor (`static service`), inherited from the generated abstract base. */
    register(provider: ServiceProvider): void {
        const instance = typeof provider === "function" ? (provider as () => object)() : provider;
        const ctor = instance.constructor as { name?: string; service?: ServiceMetadata };
        const metadata = ctor.service;
        if (metadata === undefined) {
            throw new Error(
                `Service ${ctor.name ?? "<anonymous>"} is missing static service metadata — does it extend the generated service base?`,
            );
        }
        if (this.services.has(metadata.name)) {
            throw new Error(`Duplicate service registered: ${metadata.name}`);
        }
        this.services.set(metadata.name, { instance: instance as Dispatchable, metadata });
    }

    /** Resolve + gate + dispatch a single call, returning the slim envelope. `encoding` tells the
     *  generated dispatch how to read `request.args` and encode the result; it matches the
     *  calling transport's configured encoding. */
    async invoke(
        request: CallRequest,
        ctx: RequestContext = {},
        encoding: WireEncoding = "json",
    ): Promise<CallResult> {
        const isSystem = ctx.identity?.isSystem === true;

        // Resolve the service. Private services are treated as non-existent for non-system
        // callers (probe-resistant).
        const entry = this.services.get(request.service);
        if (entry === undefined || (entry.metadata.visibility === "private" && !isSystem)) {
            return { ok: false, code: "SERVICE_NOT_FOUND", message: `Unknown service: ${request.service}` };
        }

        // Resolve the method. Private methods are likewise hidden from non-system callers.
        const method = entry.metadata.methods.find((m) => m.name === request.method);
        if (method === undefined || (method.visibility === "private" && !isSystem)) {
            return {
                ok: false,
                code: "METHOD_NOT_FOUND",
                message: `Unknown method "${request.method}" on service "${request.service}"`,
            };
        }

        try {
            const data = await entry.instance.dispatch(request.method, request.args, ctx, encoding);
            return { ok: true, data };
        } catch (e) {
            if (e instanceof KeymaError) return { ok: false, code: e.code, message: e.message };
            return { ok: false, code: "HANDLER_ERROR", message: e instanceof Error ? e.message : String(e) };
        }
    }
}
