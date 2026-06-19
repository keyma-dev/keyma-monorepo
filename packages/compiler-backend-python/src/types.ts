/** Target configuration for the Python backend. */
export type PythonTargetConfig = {
    language: "python";
    outDir: string;
    /** Emit a client bundle (public schemas, no private fields, no index metadata). Default: true. */
    client?: boolean;
    /** Emit a server bundle (all schemas, all fields, index metadata, materializers). Default: true. */
    server?: boolean;
    /**
     * Emit a single unified bundle (all schemas, all fields, materializers) directly into outDir.
     * When true, `client` and `server` are ignored and no client/ or server/ subdirectory is created.
     * Default: false.
     */
    library?: boolean;
};

/** Resolved emit flags after applying defaults. */
export type ResolvedPythonTarget = {
    outDir: string;
    emitClient: boolean;
    emitServer: boolean;
    emitLibrary: boolean;
};

export function resolvePythonTarget(target: PythonTargetConfig): ResolvedPythonTarget {
    const emitLibrary = target.library === true;
    return {
        outDir: target.outDir,
        emitClient: !emitLibrary && (target.client === true || (target.client !== false && target.server !== true)),
        emitServer: !emitLibrary && (target.server === true || (target.server !== false && target.client !== true)),
        emitLibrary,
    };
}
// Defaulting to both client and server if neither is specified, same as JS?
// JS default:
// emitClient: !emitLibrary && target.client !== false,
// emitServer: !emitLibrary && target.server !== false,
// So if both are omitted, both are true.

export function resolvePythonTargetJSStyle(target: PythonTargetConfig): ResolvedPythonTarget {
    const emitLibrary = target.library === true;
    return {
        outDir: target.outDir,
        emitClient: !emitLibrary && target.client !== false,
        emitServer: !emitLibrary && target.server !== false,
        emitLibrary,
    };
}
