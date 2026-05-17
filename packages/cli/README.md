# @keyma/cli

Command-line interface for [Keyma](../../README.md) — scaffolds new projects and drives the compiler pipeline.

## Install

```bash
npm install --save-dev @keyma/cli
```

The CLI exposes a single `keyma` binary.

## Quick start

```bash
keyma new my-app
cd my-app
npm install
keyma gen user
keyma build
```

That produces a project laid out as:

```
my-app/
├── package.json
├── tsconfig.json
├── keyma.config.ts
└── src/
    ├── index.ts
    └── schemas/
        └── user.ts
```

…and writes generated client + server bundles under the `outDir` configured in `keyma.config.ts`.

## Commands

### `keyma new <name>`

Scaffolds a new project in `./<name>`. Refuses to write into a non-empty directory unless `--force` is passed.

The generated `package.json` depends on `@keyma/dsl` and `@keyma/runtime-js` and wires up `build`, `watch`, and `inspect` scripts that call this CLI.

### `keyma gen <schema>`

Generates a schema file at `src/schemas/<schema>.ts`. The argument is normalised: `user-profile` and `UserProfile` both produce class `UserProfile` in `user-profile.ts`.

Refuses to overwrite an existing file without `--force`.

### `keyma build`

Loads `keyma.config.{ts,js,mjs,cjs,json}` from the current directory, runs the TypeScript frontend, validates the IR, dispatches to each configured backend, and writes the emitted files to disk. If `irOutFile` is set in the config, the IR JSON is written there too.

Diagnostics are printed to stderr with their stable `KEYMA####` code. Exit status is non-zero when any error diagnostic is emitted.

Options:

- `--config <path>` — load a config from an explicit path instead of auto-discovering one in the cwd.

### `keyma watch`

Like `build`, but additionally watches the source pattern roots and rebuilds on change with a 100 ms debounce. Stop with `Ctrl-C`.

Options:

- `--config <path>` — same as `build`.

### `keyma inspect`

Runs the frontend only (no backends) and writes the resulting IR to stdout as JSON. Useful for debugging schema discovery or piping into other tools.

Options:

- `--out <path>` — write the IR to a file instead of stdout.
- `--config <path>` — same as `build`.

## Configuration

The CLI looks for one of (in order): `keyma.config.ts`, `keyma.config.mjs`, `keyma.config.cjs`, `keyma.config.js`, `keyma.config.json`.

TypeScript configs are transpiled in memory; only `import type` declarations work inside them — runtime imports are not resolved.

```ts
// keyma.config.ts
import type { KeymaUserConfig } from "@keyma/compiler";

const config: KeymaUserConfig = {
    source: "src/schemas/**/*.ts",
    outDir: "generated",
    targets: [
        { language: "js", outDir: "generated/js" },
    ],
};

export default config;
```

Config fields:

| Field | Type | Description |
| --- | --- | --- |
| `source` | `string \| string[]` | Glob(s) for schema files. |
| `outDir` | `string` | Root output directory. Defaults to `dist`. |
| `irOutFile` | `string` | Optional path to write the IR JSON. |
| `targets` | `KeymaTargetConfig[]` | One entry per code-generation target. |
| `customValidators` | `string[]` | Names of custom validators registered for this project. |
| `customFormatters` | `string[]` | Names of custom formatters registered for this project. |

Target configs are language-specific. The bundled JavaScript target accepts:

| Field | Type | Description |
| --- | --- | --- |
| `language` | `"js"` | Selects the JS backend. |
| `outDir` | `string` | Output directory for this target. |
| `client` | `boolean` | Emit the client bundle. Defaults to `true`. |
| `server` | `boolean` | Emit the server bundle. Defaults to `true`. |

## Programmatic API

Every command is also exposed as a function, so you can drive the compiler from your own scripts or tooling:

```ts
import { runBuild, runInspect, runNew, runGen, runWatch } from "@keyma/cli";

const result = await runBuild({ cwd: "/path/to/project" });
if (result.hasErrors) {
    for (const d of result.diagnostics) console.error(d);
    process.exit(1);
}
```

Also exported: `loadProjectConfig`, `findConfig`, `createTsFrontend`, `formatDiagnostic`, `printDiagnostics`, `projectFiles`, `schemaTemplate`.

## How it fits together

```
keyma.config        @keyma/compiler-frontend-ts          @keyma/compiler-backend-js
     │                       │                                     │
     ▼                       ▼                                     ▼
 loadProjectConfig ──► createTsFrontend ──► drive() ──► jsBackend.emit() ──► files on disk
                                              │
                                              └─► validateIR (@keyma/ir)
```

The CLI is a thin orchestrator: configuration loading, source globbing, file I/O, and process management. All compilation work happens inside `@keyma/compiler-frontend-ts`, `@keyma/compiler`, and `@keyma/compiler-backend-js`.
