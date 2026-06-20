import type { KeymaIR, IRDiagnostic } from "@keyma/ir";

/** Per-target output configuration. Language-specific options are passed through as-is. */
export type KeymaTargetConfig = {
    language: string;
    outDir: string;
    [key: string]: unknown;
};

/** User-facing configuration (from keyma.config.ts / .js / .json). */
export type KeymaUserConfig = {
    /** Source glob(s) for schema files. */
    source?: string | string[];
    /** Base directory for source files. Used to calculate relative paths. */
    baseDir?: string;
    /** Root output directory. */
    outDir?: string;
    /** Path to write the IR JSON file. Omit to skip. */
    irOutFile?: string;
    /** Prefix prepended to every generated schema/service `name` (the canonical
     *  identity used for references, registries, RPC, serialization and DB
     *  naming). Namespaces the project so the same class names can coexist across
     *  libraries. Concatenated verbatim — include any separator yourself (e.g.
     *  `"blog_"`). Defaults to "" (no prefix). */
    schemaPrefix?: string;
    /** One entry per code-generation target. */
    targets?: KeymaTargetConfig[];
};

/** Resolved configuration with all defaults applied. Passed to frontend and backend plugins. */
export type ResolvedConfig = {
    source: string[];
    baseDir?: string;
    outDir: string;
    irOutFile?: string;
    /** Prefix for every schema/service `name`. See {@link KeymaUserConfig.schemaPrefix}. */
    schemaPrefix: string;
    targets: KeymaTargetConfig[];
};

/** A single file to be written by the driver. */
export type EmitFile = {
    path: string;
    content: string | Uint8Array;
};

/** Result returned by a backend's emit() call. */
export type EmitResult = {
    files: EmitFile[];
    diagnostics: IRDiagnostic[];
};

/** Frontend plugin interface. */
export interface KeymaFrontend {
    name: string;
    sourceExtensions: string[];
    compile(config: ResolvedConfig): Promise<{ ir: KeymaIR; diagnostics: IRDiagnostic[] }>;
}

/** Backend plugin interface. */
export interface KeymaBackend {
    name: string;
    /** The target language this backend handles (matches KeymaTargetConfig.language). */
    target: string;
    emit(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult>;
}

/** Aggregated result of a full driver run. */
export type DriveResult = {
    ir: KeymaIR;
    /** Files the driver should write to disk. */
    emitted: EmitFile[];
    /** All diagnostics from frontend, IR validation, and backends. */
    diagnostics: IRDiagnostic[];
    /** True if any diagnostic has severity "error". */
    hasErrors: boolean;
};
