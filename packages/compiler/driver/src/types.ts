import type { KeymaIR, IRDiagnostic, TagManifest } from "@keyma/core/ir";

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
    /** Enable binary serialization: assign stable wire tags via a committed manifest and
     *  emit `IRField.tag`. JSON-only projects leave this off (the default). */
    binary?: boolean;
    /** Location of the committed tag manifest. Defaults to `keyma.tags.json` beside the
     *  sources. Used only when `binary` is true. */
    tagManifestFile?: string;
    /** Domain packages to load (e.g. `["@keyma/schema"]`). The CLI resolves each named
     *  package's `keymaDomain` descriptor and wires it across the extension seams. Omit to
     *  let the CLI auto-detect the installed built-in domains; set `[]` to emit core only.
     *  The driver itself ignores this — it is metadata for the CLI's domain resolution. */
    domains?: string[];
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
    /** Binary serialization enabled — drives the frontend's `assignTags` pass. */
    binary?: boolean;
    /** Resolved path to the committed tag manifest (used only when `binary`). */
    tagManifestFile?: string;
    /** The committed tag manifest, read from disk by the CLI before `drive()`. Threaded to
     *  the frontend as data; the driver/frontend never touch the filesystem. */
    tagManifest?: TagManifest;
    /** Accept tag drift (CLI `--accept-tags`) — suppresses the KEYMA100 hard error. */
    acceptTags?: boolean;
    /** Domain packages to load. See {@link KeymaUserConfig.domains}. Undefined means
     *  "auto-detect"; an explicit (possibly empty) list overrides detection. */
    domains?: string[];
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
    compile(config: ResolvedConfig): Promise<{ ir: KeymaIR; diagnostics: IRDiagnostic[]; tagManifest?: TagManifest }>;
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
    /** The updated tag manifest (present only when binary is enabled). The CLI persists it. */
    tagManifest?: TagManifest;
};
