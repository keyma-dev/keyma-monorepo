# keyma-runtime

Python target runtime for Keyma (import package `keyma.runtime`). Paired with the code emitted by `@keyma/compiler-backend-python`, it provides everything generated Python needs at runtime: validation and formatting against the generated schema metadata, record (de)serialization, the `Keyma` query builder, the `KeymaServer`, the `KeymaDatabaseAdapter` interface, the server-plugin protocol, an in-process transport, and a structured error model.

It is the Python sibling of [`@keyma/runtime-js`](../runtime-js). Beyond the standard library, this package has **zero dependencies**.

## Install

```bash
pip install keyma-runtime
```

```python
from keyma.runtime import KeymaServer, create_direct_transport, Keyma, validate
from keyma.runtime.testing import InMemoryAdapter
```

`keyma.runtime` is a [PEP 420 namespace package](https://peps.python.org/pep-0420/) under the `keyma` root, so future packages (e.g. `keyma.adapter_mongodb`) can share it.

## Where it fits

```
@keyma/dsl  →  @keyma/ir  →  @keyma/compiler-frontend-ts  →  @keyma/compiler
                                                                  ↓
                                    @keyma/compiler-backend-python  →  generated Python  →  keyma.runtime + adapter
```

Generated code embeds static `SchemaMetadata` (a plain dict attached as `Class.schema`) and consumes this runtime. Database adapters implement `KeymaDatabaseAdapter` and plug into `KeymaServer`.

## Async by design

The runtime mirrors runtime-js's Promise-based API with `asyncio`: `validate`, `format`, `KeymaServer.handle`, the transport, and every adapter method are `async`. Validators and formatters may be **sync or async** — the runtime awaits awaitable results and adapts each call to the callable's real arity (so the variable-arity closures the Python backend emits, e.g. `def _v(raw, field)`, are called correctly).

The pure data transforms — `apply_defaults`, `serialize`, `deserialize`, `apply_materializers` — are synchronous.

## Minimal server

```python
from keyma.runtime import KeymaServer, create_direct_transport
from keyma.runtime.testing import InMemoryAdapter
from myapp.generated.server import User, Organization  # generated models

server = KeymaServer(schemas=[User.schema, Organization.schema], adapter=InMemoryAdapter())
await server.ensure_schemas()
transport = create_direct_transport(server)
```

`KeymaServer`'s public surface is small: `ensure_schemas()` (persist every non-ephemeral schema through the adapter), `handle(request, context=None)` (process a request batch), and `close()` (delegates to `adapter.close()` if present). `create_direct_transport` accepts an optional `context_factory` (sync or async) invoked per request to supply a `RequestContext` with `identity` to plugins.

## The `Keyma` query builder

`Keyma` exposes `query` and `mutation` (document builders), the leaf builders `list` / `read` / `create` / `update` / `delete` / `traverse` / `count` / `call`, and `input` (a request-time placeholder):

```python
q = Keyma.query({
    "users": Keyma.list(User, None, {"organization": {"name": 1}}),
    "user": Keyma.read(User, {"id": Keyma.input("id")}, {"organization": {"name": 1}}),
})
resp = await q.request(
    {"users": {"skip": 0, "limit": 10}},
    inputs={"user": {"id": "u1"}},
    transport=transport,
)
```

Results are hydrated into model instances (via `deserialize`). The same document can mix CRUD leaves and graph traversals in one batch.

In `where` filters and create/update `data`, a reference field accepts any of three forms — a bare id, an `{"id": ...}` dict, or a model instance — all collapsed to the stored bare id before the request is sent (matching `@keyma/runtime-js`):

```python
# equivalent — each collapses to the bare id on the wire
Keyma.list(User, {"organization": "o1"})
Keyma.list(User, {"organization": {"id": "o1"}})
Keyma.create(User, {"name": "Al", "organization": Organization({"id": "o1"})})
```

## Writing a database adapter

A `KeymaDatabaseAdapter` implements seven required `async` methods — `ensure_schema`, `create`, `read`, `list`, `update`, `delete`, `count` — and may add the optional `traverse`, `connect`, `close`, and a `capabilities` descriptor. The server duck-types the optional members.

### Filter shape

Every `where` object the runtime hands an adapter follows one canonical shape:

- Top-level keys are field names of the operation's schema (`id` is a reserved alias the adapter may map to its native primary key).
- Field values are literals (equality) or operator objects using `$eq` / `$ne` / `$gt` / `$gte` / `$lt` / `$lte` / `$in` / `$nin`.
- Top-level keys `$and` / `$or` / `$nor` carry a list of sub-filters of the same shape (server plugins inject these; adapters must handle them).

## Writing a server plugin

A plugin is any object with a `name` and any subset of the snake_case hooks `init`, `transform_operation`, `before_operation`, `transform_filter`, `transform_projection`, `check_write`, `transform_result`, `after_operation`. They fire in order at well-defined points; `transform_operation` runs first and can rewrite the whole operation. Hooks may be sync or async.

## Errors

Raising any subclass of `KeymaError` from a plugin or adapter produces a structured failure on the wire:

- `KeymaRuntimeError` — `source: "runtime"`; raised by the server (validation, missing schema, NOT_FOUND, …).
- `KeymaPluginError` — `source: "plugin"`; `origin` is the plugin package name. Use `extras` for structured detail.
- `KeymaAdapterError` — `source: "adapter"`; same shape, with the adapter package as `origin`.

Predicate helpers `is_runtime_failure` / `is_plugin_failure` / `is_adapter_failure` narrow a failure by source.

## `keyma.runtime.testing`

The `keyma.runtime.testing` module exports an `InMemoryAdapter` (a fully in-memory `KeymaDatabaseAdapter`) plus the `matches` / `matches_op` filter evaluators — handy for unit-testing schemas and plugins without a real database.

## Development

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
pytest          # run the test suite
python -m build # build sdist + wheel
```

## Status

Pre-alpha. The public surface of this package is the contract between generated Python code and consumer applications.
