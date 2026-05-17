import { glob } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Resolve user-supplied glob patterns to absolute file paths.
 * Patterns are interpreted relative to `cwd`. Duplicates are removed.
 */
export async function resolveSources(patterns: readonly string[], cwd: string): Promise<string[]> {
    const seen = new Set<string>();
    for (const pattern of patterns) {
        for await (const match of glob(pattern, { cwd })) {
            seen.add(resolve(cwd, match));
        }
    }
    return [...seen].sort();
}
