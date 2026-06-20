# @keyma/compiler-backend-js

JavaScript code-generation backend for Keyma. It consumes a `KeymaIR` document and emits dependency-free ES modules — a **client** bundle and a **server** bundle — whose only runtime import is `@keyma/runtime-js`.

It is a `KeymaBackend` plugin for the `@keyma/compiler` driver. Like the driver, it does **no file I/O**: `emit` returns `EmitFile[]` and the caller (the CLI, a test, your own tooling) decides where to write them.

## Where it fits

```
@keyma/compiler-frontend-ts ──► KeymaIR ──► @keyma/compiler (drive)
                                                   │
                                                   ▼
                                          @keyma/compiler-backend-js.emit()
                                                   │
                                                   ▼
                                  client/ + server/ ES modules ──► @keyma/runtime-js
```

## Public API

```ts
import { jsBackend, emitJs } from "@keyma/compiler-backend-js";
```

| Export | Description |
|---|---|
| `jsBackend` | The backend object — `{ name: "@keyma/compiler-backend-js", target: "js", emit }`. Register it with `drive()`. |
| `emitJs(ir, target, config)` | The emit function. Returns `Promise<EmitResult>` (`{ files: EmitFile[]; diagnostics }`). |
| `JsTargetConfig` | The target-config type the JS backend accepts. |
| `irTypeToTs` | Lowers an `IRType` to a TypeScript type string (exposed for tooling). |
| `exprToJs` | Lowers an `IRExpression` to JavaScript source (exposed for tooling). |

### Through the driver

```ts
import { drive, resolveConfig } from "@keyma/compiler";
import { jsBackend } from "@keyma/compiler-backend-js";
import { createTsFrontend } from "@keyma/cli";

const result = await drive(
    resolveConfig({
        source: ["src/**/*.ts"],
        outDir: "dist",
        targets: [{ language: "js", outDir: "dist/js" }],
    }),
    createTsFrontend(process.cwd()),
    [jsBackend],
);

// result.emitted: EmitFile[] — { path, content } — write them wherever you like.
```

### Target configuration (`JsTargetConfig`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `language` | `"js"` | — | Selects this backend. |
| `outDir` | `string` | — | Output root for the target. |
| `client` | `boolean` | `true` | Emit the public-facing client bundle. |
| `server` | `boolean` | `true` | Emit the full server bundle. |
| `library` | `boolean` | `false` | Emit a single unified bundle in `outDir/` (full surface; ignores `client`/`server`). |

With the defaults, output is split into `outDir/client/` and `outDir/server/`. `library: true` emits one self-contained bundle.

## Output layout

```
<outDir>/
  client/
    models/<path>.js     models/<path>.d.ts     # one module per SOURCE file (every schema
                                                 # authored together stays together; filename
                                                 # is the source stem, not the schema name)
    index.js             index.d.ts             # barrel re-export of model classes
    validators.js                     (+ .d.ts) # direct-ref factory functions (no registry)
    formatters.js                     (+ .d.ts) # direct-ref factory functions (no registry)
    functions.js                      (+ .d.ts) # when the IR declares utility functions
  server/
    ... (same files)
```

Validators/formatters/expression-defaults are referenced **directly** from each schema's frozen
metadata (`validators: [minLength(2)]`, `formatters: [{ phase, fn: trim() }]`, an inline
`applyDefaults`) — there is no name-keyed registry to wire into `KeymaServer`.

### Client vs. server bundle

| | client | server |
|---|---|---|
| Schemas | public only | all (incl. `@Schema({ private: true })`) |
| Fields | public only | all (incl. `private`) |
| Materializers | — | `materialize<Schema>()` per computed schema |
| Index metadata | omitted | included |
| Formatters in metadata | form phases only (`change`/`blur`/`submit`) | all phases (incl. `save`) |

The split is the seam that keeps private fields and server-only schemas out of code shipped to the browser.

## Generated code

Plain ES classes — **no decorators, no `reflect-metadata`, no `tslib`**. Each model carries a frozen static `schema` (a `SchemaMetadata`); `@Computed` getters become real getters; methods and setters are re-emitted; private members appear only in the server bundle. The only external reference is a type-only import of `SchemaMetadata` from `@keyma/runtime-js` (in the `.d.ts`).

```js
// client/models/user.js
export class User {
    constructor(value) {
        if (value) {
            this.id = value.id;
            this.firstName = value.firstName;
            this.lastName = value.lastName;
        }
    }
    get fullName() {
        return `${this.firstName} ${this.lastName}`;
    }
}
User.schema = Object.freeze({ name: "user", sourceName: "User", fields: [ /* … */ ] });
```

The server bundle adds a materializer for the computed field, used to recompute it on every write:

```js
// server/models/user.js
export function materializeUser(value) {
    value.fullName = `${value.firstName} ${value.lastName}`;
    return value;
}
```

## Tests

The suite is snapshot-based; fixtures live in `test/snapshots/` and are copied into `dist/test/` before the tests run:

```
tsc && cp -r test/snapshots dist/test/ && node --test dist/test/*.test.js
```

Preserve the `cp` step if you edit the test script.

```bash
npm -w @keyma/compiler-backend-js test
```
