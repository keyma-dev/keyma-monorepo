# @keyma/compiler/frontend-ts

The domain-neutral TypeScript compiler frontend for Keyma. It ingests `.ts` source files and
produces language-neutral `KeymaIR` documents. The compiler **owns the driver**: it discovers
every data class, builds each class's domain-neutral base IR, dispatches the domain-owned
decorators to their handlers, runs base validation, name normalization, binary-tag assignment, the
function surface, enum collection, and the built-in `@Service` base pass. A **domain** (registered
by the CLI) is a declarative `FrontendDomain` descriptor that contributes only its slice: the
class/member decorators it owns plus per-class/program hooks that enrich `ir.extensions[domainId]`.

## Purpose

Using the TypeScript compiler API (`ts.createProgram`) it parses and type-checks the user source
files, then drives the pipeline directly. It:

- Discovers every non-`@Service` class and builds its domain-neutral base `IRClassDeclaration`
  (typed fields, behaviors, `extends`, core `@Tag`/`@RenamedFrom`/`@Deprecated`).
- Dispatches each registered domain's class/member decorators to the domain's `handle` callbacks,
  then calls its `finalizeClass`/`check`/`afterNormalize`/`documentExtension` hooks.
- Runs base validation (inheritance, duplicate names, visibility leaks, public surface), name
  normalization, binary-tag assignment, the local-function surface, and enum collection.
- Lowers method/setter/getter bodies and project-local utility functions to portable
  `IRExpression`/`IRStatement` nodes through one shared engine.
- Maps TypeScript types to core IR types (primitives, enums, `Reference<T>`/`Embedded<T>`,
  width-templated numerics, …).
- Discovers and lowers `@Service` contracts as a built-in base pass after the class surface is
  final.
- Emits stable `KEYMA####` diagnostics for every structural problem it owns.

## Public API

```ts
import { compile, compileVirtual } from "@keyma/compiler/frontend-ts";
```

> There is no frontend *plugin object* here — `@keyma/cli`'s `createTsFrontend(cwd)` adapts
> `compile()` to the `KeymaFrontend` shape the driver expects and registers the domains. All
> compiler-owned `KEYMA####` code constants and the `mkError`/`mkWarning` helpers are re-exported
> for diagnostic handling, alongside the generic lowering machinery domains build on.

### `compile(config): CompileResult`

Compile TypeScript files on disk. Returns `{ ir, diagnostics }`. Pass the domains to run via
`config.domains`; with none registered the IR carries only the (empty) document envelope.

```ts
const { ir, diagnostics } = compile({
    files: ["src/models/user.ts", "src/models/order.ts"],
    domains: [/* domain frontends registered by the CLI */],
    compilerVersion: "0.1.0",
});

for (const diag of diagnostics) {
    console.error(`${diag.source?.file}:${diag.source?.line} [${diag.code}] ${diag.message}`);
}
```

### `compileVirtual(sources, config): CompileResult`

Compile TypeScript sources from in-memory strings. The second argument is
`Omit<FrontendConfig, "files"> & { baseDir?: string }` — `files` are derived from the `sources`
keys. Module resolution falls back to the real file system (or to an injected in-memory
`config.system` for the fully-virtual, browser-capable path).

## Example output

```json
{
  "irVersion": "9.0.0",
  "compilerVersion": "0.1.0",
  "classes": [
    {
      "id": "class:product",
      "name": "product",
      "sourceName": "Product",
      "visibility": "public",
      "fields": [
        {
          "name": "title",
          "type": { "kind": "string" },
          "visibility": "public",
          "readonly": false,
          "required": true,
          "source": { "file": "product.ts", "line": 8, "column": 12 }
        }
      ],
      "source": { "file": "product.ts", "line": 5, "column": 14 }
    }
  ],
  "diagnostics": []
}
```

(A domain attaches its own per-class/per-field metadata under the IR's `extensions` channel —
the core class/field shape above stays domain-neutral.)

## Diagnostic codes

See [diagnostics.md](./diagnostics.md) for the full list of stable `KEYMA####` codes this package
emits. Codes are **never renumbered** — new ones are added, old ones never shift. A domain's own
diagnostic codes live in that domain's `frontend-ts/diagnostics.ts`.
