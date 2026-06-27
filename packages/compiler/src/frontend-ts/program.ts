import ts from "typescript";
import { createVirtualCompilerHost } from "@typescript/vfs";

export type VirtualFiles = ReadonlyMap<string, string>;

/** How `createProgram` obtains its files. At most one of these is set. */
export type CreateProgramOptions = {
    /** In-memory overlay served on top of the real Node filesystem (Node only). */
    virtualFiles?: VirtualFiles;
    /**
     * A fully in-memory `ts.System` (e.g. from `@typescript/vfs createSystem`). When
     * present, the program is built with a virtual compiler host that touches NO real
     * filesystem — this is the browser-capable path. Takes precedence over `virtualFiles`.
     */
    system?: ts.System;
};

/** Default compiler options for compiling user source files. */
export const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    experimentalDecorators: true,
    noEmit: true,
    skipLibCheck: true,
};

/**
 * Creates a TypeScript Program from the given root file names.
 *
 * Three modes, selected by `opts`:
 *  - `system`        → fully virtual, in-memory host (no real fs). Browser-capable.
 *  - `virtualFiles`  → in-memory overlay on top of the real Node fs (Node only).
 *  - neither         → the real Node compiler host reading from disk (Node only).
 *
 * The latter two require Node (`ts.createCompilerHost` uses `ts.sys`); reaching them
 * in a non-Node environment throws a clear error rather than a cryptic `ts.sys` crash.
 */
export function createProgram(
    rootFileNames: readonly string[],
    options: ts.CompilerOptions = DEFAULT_COMPILER_OPTIONS,
    opts: CreateProgramOptions = {}
): ts.Program {
    // Mode 3 — fully virtual: no ts.sys, no ts.createCompilerHost. Browser-safe.
    if (opts.system !== undefined) {
        const { compilerHost } = createVirtualCompilerHost(opts.system, options, ts);
        return ts.createProgram([...rootFileNames], options, compilerHost);
    }

    // Modes 1 & 2 need a real Node host (disk access). Guard so browser misuse is legible.
    if (!isNode()) {
        throw new Error(
            "createProgram requires an in-memory `system` (e.g. @typescript/vfs createSystem) " +
                "when not running under Node — the real filesystem is unavailable."
        );
    }

    const defaultHost = ts.createCompilerHost(options);
    if (opts.virtualFiles !== undefined) {
        // Mode 2 — in-memory overlay on the real fs.
        const host = createInMemoryHost(opts.virtualFiles, defaultHost);
        return ts.createProgram([...rootFileNames], options, host);
    }
    // Mode 1 — disk.
    return ts.createProgram([...rootFileNames], options, defaultHost);
}

/** True when running under Node (where `ts.sys`/`ts.createCompilerHost` can touch disk). */
function isNode(): boolean {
    return typeof globalThis.process !== "undefined" && globalThis.process.versions?.node !== undefined;
}

function createInMemoryHost(
    virtualFiles: VirtualFiles,
    defaultHost: ts.CompilerHost
): ts.CompilerHost {
    return {
        ...defaultHost,
        getSourceFile(fileName, languageVersion, onError) {
            const content = virtualFiles.get(fileName);
            if (content !== undefined) {
                return ts.createSourceFile(fileName, content, languageVersion);
            }
            return defaultHost.getSourceFile(fileName, languageVersion, onError);
        },
        fileExists(fileName) {
            return virtualFiles.has(fileName) || defaultHost.fileExists(fileName);
        },
        readFile(fileName) {
            const v = virtualFiles.get(fileName);
            return v !== undefined ? v : defaultHost.readFile(fileName);
        },
    };
}
