/** Target configuration for the JavaScript backend. */
export type JsTargetConfig = {
    language: "js";
    outDir: string;
    /** Emit a client bundle (public classes, no private members, no index metadata). Default: true. */
    client?: boolean;
    /** Emit a server bundle (all classes, all members, index metadata). Default: true. */
    server?: boolean;
    /**
     * Emit a single unified bundle (all classes, all members) directly into outDir.
     * When true, `client` and `server` are ignored and no client/ or server/ subdirectory is created.
     * Default: false.
     */
    library?: boolean;
};

/** Resolved emit flags after applying defaults. */
export type ResolvedJsTarget = {
    outDir: string;
    emitClient: boolean;
    emitServer: boolean;
    emitLibrary: boolean;
};

export function resolveJsTarget(target: JsTargetConfig): ResolvedJsTarget {
    const emitLibrary = target.library === true;
    return {
        outDir: target.outDir,
        emitClient: !emitLibrary && target.client !== false,
        emitServer: !emitLibrary && target.server !== false,
        emitLibrary,
    };
}
