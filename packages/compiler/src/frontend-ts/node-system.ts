// NODE ONLY. This module reads the real filesystem and must NEVER be imported by the
// browser-safe core (`program.ts`/`compile.ts`/`index.ts`). It is exposed via the
// dedicated `@keyma/compiler/frontend-ts/node` subpath export.
//
// It assembles a fully in-memory `ts.System` (the same kind a browser would build) from
// disk: the TypeScript standard library `.d.ts` set plus the `@keyma/core` sources and any
// caller-supplied authoring packages (a domain package provides its own DSL/function
// libraries), laid out under a virtual `/node_modules/@keyma/*` tree so NodeNext module
// resolution resolves them in-memory.
// The returned system touches no disk afterward — pass it to `compile`/`compileVirtual`
// (via `config.system`) to exercise the browser path from Node.

import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createDefaultMapFromNodeModules, createSystem } from "@typescript/vfs";
import { DEFAULT_COMPILER_OPTIONS } from "./program.js";

export type NodeSystemOptions = {
    /** Compiler options used to select the TS lib files. Defaults to {@link DEFAULT_COMPILER_OPTIONS}. */
    compilerOptions?: ts.CompilerOptions;
    /** Directory to start the `node_modules/@keyma/*` lookup from. Defaults to this module's location. */
    packagesFrom?: string;
    /** Additional authoring packages to vendor into the virtual filesystem, on top of the
     *  always-included `@keyma/core`. A domain caller adds its own authoring package(s) here so
     *  the virtual sources can import the domain's DSL/function libraries. Defaults to none. */
    packages?: readonly string[];
};

/** The package always vendored in (its DSL is the core authoring surface every domain builds on). */
const CORE_PACKAGES = ["@keyma/core"] as const;

/**
 * Build a fully in-memory `ts.System` pre-loaded with the TS lib files, the `@keyma/core`
 * authoring package, and any caller-supplied domain packages, read from disk once. The result
 * is the browser-capable virtual filesystem; feed it to `compileVirtual(sources, { system })`.
 */
export function createKeymaNodeSystem(opts: NodeSystemOptions = {}): ts.System {
    const options = opts.compilerOptions ?? DEFAULT_COMPILER_OPTIONS;
    // Reads every `lib.*.d.ts` (incl. lib.decorators*.d.ts) from the installed typescript,
    // keyed as `/lib.*.d.ts` — exactly what createVirtualCompilerHost expects.
    const map = createDefaultMapFromNodeModules(options, ts);

    const from = opts.packagesFrom ?? nodePath.dirname(fileURLToPath(import.meta.url));
    for (const name of [...CORE_PACKAGES, ...(opts.packages ?? [])]) {
        addPackage(map, name, locatePackage(name, from));
    }

    return createSystem(map);
}

/** Walk up from `fromDir` to find `node_modules/<name>` containing a package.json. */
function locatePackage(name: string, fromDir: string): string {
    let dir = fromDir;
    for (;;) {
        const candidate = nodePath.join(dir, "node_modules", name);
        if (fs.existsSync(nodePath.join(candidate, "package.json"))) return candidate;
        const parent = nodePath.dirname(dir);
        if (parent === dir) {
            throw new Error(`createKeymaNodeSystem: cannot locate ${name} under node_modules from ${fromDir}`);
        }
        dir = parent;
    }
}

/**
 * Add a package's `package.json` and TypeScript sources/declarations to the vfs map at
 * `/node_modules/<name>/<relative-path>`, mirroring the real on-disk layout (so the
 * package's `exports`/`types` resolve identically). `.js`/`.map` and nested `node_modules`
 * are skipped — only `.ts`/`.d.ts` (and `package.json`) are needed for type resolution.
 */
function addPackage(map: Map<string, string>, name: string, dir: string): void {
    const prefix = `/node_modules/${name}`;
    const walk = (cur: string): void => {
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
            if (entry.name === "node_modules") continue;
            const full = nodePath.join(cur, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            const keep = entry.name === "package.json" || (entry.name.endsWith(".ts") && !entry.name.endsWith(".map"));
            if (!keep) continue;
            const rel = nodePath.relative(dir, full).split(nodePath.sep).join("/");
            map.set(`${prefix}/${rel}`, fs.readFileSync(full, "utf8"));
        }
    };
    walk(dir);
}
