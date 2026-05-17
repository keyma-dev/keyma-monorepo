import { readFileSync, existsSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import ts from "typescript";
import { loadConfig as loadJsonOrJsConfig } from "@keyma/compiler";
import type { KeymaUserConfig } from "@keyma/compiler";

const CONFIG_BASENAMES = [
    "keyma.config.ts",
    "keyma.config.mjs",
    "keyma.config.cjs",
    "keyma.config.js",
    "keyma.config.json",
];

/** Find a keyma config file under `dir`. Returns the absolute path, or undefined. */
export function findConfig(dir: string): string | undefined {
    for (const name of CONFIG_BASENAMES) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
}

/**
 * Load a keyma config from disk. Supports `.json`, `.js`, `.mjs`, `.cjs`, and `.ts`.
 * TypeScript configs are transpiled in memory and imported via a data: URL — runtime
 * imports inside the config will not resolve, but `import type` declarations are
 * stripped during transpile and work fine.
 */
export async function loadProjectConfig(configPath: string): Promise<KeymaUserConfig> {
    const abs = resolve(configPath);
    if (extname(abs).toLowerCase() === ".ts") {
        return loadTsConfig(abs);
    }
    return loadJsonOrJsConfig(abs);
}

async function loadTsConfig(absPath: string): Promise<KeymaUserConfig> {
    const source = readFileSync(absPath, "utf-8");
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            isolatedModules: true,
        },
        fileName: absPath,
    });
    const dataUrl = `data:text/javascript;base64,${Buffer.from(outputText, "utf-8").toString("base64")}`;
    const mod: unknown = await import(dataUrl);
    const raw = (mod as { default?: unknown }).default ?? mod;
    return raw as KeymaUserConfig;
}

