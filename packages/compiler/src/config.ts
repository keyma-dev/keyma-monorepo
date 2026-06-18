import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { KeymaUserConfig, ResolvedConfig } from "./types.js";

/**
 * Load a keyma config file from disk.
 *
 * Supported formats:
 *   - `.json`  — parsed with JSON.parse
 *   - `.js` / `.mjs` / `.cjs` — loaded via dynamic import (default export)
 *
 * TypeScript configs (.ts) must be pre-compiled to JS before loading.
 */
export async function loadConfig(configPath: string): Promise<KeymaUserConfig> {
    const abs = resolve(configPath);
    const ext = extname(abs).toLowerCase();

    if (ext === ".json") {
        const text = readFileSync(abs, "utf-8");
        return JSON.parse(text) as KeymaUserConfig;
    }

    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
        const url = pathToFileURL(abs).href;
        // import() returns any — the module shape is unknown at compile time
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const mod = await import(url);
        // Support both ESM default exports and CJS module.exports
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const raw: unknown = mod.default !== undefined ? mod.default : mod;
        return raw as KeymaUserConfig;
    }

    if (ext === ".ts") {
        throw new Error(
            `TypeScript config files must be compiled to JavaScript before loading. ` +
            `Use 'tsx' or 'ts-node' to run the CLI, or pre-compile "${abs}" to a ".js" file.`
        );
    }

    throw new Error(`Unsupported config file extension "${ext}". Use .json, .js, or .mjs.`);
}

/** Apply defaults to a user-supplied config object. */
export function resolveConfig(user: KeymaUserConfig): ResolvedConfig {
    const source = user.source === undefined
        ? []
        : Array.isArray(user.source)
            ? user.source
            : [user.source];

    return {
        source,
        ...(user.baseDir !== undefined ? { baseDir: resolve(user.baseDir) } : {}),
        outDir: user.outDir ?? "dist",
        ...(user.irOutFile !== undefined ? { irOutFile: user.irOutFile } : {}),
        targets: user.targets ?? [],
    };
}
