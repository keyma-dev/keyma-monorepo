# @keyma/compiler-frontend-ts

TypeScript compiler frontend for Keyma. Ingests `.ts` schema files decorated with `@keyma/dsl` decorators and produces language-neutral `KeymaIR` documents.

## Purpose

This package bridges the TypeScript authoring surface (`@keyma/dsl`) and the IR (`@keyma/ir`). It:

- Uses the TypeScript compiler API (`ts.createProgram`) to parse and type-check user schema files
- Discovers `@Schema`-decorated classes
- Extracts fields, validators, formatters, and indexes from the AST (without executing decorators)
- Lowers computed `get` accessor bodies to `IRExpression`
- Flattens inheritance chains into self-contained `IRSchema` entries
- Emits `KEYMA####` diagnostics for every structural problem

## Public API

```typescript
import { compile, compileVirtual } from "@keyma/compiler-frontend-ts";
```

### `compile(config): CompileResult`

Compile TypeScript files on disk.

```typescript
const { ir, diagnostics } = compile({
    files: ["src/schemas/user.ts", "src/schemas/order.ts"],
    dslModuleName: "@keyma/dsl",           // default
    compilerVersion: "0.1.0",
});

for (const diag of diagnostics) {
    console.error(`${diag.source?.file}:${diag.source?.line} [${diag.code}] ${diag.message}`);
}
```

### `compileVirtual(sources, config): CompileResult`

Compile TypeScript sources from in-memory strings. Module resolution falls back to the real file system, so `@keyma/dsl` is resolved normally.

```typescript
const { ir } = compileVirtual({
    "schema.ts": `
        import { Schema, Validate, isRequired } from "@keyma/dsl";
        import type { ID } from "@keyma/dsl";

        @Schema({ name: "product" })
        class Product {
            @Validate(isRequired)
            declare id: ID;
            declare title: string;
        }
    `,
});
```

## Example output

```json
{
  "irVersion": "1.0.0",
  "compilerVersion": "0.1.0",
  "schemas": [
    {
      "id": "schema:product",
      "name": "product",
      "sourceName": "Product",
      "visibility": "public",
      "fields": [
        {
          "name": "id",
          "type": { "kind": "id" },
          "visibility": "public",
          "readonly": false,
          "required": true,
          "validators": [{ "kind": "required" }],
          "formatters": [],
          "indexes": [],
          "source": { "file": "schema.ts", "line": 7, "column": 12 }
        }
      ],
      "indexes": [],
      "source": { "file": "schema.ts", "line": 4, "column": 14 }
    }
  ],
  "diagnostics": []
}
```

## Diagnostic codes

See [diagnostics.md](./diagnostics.md) for the full list of `KEYMA####` codes this package can emit.
