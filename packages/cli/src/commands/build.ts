import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { drive, resolveConfig } from "@keyma/compiler";
import type { EmitFile, KeymaBackend, ResolvedConfig } from "@keyma/compiler";
import { jsBackend } from "@keyma/compiler-backend-js";
import { pythonBackend } from "@keyma/compiler-backend-python";
import { cppBackend } from "@keyma/compiler-backend-cpp";
import type { KeymaIR, IRDiagnostic } from "@keyma/ir";
import { findConfig, loadProjectConfig } from "../config.js";
import { createTsFrontend } from "../frontend.js";
import { readTagManifest, writeTagManifestIfChanged } from "../tag-manifest.js";

const DEFAULT_BACKENDS: KeymaBackend[] = [jsBackend, pythonBackend, cppBackend];

export type BuildOptions = {
    /** Project root. Defaults to cwd. */
    cwd?: string;
    /** Path to a config file. If omitted, the loader searches `cwd`. */
    configPath?: string;
    /** Override the backends used by the driver. Defaults to the bundled JS backend. */
    backends?: KeymaBackend[];
    /** Accept binary tag drift (`--accept-tags`) — suppresses the KEYMA100 un-hinted-rename
     *  hard error and rewrites the manifest. The analogue of `UPDATE_SNAPSHOTS`. */
    acceptTags?: boolean;
};

export type BuildResult = {
    ir: KeymaIR;
    written: string[];
    diagnostics: IRDiagnostic[];
    hasErrors: boolean;
};

/** Run the compiler pipeline and write emitted files to disk. */
export async function runBuild(opts: BuildOptions = {}): Promise<BuildResult> {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const { config: baseConfig } = await loadResolvedConfig(cwd, opts.configPath);

    // Binary tag manifest: read the committed file (the only real-fs touch) and thread it +
    // the --accept-tags flag through to the pure compiler as data.
    let config = baseConfig;
    const manifestPath =
        baseConfig.binary === true && baseConfig.tagManifestFile !== undefined
            ? absolutize(cwd, baseConfig.tagManifestFile)
            : undefined;
    if (manifestPath !== undefined) {
        const existing = readTagManifest(manifestPath);
        config = {
            ...baseConfig,
            ...(existing !== undefined ? { tagManifest: existing } : {}),
            ...(opts.acceptTags === true ? { acceptTags: true } : {}),
        };
    }

    const frontend = createTsFrontend(cwd);
    const backends = opts.backends ?? DEFAULT_BACKENDS;
    const driveResult = await drive(config, frontend, backends);

    const written: string[] = [];
    if (!driveResult.hasErrors) {
        for (const file of driveResult.emitted) {
            written.push(writeEmitFile(cwd, file));
        }
        if (config.irOutFile !== undefined) {
            const irPath = absolutize(cwd, config.irOutFile);
            mkdirSync(dirname(irPath), { recursive: true });
            writeFileSync(irPath, JSON.stringify(driveResult.ir, null, 2), "utf-8");
            written.push(irPath);
        }
        // Persist the updated tag manifest after a clean build (idempotent — only when changed).
        if (manifestPath !== undefined && driveResult.tagManifest !== undefined) {
            if (writeTagManifestIfChanged(manifestPath, driveResult.tagManifest)) {
                written.push(manifestPath);
            }
        }
    }

    return {
        ir: driveResult.ir,
        written,
        diagnostics: driveResult.diagnostics,
        hasErrors: driveResult.hasErrors,
    };
}

/** Resolve a CLI config path (or auto-find one in cwd) into a `ResolvedConfig`. */
export async function loadResolvedConfig(
    cwd: string,
    explicitPath?: string
): Promise<{ configPath: string; config: ResolvedConfig }> {
    const configPath = explicitPath !== undefined
        ? absolutize(cwd, explicitPath)
        : findConfig(cwd);
    if (configPath === undefined) {
        throw new Error(
            `No keyma config found in "${cwd}". Expected keyma.config.{ts,js,mjs,cjs,json}.`
        );
    }
    const user = await loadProjectConfig(configPath);
    const config = resolveConfig(user);
    // Make outDir + irOutFile + target outDirs resolvable relative to cwd later.
    // We keep them as-is in the resolved config; absolutization happens at write time.
    return { configPath, config };
}

function writeEmitFile(cwd: string, file: EmitFile): string {
    const abs = absolutize(cwd, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
    return abs;
}

function absolutize(cwd: string, p: string): string {
    return isAbsolute(p) ? p : join(cwd, p);
}
