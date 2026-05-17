import ts from "typescript";

export type VirtualFiles = ReadonlyMap<string, string>;

/** Default compiler options for compiling user schema files. */
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
 * When `virtualFiles` is provided, those paths are served from memory while all
 * other files (stdlib, node_modules) are read from the real file system.
 */
export function createProgram(
    rootFileNames: readonly string[],
    options: ts.CompilerOptions = DEFAULT_COMPILER_OPTIONS,
    virtualFiles?: VirtualFiles
): ts.Program {
    const defaultHost = ts.createCompilerHost(options);
    if (!virtualFiles) {
        return ts.createProgram([...rootFileNames], options, defaultHost);
    }
    const host = createInMemoryHost(virtualFiles, defaultHost);
    return ts.createProgram([...rootFileNames], options, host);
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
