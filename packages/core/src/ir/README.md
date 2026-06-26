# @keyma/ir

TypeScript types and JSON Schema for the Keyma language-neutral **intermediate representation** (IR), plus the intrinsic-method registry that defines which calls are portable across targets.

## Purpose

The IR is the central contract between the compiler frontend and the compiler backends. It is:

- **Serializable** — pure JSON, no functions or class instances.
- **Versioned** — `irVersion` is bumped on breaking changes (current: `2.0.0`).
- **Portable** — no TypeScript- or JavaScript-specific constructs.
- **Self-describing** — every node carries an optional `IRSourceLocation`.

Any change to these types affects every frontend and backend, so keep IR nodes JSON-serializable and bump `irVersion` on breaking changes.

## Public API

```ts
import {
    validateIR,
    INTRINSICS, intrinsicByOp, intrinsicByMember,
} from "@keyma/ir";
import type { KeymaIR, IRSchema, IRField, IRType } from "@keyma/ir";
```

### Core types

| Type | Description |
|---|---|
| `KeymaIR` | Top-level IR document (`irVersion`, `compilerVersion`, `schemas`, `diagnostics`, …). |
| `IRClassDeclaration` | A compiled class/schema. Holds OWN fields/methods; `extends` drives real inheritance in the output. |
| `IREdge` | Edge metadata on an edge schema (`from`/`to`/`label`/`directed`). |
| `IRField` | A single field within a schema. |
| `IRType` | Discriminated union of all supported field types. |
| `IRComputed` | Computed-field descriptor. |
| `IRExpression` | Discriminated union for getter / method / body expressions. |
| `IRStatement` (+ `IRReturnStmt`, `IRIfStmt`, `IRConstDecl`, `IRExprStmt`, `IRAssignStmt`) | Portable statement nodes for function / method / behavior bodies. |
| `IRMethod` | Method / behavior descriptors. |
| `IRFieldIndex` / `IRIndex` | Single-field and composite index descriptors. |
| `IRFormField` / `IRDefault` | Form metadata and default-value descriptors. |
| `IRFunctionParam`, `IRFunctionDeclaration`, `IREnumDeclaration` | Project-declared functions (utilities + validator/formatter factories) and enums. The `IRValidator`/`IRFormatter` field-attachment types live in `@keyma/schema/ir`. |
| `IRDiagnostic` / `IRSourceLocation` | A compiler diagnostic with a stable code, and `{ file, line, column }`. |

### `validateIR(doc: unknown): IRValidationResult`

Validates an unknown value against the IR structure. Returns `{ valid: boolean, errors: IRValidationError[] }`.

```ts
import { validateIR } from "@keyma/ir";

const result = validateIR(JSON.parse(fs.readFileSync("schema.ir.json", "utf8")));
if (!result.valid) {
    for (const error of result.errors) {
        console.error(`${error.path}: ${error.message}`);
    }
}
```

### The intrinsic registry

- `INTRINSICS`, `intrinsicByOp`, and `intrinsicByMember` describe the **portable method/property calls** (e.g. `.trim()`, `.includes()`, `.length`) that may appear in getter/method/validator bodies. The human-readable catalog is `intrinsics.md` in this package; frontends use it to reject non-portable calls and backends use it to re-emit the supported ones.

### `schema.json`

A JSON Schema 2020-12 document for validating IR files with standard tooling:

```ts
import schema from "@keyma/ir/schema.json" assert { type: "json" };
```

## Example IR document

```json
{
  "irVersion": "2.0.0",
  "compilerVersion": "0.1.0",
  "schemas": [
    {
      "id": "schema:user",
      "name": "user",
      "sourceName": "User",
      "visibility": "public",
      "fields": [
        {
          "name": "id",
          "type": { "kind": "id" },
          "visibility": "public",
          "readonly": true,
          "required": true,
          "validators": [],
          "formatters": [],
          "indexes": [],
          "source": { "file": "src/schemas/user.ts", "line": 5, "column": 4 }
        },
        {
          "name": "email",
          "type": { "kind": "string" },
          "visibility": "public",
          "readonly": false,
          "required": true,
          "validators": [{ "kind": "emailAddress" }],
          "formatters": [
            { "phase": "save", "spec": { "kind": "normalizeEmail" } }
          ],
          "indexes": [{ "unique": true }],
          "source": { "file": "src/schemas/user.ts", "line": 9, "column": 4 }
        }
      ],
      "indexes": [],
      "source": { "file": "src/schemas/user.ts", "line": 3, "column": 0 }
    }
  ],
  "diagnostics": []
}
```
