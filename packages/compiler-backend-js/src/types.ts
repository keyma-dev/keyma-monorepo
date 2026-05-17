/** Target configuration for the JavaScript backend. */
export type JsTargetConfig = {
    language: "js";
    outDir: string;
    /** Emit a client bundle (public schemas, no private fields, no index metadata). Default: true. */
    client?: boolean;
    /** Emit a server bundle (all schemas, all fields, index metadata, materializers). Default: true. */
    server?: boolean;
};

/** Resolved emit flags after applying defaults. */
export type ResolvedJsTarget = {
    outDir: string;
    emitClient: boolean;
    emitServer: boolean;
};

export function resolveJsTarget(target: JsTargetConfig): ResolvedJsTarget {
    return {
        outDir: target.outDir,
        emitClient: target.client !== false,
        emitServer: target.server !== false,
    };
}
