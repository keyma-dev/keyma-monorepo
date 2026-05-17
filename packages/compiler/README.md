# @keyma/compiler

Compiler driver and plugin interface for Keyma. Orchestrates the pipeline from source files to generated output via pluggable frontends and backends.

## Purpose

This package wires together the Keyma compiler pipeline:

1. A **frontend** reads source files and produces a `KeymaIR` document.
2. The driver validates the IR for structural correctness.
3. Each configured **backend** consumes the IR and emits output files.

Frontends and backends are plugins — this package defines their interfaces. The driver itself is a pure function that does no file I/O; callers (e.g. `@keyma/cli`) decide how to write the emitted files.

## Public API

```typescript
import { drive, loadConfig, resolveConfig } from "@keyma/compiler";
```

### `drive(config, frontend, backends): Promise<DriveResult>`

Run the full compiler pipeline programmatically.

```typescript
import { drive, resolveConfig } from "@keyma/compiler";
import { tsFrontend } from "@keyma/compiler-frontend-ts";

const result = await drive(
    resolveConfig({ source: ["src/**/*.ts"], outDir: "dist" }),
    tsFrontend,
    []   // backends (none yet)
);

if (result.hasErrors) {
    for (const d of result.diagnostics) {
        console.error(`[${d.code}] ${d.message}`);
    }
}
```

### `loadConfig(configPath): Promise<KeymaUserConfig>`

Load a config file from disk. Supported formats: `.json`, `.js`, `.mjs`.

```typescript
const userConfig = await loadConfig("keyma.config.json");
const config = resolveConfig(userConfig);
```

### `resolveConfig(userConfig): ResolvedConfig`

Apply defaults to a raw user config object.

## Plugin interfaces

### `KeymaFrontend`

```typescript
interface KeymaFrontend {
    name: string;
    sourceExtensions: string[];
    compile(config: ResolvedConfig): Promise<{ ir: KeymaIR; diagnostics: IRDiagnostic[] }>;
}
```

### `KeymaBackend`

```typescript
interface KeymaBackend {
    name: string;
    target: string;  // e.g. "js", "cpp"
    emit(ir: KeymaIR, target: KeymaTargetConfig, config: ResolvedConfig): Promise<EmitResult>;
}
```

## Config format (`keyma.config.json`)

```json
{
    "source": ["src/**/*.ts"],
    "outDir": "dist",
    "irOutFile": ".keyma/schema.ir.json",
    "targets": [
        { "language": "js", "client": true, "server": true, "outDir": "dist/js" }
    ]
}
```
