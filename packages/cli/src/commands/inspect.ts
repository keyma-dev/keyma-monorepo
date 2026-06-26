import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { drive } from "@keyma/compiler";
import type { KeymaIR, IRDiagnostic } from "@keyma/core/ir";
import { createTsFrontend } from "../frontend.js";
import { prepareDomains } from "../domains.js";
import { loadResolvedConfig } from "./build.js";
import { readTagManifest } from "../tag-manifest.js";

export type InspectOptions = {
    /** Project root. Defaults to cwd. */
    cwd?: string;
    /** Path to a config file. If omitted, the loader searches `cwd`. */
    configPath?: string;
    /** When set, write the IR JSON to this file instead of returning it only. */
    outFile?: string;
};

export type InspectResult = {
    ir: KeymaIR;
    diagnostics: IRDiagnostic[];
    hasErrors: boolean;
    outFile?: string;
};

/** Run the frontend only and produce the IR JSON for the current project. */
export async function runInspect(opts: InspectOptions = {}): Promise<InspectResult> {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const { config } = await loadResolvedConfig(cwd, opts.configPath);

    // Read the committed tag manifest (binary projects) so the inspected IR carries tags.
    let driveConfig = { ...config, targets: [] };
    if (config.binary === true && config.tagManifestFile !== undefined) {
        const abs = isAbsolute(config.tagManifestFile) ? config.tagManifestFile : join(cwd, config.tagManifestFile);
        const existing = readTagManifest(abs);
        if (existing !== undefined) driveConfig = { ...driveConfig, tagManifest: existing };
    }

    // Resolve domains so the frontend extracts (and IR validation checks) the domain sections.
    const setup = await prepareDomains(config.domains);
    // Drive with no backends — frontend + IR validation only.
    const result = await drive(driveConfig, createTsFrontend(cwd, setup.frontendDomains), []);

    let writtenOut: string | undefined;
    if (opts.outFile !== undefined) {
        const abs = isAbsolute(opts.outFile) ? opts.outFile : join(cwd, opts.outFile);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify(result.ir, null, 2), "utf-8");
        writtenOut = abs;
    }

    return {
        ir: result.ir,
        diagnostics: result.diagnostics,
        hasErrors: result.hasErrors,
        ...(writtenOut !== undefined ? { outFile: writtenOut } : {}),
    };
}
