# @keyma/compiler

Compiler **driver** and **plugin interfaces** for Keyma. Orchestrates the pipeline from source files to generated output via pluggable frontends and backends.

## Purpose

This package wires the Keyma compiler pipeline together:

1. A **frontend** reads source files and produces a `KeymaIR` document.
2. The driver validates the IR for structural correctness (`validateIR`).
3. Each configured **backend** consumes the IR and emits output files.

Frontends and backends are plugins — this package defines their interfaces. The **driver is a pure function that does no file I/O**: it returns the emitted files and the caller (`@keyma/cli`, a test, your own tooling) decides how to write them.

## Public API

```ts
import { drive, loadConfig, resolveConfig } from "@keyma/compiler";
```

### `drive(config, frontend, backends): Promise<DriveResult>`

Runs the full pipeline. The `frontend` is any `KeymaFrontend`; `@keyma/cli` exposes `createTsFrontend(cwd)`, which adapts `@keyma/compiler-frontend-ts` to that shape.

```ts
import { drive, resolveConfig } from "@keyma/compiler";
import { createTsFrontend } from "@keyma/cli";
import { jsBackend } from "@keyma/compiler-backend-js";

const result = await drive(
    resolveConfig({
        source: ["src/**/*.ts"],
        outDir: "dist",
        targets: [{ language: "js", outDir: "dist/js" }],
    }),
    createTsFrontend(process.cwd()),
    [jsBackend],
);

if (result.hasErrors) {
    for (const d of result.diagnostics) console.error(`[${d.code}] ${d.message}`);
} else {
    for (const f of result.emitted) writeFileSync(f.path, f.content); // your I/O
}
```

`DriveResult` is `{ ir: KeymaIR; emitted: EmitFile[]; diagnostics: IRDiagnostic[]; hasErrors: boolean }`.

### `loadConfig(configPath): Promise<KeymaUserConfig>`

Loads a config file from disk. Supported formats: `.json`, `.js`, `.mjs`, `.cjs`.

```ts
const userConfig = await loadConfig("keyma.config.json");
const config = resolveConfig(userConfig);
```

### `resolveConfig(userConfig): ResolvedConfig`

Applies defaults to a raw user config object.

## Plugin interfaces

### `KeymaFrontend`

```ts
interface KeymaFrontend {
    name: string;
    sourceExtensions: string[];
    compile(config: ResolvedConfig): Promise<{ ir: KeymaIR; diagnostics: IRDiagnostic[] }>;
}
```

### `KeymaBackend`

```ts
interface KeymaBackend {
    name: string;
    target: string;  // e.g. "js", "python"
    emit(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult>;
}
```

`EmitResult` is `{ files: EmitFile[]; diagnostics }`; `EmitFile` is `{ path: string; content: string }`.

## Config format (`keyma.config.json`)

```json
{
    "source": ["src/**/*.ts"],
    "outDir": "dist",
    "baseDir": ".",
    "irOutFile": ".keyma/schema.ir.json",
    "targets": [
        { "language": "js", "client": true, "server": true, "outDir": "dist/js" },
        { "language": "python", "outDir": "dist/py" }
    ]
}
```

`targets` is an array, so a single build can emit several languages. Each target is interpreted by the backend registered for its `language`.
