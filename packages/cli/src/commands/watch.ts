import { watch as fsWatch } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runBuild, loadResolvedConfig, type BuildResult } from "./build.js";
import { resolveSources } from "../sources.js";
import { printDiagnostics } from "../diagnostics.js";

export type WatchOptions = {
    cwd?: string;
    configPath?: string;
    /** Debounce window for rebuilds (ms). Defaults to 100. */
    debounceMs?: number;
    /** Stop after this many rebuilds. Used by tests; omit for indefinite watch. */
    maxRebuilds?: number;
};

export type WatchHandle = {
    /** Resolves after the initial build and any subsequent rebuilds have settled. */
    close(): Promise<void>;
    /** The most recent build result. */
    lastResult(): BuildResult | undefined;
};

/**
 * Watch source files and rebuild on change. Returns a handle whose `close()` stops
 * the watcher. Each rebuild's diagnostics are printed via `printDiagnostics`.
 */
export async function runWatch(opts: WatchOptions = {}): Promise<WatchHandle> {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const debounceMs = opts.debounceMs ?? 100;
    const { config } = await loadResolvedConfig(cwd, opts.configPath);

    const files = await resolveSources(config.source, cwd);
    const dirs = new Set<string>();
    for (const f of files) dirs.add(dirname(f));
    // Also watch top-level pattern roots so newly added files are picked up.
    for (const pattern of config.source) {
        dirs.add(rootForPattern(cwd, pattern));
    }

    let lastResult: BuildResult | undefined;
    let pending: NodeJS.Timeout | undefined;
    let rebuilds = 0;
    let stopped = false;
    let inFlight: Promise<void> = Promise.resolve();

    const triggerBuild = (): void => {
        if (pending !== undefined) clearTimeout(pending);
        pending = setTimeout(() => {
            pending = undefined;
            inFlight = inFlight.then(async () => {
                if (stopped) return;
                lastResult = await runBuild({ cwd, ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}) });
                printDiagnostics(lastResult.diagnostics);
                rebuilds++;
                if (opts.maxRebuilds !== undefined && rebuilds >= opts.maxRebuilds) {
                    stopped = true;
                    for (const w of watchers) w.close();
                }
            });
        }, debounceMs);
    };

    const watchers = [...dirs].map((dir) =>
        fsWatch(dir, { recursive: true }, () => {
            if (!stopped) triggerBuild();
        })
    );

    // Run an initial build immediately.
    lastResult = await runBuild({ cwd, ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}) });
    printDiagnostics(lastResult.diagnostics);
    rebuilds++;

    return {
        async close() {
            stopped = true;
            if (pending !== undefined) clearTimeout(pending);
            for (const w of watchers) w.close();
            await inFlight;
        },
        lastResult: () => lastResult,
    };
}

/** Approximate root directory for a glob pattern (everything before the first wildcard). */
function rootForPattern(cwd: string, pattern: string): string {
    const firstWildcard = pattern.search(/[*?[]/);
    const head = firstWildcard >= 0 ? pattern.slice(0, firstWildcard) : pattern;
    const trimmed = head.replace(/\/[^/]*$/, "");
    const resolved = trimmed === "" ? cwd : trimmed;
    return isAbsolute(resolved) ? resolved : join(cwd, resolved);
}
