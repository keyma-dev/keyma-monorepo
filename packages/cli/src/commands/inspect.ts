import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { drive } from "@keyma/compiler";
import type { KeymaIR, IRDiagnostic } from "@keyma/ir";
import { createTsFrontend } from "../frontend.js";
import { loadResolvedConfig } from "./build.js";

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

    // Drive with no backends — frontend + IR validation only.
    const result = await drive({ ...config, targets: [] }, createTsFrontend(cwd), []);

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
