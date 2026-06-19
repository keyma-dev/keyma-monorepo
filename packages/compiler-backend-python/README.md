# @keyma/compiler-backend-python

Python code-generation backend for Keyma. It consumes a `KeymaIR` document and emits **standalone Python** — plain classes that carry their schema metadata, expose computed fields as properties, and ship materializer functions for server-side use.

It is a `KeymaBackend` plugin for the `@keyma/compiler` driver and does **no file I/O**: `emit` returns `EmitFile[]`. The `@keyma/cli` registers it by default alongside the JS backend, so adding a `python` entry to your `keyma.config` `targets` is all it takes to emit Python.

## Public API

```ts
import { pythonBackend, emitPython } from "@keyma/compiler-backend-python";
```

| Export | Description |
|---|---|
| `pythonBackend` | The backend object — `{ name: "@keyma/compiler-backend-python", target: "python", emit }`. |
| `emitPython(ir, target, config)` | The emit function. Returns `Promise<EmitResult>` (`{ files: EmitFile[]; diagnostics }`). |
| `PythonTargetConfig` | The target-config type. |

### Target configuration (`PythonTargetConfig`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `language` | `"python"` | — | Selects this backend. |
| `outDir` | `string` | — | Output root for the target. |
| `client` | `boolean` | `true` | Emit the public-facing client bundle. |
| `server` | `boolean` | `true` | Emit the full server bundle. |
| `library` | `boolean` | `false` | Emit a single unified bundle in `outDir/` (ignores `client`/`server`). |

```ts
// keyma.config.ts
export default {
    source: "src/**/*.ts",
    outDir: "generated",
    targets: [
        { language: "js", outDir: "generated/js" },
        { language: "python", outDir: "generated/py" },
    ],
};
```

## Output

A Python package: `models/<schema>.py` (one per schema), an `index.py` + `__init__.py` barrel, and — when the IR declares them — `validators.py`/`registry.py`, `formatters.py`/`formatter_registry.py`, and `functions.py`. Every directory gets an `__init__.py`. The client/server split mirrors the JS backend: client = public schemas and fields, form-phase formatters, no indexes or materializers; server = everything.

Generated models are **plain classes** (no dataclasses, no Pydantic) that use only the standard library (`typing`, `datetime`, `re`) — there is no Keyma Python runtime to install:

```python
class User:
    def __init__(self, value: Dict[str, Any] = None):
        if value:
            self.id: str = value.get("id")
            self.firstName: str = value.get("firstName")
            self.lastName: str = value.get("lastName")

    @property
    def fullName(self) -> str:
        return (str(self.firstName) + " " + str(self.lastName))

User.schema = { "name": "user", "sourceName": "User", "fields": [ ... ] }

def materializeUser(value: dict) -> dict:
    value["fullName"] = (str(value["firstName"]) + " " + str(value["lastName"]))
    return value
```

- `@Computed` getters become `@property`; methods and setters are re-emitted; `materialize<Schema>()` is emitted server-side for schemas with computed fields.
- Type mapping: `string → str`, `integer → int`, `number → float`, `boolean → bool`, `bigint → int`, `decimal → str`, `bytes → bytes`, `dateTime → datetime`, `date`/`time → str`, `json → Any`, `enum → Literal[...]`, `array → List[...]`, `reference`/`embedded → the referenced class`. Optionality and nullability both widen the hint to `Optional[...]`.

## Status

The backend emits model classes, schema metadata, computed properties, materializers, validators, and formatters, and lowers the portable expression subset (binary/unary/ternary ops, template strings, regex, intrinsics). Two things to keep in mind:

- **No Python runtime package yet.** Unlike the JS target there is no server/query/adapter layer for Python — the output is schema and model code you consume directly.
- **Unsupported intrinsics degrade gracefully, not loudly.** An expression outside the supported set lowers to a `__keyma_unsupported_intrinsic__("…")` call rather than failing the build, so review the output if you rely on exotic getter or method bodies.

## Tests

```bash
npm -w @keyma/compiler-backend-python test
```
