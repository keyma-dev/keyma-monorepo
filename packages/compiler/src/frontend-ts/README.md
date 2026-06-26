# @keyma/compiler-frontend-ts

TypeScript compiler frontend for Keyma. Ingests `.ts` schema files decorated with `@keyma/dsl` decorators and produces language-neutral `KeymaIR` documents.

## Purpose

This package bridges the TypeScript authoring surface (`@keyma/dsl`) and the IR (`@keyma/ir`). Using the TypeScript compiler API (`ts.createProgram`) it parses and type-checks the schema files, then runs a sequence of passes — `discoverSchemas` → `extractSchema` (own fields) → `checkInheritance` (validates `extends`; inheritance stays real), plus validator/formatter/utility-function discovery — followed by duplicate-name and visibility-leak post-checks. It:

- Discovers `@Schema`- and `@Edge`-decorated classes.
- Extracts fields, validators, formatters, indexes, methods, and form metadata from the AST — **without executing decorators**.
- Lowers `@Computed` getter and method/setter bodies to portable `IRExpression`/`IRStatement` nodes.
- Flattens inheritance chains into self-contained `IRSchema` entries.
- Emits stable `KEYMA####` diagnostics for every structural problem.

## Public API

```ts
import { compile, compileVirtual } from "@keyma/compiler-frontend-ts";
```

> There is no frontend *plugin object* here — `@keyma/cli`'s `createTsFrontend(cwd)` adapts `compile()` to the `KeymaFrontend` shape the driver expects. All `KEYMA####` code constants and the `mkError`/`mkWarning` helpers are also re-exported for diagnostic handling.

### `compile(config): CompileResult`

Compile TypeScript files on disk. Returns `{ ir, diagnostics }`.

```ts
const { ir, diagnostics } = compile({
    files: ["src/schemas/user.ts", "src/schemas/order.ts"],
    dslModuleName: "@keyma/dsl",   // default
    compilerVersion: "0.1.0",
});

for (const diag of diagnostics) {
    console.error(`${diag.source?.file}:${diag.source?.line} [${diag.code}] ${diag.message}`);
}
```

### `compileVirtual(sources, config): CompileResult`

Compile TypeScript sources from in-memory strings. The second argument is `Omit<FrontendConfig, "files"> & { baseDir?: string }` — `files` are derived from the `sources` keys. Module resolution still falls back to the real file system, so `@keyma/dsl` (and `@keyma/validators` etc.) resolve normally.

```ts
const { ir } = compileVirtual({
    "schema.ts": `
        import { Schema, Validate } from "@keyma/dsl";
        import type { ID } from "@keyma/dsl";
        import { minLength } from "@keyma/validators";

        @Schema({ name: "product" })
        class Product {
            declare id: ID;
            @Validate(minLength(1))
            declare title: string;
        }
    `,
});
```

## Example output

```json
{
  "irVersion": "2.0.0",
  "compilerVersion": "0.1.0",
  "schemas": [
    {
      "id": "schema:product",
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
          "validators": [{ "kind": "minLength", "value": 1 }],
          "formatters": [],
          "indexes": [],
          "source": { "file": "schema.ts", "line": 8, "column": 12 }
        }
      ],
      "indexes": [],
      "source": { "file": "schema.ts", "line": 5, "column": 14 }
    }
  ],
  "diagnostics": []
}
```

## Diagnostic codes

See [diagnostics.md](./diagnostics.md) for the full list of stable `KEYMA####` codes this package can emit. Codes are **never renumbered** — new ones are added, old ones never shift.
