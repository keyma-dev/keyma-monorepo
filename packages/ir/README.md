# @keyma/ir

TypeScript types and JSON schema for the Keyma language-neutral intermediate representation (IR).

## Purpose

The IR is the central contract between the compiler frontend and compiler backends. It is:

- **Serializable** — pure JSON, no functions or class instances
- **Versioned** — `irVersion` is bumped on breaking changes
- **Portable** — no TypeScript- or JavaScript-specific constructs
- **Self-describing** — every node carries an optional source location

## Public API

```typescript
import { validateIR } from "@keyma/ir";
import type { KeymaIR, IRSchema, IRField, IRType } from "@keyma/ir";
```

### Types

| Type | Description |
|---|---|
| `KeymaIR` | Top-level IR document |
| `IRSchema` | A compiled schema (fully flattened, including inherited fields) |
| `IRField` | A single field within a schema |
| `IRType` | Discriminated union of all supported types |
| `IRValidator` | Discriminated union of all built-in validators |
| `IRFormatter` | A formatter entry: `{ phase, spec }` |
| `IRFormatterSpec` | Discriminated union of all formatter kinds |
| `IRExpression` | Discriminated union for computed getter expressions |
| `IRComputed` | Computed field descriptor |
| `IRFieldIndex` | Single-field index options |
| `IRIndex` | Composite index descriptor |
| `IRDiagnostic` | A compiler diagnostic with stable code and source location |
| `IRSourceLocation` | `{ file, line, column }` |

### `validateIR(doc: unknown): IRValidationResult`

Validates an unknown value against the IR structure. Returns `{ valid, errors }`.

```typescript
import { validateIR } from "@keyma/ir";

const result = validateIR(JSON.parse(fs.readFileSync("schema.ir.json", "utf8")));
if (!result.valid) {
    for (const error of result.errors) {
        console.error(`${error.path}: ${error.message}`);
    }
}
```

### `schema.json`

A JSON Schema 2020-12 document for validating IR files with standard tooling:

```typescript
import schema from "@keyma/ir/schema.json" assert { type: "json" };
```

## Example IR document

```json
{
  "irVersion": "1.0.0",
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
          "validators": [
            { "kind": "required" },
            { "kind": "emailAddress" }
          ],
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
