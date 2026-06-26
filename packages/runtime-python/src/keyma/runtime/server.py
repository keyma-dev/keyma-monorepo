"""KeymaServer — port of ``@keyma/runtime-js`` ``server.ts``.

Dispatches a batch of operations against a database adapter, threading every
operation through the plugin hook chain (transform_operation → before_operation →
operation-specific filter/projection/write/result hooks → after_operation) and
converting raised :class:`KeymaError` subclasses into structured wire failures.

Constructed as ``KeymaServer(schemas=[...], adapter=adapter, plugins=[...], services=[...])``.
Plugin hooks and adapter methods may be sync or async; awaitable results are awaited.
"""

from __future__ import annotations

import inspect
from typing import Any, Dict, List, Optional, Sequence

from .defaults import apply_defaults
from .errors import KeymaError, KeymaRuntimeError
from .fields import all_fields
from .format import format as _format
from .reference import normalize_reference_ids
from .types import FieldType, RequestContext, SchemaMetadata
from .validate import validate


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _is_system(context: RequestContext) -> bool:
    identity = context.get("identity") or {}
    return identity.get("isSystem") is True


# ── Module helpers (ported from server.ts free functions) ────────────────────


def _find_field(schema: SchemaMetadata, name: str) -> Optional[Dict[str, Any]]:
    for f in all_fields(schema):  # own + inherited (real inheritance)
        if f["name"] == name:
            return f
    return None


def _core_type(type_: FieldType) -> FieldType:
    if type_["kind"] == "array":
        return _core_type(type_["of"])
    return type_


def _collect_edge_names(spec: Dict[str, Any]) -> "set[str]":
    names: "set[str]" = set()
    if spec.get("steps") is not None:
        for s in spec["steps"]:
            names.add(s["via"])
    if spec.get("repeat") is not None:
        names.add(spec["repeat"]["via"])
    return names


def _is_plain_record(v: Any) -> bool:
    return isinstance(v, dict) and not ("nodes" in v and "edges" in v)


def _with_id_field(projection: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(projection)
    result["fields"] = {**(projection.get("fields") or {}), "id": 1}
    return result


def _build_embedded_spec(spec: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, sub in spec.items():
        result[key] = 1 if sub == 1 else _build_embedded_spec(sub)
    return result


class _ValidationFailedError(KeymaRuntimeError):
    def __init__(self, errors: List[Dict[str, Any]]) -> None:
        super().__init__("VALIDATION_FAILED", "Validation failed")
        self.errors = errors

    def to_failure_extras(self) -> Dict[str, Any]:
        return {"errors": self.errors}


def _error_to_result(err: BaseException) -> Dict[str, Any]:
    if isinstance(err, KeymaError):
        out: Dict[str, Any] = {
            "ok": False,
            "error": getattr(err, "message", str(err)),
            "code": err.code,
            "source": err.source,
        }
        if getattr(err, "origin", ""):
            out["origin"] = err.origin
        out.update(err.to_failure_extras())
        return out
    return {"ok": False, "error": str(err), "code": "INTERNAL_ERROR", "source": "runtime"}


class _PluginServerHandle:
    """Subset of the server exposed to plugins during ``init``."""

    def __init__(self, server: "KeymaServer") -> None:
        self._server = server

    @property
    def schemas(self) -> Sequence[SchemaMetadata]:
        return self._server._schemas

    @property
    def adapter(self) -> Any:
        return self._server._adapter

    def schema(self, name: str) -> Optional[SchemaMetadata]:
        return self._server._schema_map.get(name)

    async def add_schema(self, schema: SchemaMetadata) -> None:
        self._server._schema_map[schema["name"]] = schema
        if schema.get("ephemeral"):
            return
        await self._server._adapter.ensure_schema(schema)


class KeymaServer:
    def __init__(
        self,
        schemas: Sequence[SchemaMetadata],
        adapter: Any,
        plugins: Optional[Sequence[Any]] = None,
        services: Optional[Sequence[Any]] = None,
    ) -> None:
        self._schemas: List[SchemaMetadata] = list(schemas)
        self._adapter = adapter
        self._plugins: List[Any] = list(plugins or [])
        self._services: List[Any] = list(services or [])
        self._schema_map: Dict[str, SchemaMetadata] = {s["name"]: s for s in self._schemas}
        self._service_map: Dict[str, Dict[str, Any]] = {}
        self._initialized = False

    async def ensure_schemas(self) -> None:
        await self._ensure_initialized()
        for schema in self._schemas:
            # Ephemeral schemas are never persisted — no collection/table to ensure.
            if schema.get("ephemeral"):
                continue
            await self._adapter.ensure_schema(schema)

    async def handle(self, request: Dict[str, Any], context: Optional[RequestContext] = None) -> Dict[str, Any]:
        if context is None:
            context = {}
        await self._ensure_initialized()
        results: Dict[str, Any] = {}
        for key, op in request["operations"].items():
            results[key] = await self._handle_one(op, context)
        return {"results": results}

    async def close(self) -> None:
        close = getattr(self._adapter, "close", None)
        if close is not None:
            await _maybe_await(close())

    # ── Initialization & resolution ──────────────────────────────────────────

    def _resolve_schema(self, name: str, context: RequestContext) -> SchemaMetadata:
        schema = self._schema_map.get(name)
        if schema is None or (schema.get("visibility") == "private" and not _is_system(context)):
            raise KeymaRuntimeError("SCHEMA_NOT_FOUND", f"Unknown schema: {name}")
        return schema

    def _register_services(self) -> None:
        for provider in self._services:
            instance = provider() if callable(provider) else provider
            metadata = getattr(type(instance), "service", None)
            if metadata is None:
                raise KeymaRuntimeError(
                    "INVALID_SERVICE",
                    f"Service {type(instance).__name__} is missing static service metadata "
                    "— does it extend the generated service class?",
                )
            if metadata["name"] in self._service_map:
                raise KeymaRuntimeError("DUPLICATE_SERVICE", f'Service "{metadata["name"]}" is registered more than once')
            self._service_map[metadata["name"]] = {"instance": instance, "metadata": metadata}

    async def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        self._register_services()
        connect = getattr(self._adapter, "connect", None)
        if connect is not None:
            await _maybe_await(connect())
        handle = _PluginServerHandle(self)
        for p in self._plugins:
            init = getattr(p, "init", None)
            if init is not None:
                await _maybe_await(init(handle))

    # ── Dispatch ─────────────────────────────────────────────────────────────

    async def _handle_one(self, op: Dict[str, Any], context: RequestContext) -> Dict[str, Any]:
        result: Dict[str, Any]
        try:
            for p in self._plugins:
                hook = getattr(p, "transform_operation", None)
                if hook is not None:
                    nxt = await _maybe_await(hook(context, op))
                    if nxt is not None:
                        op = nxt
            # A `call` op targets a service, not a schema — it branches out before
            # schema resolution. Op-level hooks still run; schema-scoped hooks do not.
            if op["op"] == "call":
                for p in self._plugins:
                    hook = getattr(p, "before_operation", None)
                    if hook is not None:
                        await _maybe_await(hook(context, op))
                result = await self._handle_call(op, context)
            else:
                schema = self._resolve_schema(op["schema"], context)
                if schema.get("ephemeral"):
                    raise KeymaRuntimeError(
                        "NOT_PERSISTED", f'Schema "{op["schema"]}" is ephemeral and cannot be queried'
                    )
                for p in self._plugins:
                    hook = getattr(p, "before_operation", None)
                    if hook is not None:
                        await _maybe_await(hook(context, op))
                kind = op["op"]
                if kind == "list":
                    result = await self._handle_list(schema, op, context)
                elif kind == "read":
                    result = await self._handle_read(schema, op, context)
                elif kind == "create":
                    result = await self._handle_create(schema, op, context)
                elif kind == "update":
                    result = await self._handle_update(schema, op, context)
                elif kind == "delete":
                    result = await self._handle_delete(schema, op, context)
                elif kind == "traverse":
                    result = await self._handle_traverse(schema, op, context)
                elif kind == "count":
                    result = await self._handle_count(schema, op, context)
                else:
                    raise KeymaRuntimeError("UNKNOWN_OP", f'Unknown operation: {kind}')
        except Exception as err:  # noqa: BLE001 — converted to a structured failure
            result = _error_to_result(err)

        for p in self._plugins:
            hook = getattr(p, "after_operation", None)
            if hook is None:
                continue
            try:
                await _maybe_await(hook(context, op, result))
            except Exception:
                # after_operation errors must not change the response.
                pass
        return result

    async def _handle_traverse(
        self, terminal_schema: SchemaMetadata, op: Dict[str, Any], context: RequestContext
    ) -> Dict[str, Any]:
        traverse = getattr(self._adapter, "traverse", None)
        if traverse is None:
            raise KeymaRuntimeError("UNSUPPORTED", "Database adapter does not support traverse operations")
        spec = op["spec"]
        start_schema = self._resolve_schema(spec["start"]["schema"], context)

        edges: Dict[str, SchemaMetadata] = {}
        nodes: Dict[str, SchemaMetadata] = {}
        for name in _collect_edge_names(spec):
            s = self._resolve_schema(name, context)
            if s.get("edge") is None:
                raise KeymaRuntimeError("NOT_AN_EDGE", f'Schema "{name}" is not an edge schema')
            edges[name] = s
            for endpoint in (s["edge"]["from"], s["edge"]["to"]):
                node = self._schema_map.get(endpoint)
                if node is not None:
                    nodes[node["name"]] = node
        nodes[start_schema["name"]] = start_schema
        nodes[terminal_schema["name"]] = terminal_schema

        ctx = {"terminalSchema": terminal_schema, "startSchema": start_schema, "edges": edges, "nodes": nodes}
        projection = self._build_adapter_projection(terminal_schema, op.get("project"))
        projection = await self._run_projection_hooks(context, terminal_schema, projection, "traverse")
        records = await traverse(ctx, spec, projection)
        if isinstance(records, list) and all(_is_plain_record(r) for r in records):
            out = await self._run_result_hooks(context, terminal_schema, records, "traverse")
            return {"ok": True, "data": out}
        return {"ok": True, "data": records}

    async def _handle_list(
        self, schema: SchemaMetadata, op: Dict[str, Any], context: RequestContext
    ) -> Dict[str, Any]:
        where = await self._run_filter_hooks(context, schema, op.get("where") or {}, "list")
        projection = self._build_adapter_projection(schema, op.get("project"))
        projection = await self._run_projection_hooks(context, schema, projection, "list")
        options = op.get("options") or {}
        query: Dict[str, Any] = {"where": where, "sort": options.get("sort") or {}, "projection": projection}
        if options.get("skip") is not None:
            query["skip"] = options["skip"]
        if options.get("limit") is not None:
            query["limit"] = options["limit"]
        records = await self._adapter.list(schema, query)
        out = await self._run_result_hooks(context, schema, records, "list")
        return {"ok": True, "data": out}

    async def _handle_read(
        self, schema: SchemaMetadata, op: Dict[str, Any], context: RequestContext
    ) -> Dict[str, Any]:
        where = await self._run_filter_hooks(context, schema, op["where"], "read")
        projection = self._build_adapter_projection(schema, op.get("project"))
        projection = await self._run_projection_hooks(context, schema, projection, "read")
        record = await self._adapter.read(schema, where, projection)
        if record is None:
            raise KeymaRuntimeError("NOT_FOUND", "Not found")
        out = await self._run_result_hooks(context, schema, [record], "read")
        return {"ok": True, "data": out[0] if out and out[0] is not None else record}

    async def _handle_create(
        self, schema: SchemaMetadata, op: Dict[str, Any], context: RequestContext
    ) -> Dict[str, Any]:
        data = normalize_reference_ids(op["data"], schema)
        apply_defaults(schema, data)
        await _format(schema, data, "save")
        # Flatten the full inheritance chain into ``fields`` and drop ``base`` so the derived
        # validation schema enumerates exactly this filtered set (id may be inherited).
        writable_schema = {**schema, "fields": [f for f in all_fields(schema) if f["name"] != "id"]}
        writable_schema.pop("base", None)
        errors = await validate(writable_schema, data)
        if errors:
            raise _ValidationFailedError(errors)
        data = await self._run_write_hooks(context, schema, data, "create")
        projection = self._build_adapter_projection(schema, op.get("project"))
        projection = await self._run_projection_hooks(context, schema, projection, "create")
        created = await self._adapter.create(schema, data, projection)
        out = await self._run_result_hooks(context, schema, [created], "create")
        return {"ok": True, "data": out[0] if out and out[0] is not None else created}

    async def _handle_update(
        self, schema: SchemaMetadata, op: Dict[str, Any], context: RequestContext
    ) -> Dict[str, Any]:
        data = normalize_reference_ids(op["data"], schema)
        await _format(schema, data, "save")
        # A partial update only validates the fields actually supplied.
        update_schema = {**schema, "fields": [f for f in all_fields(schema) if f["name"] in data]}
        update_schema.pop("base", None)
        errors = await validate(update_schema, data)
        if errors:
            raise _ValidationFailedError(errors)
        data = await self._run_write_hooks(context, schema, data, "update")
        where = await self._run_filter_hooks(context, schema, op["where"], "update")
        projection = self._build_adapter_projection(schema, op.get("project"))
        projection = await self._run_projection_hooks(context, schema, projection, "update")
        updated = await self._adapter.update(schema, where, data, projection)
        out = await self._run_result_hooks(context, schema, [updated], "update")
        return {"ok": True, "data": out[0] if out and out[0] is not None else updated}

    async def _handle_delete(
        self, schema: SchemaMetadata, op: Dict[str, Any], context: RequestContext
    ) -> Dict[str, Any]:
        where = await self._run_filter_hooks(context, schema, op["where"], "delete")
        await self._adapter.delete(schema, where)
        return {"ok": True, "data": None}

    async def _handle_count(
        self, schema: SchemaMetadata, op: Dict[str, Any], context: RequestContext
    ) -> Dict[str, Any]:
        where = await self._run_filter_hooks(context, schema, op.get("where") or {}, "count")
        n = await self._adapter.count(schema, where)
        return {"ok": True, "data": n}

    async def _handle_call(self, op: Dict[str, Any], context: RequestContext) -> Dict[str, Any]:
        is_system = _is_system(context)

        entry = self._service_map.get(op["service"])
        if entry is None or (entry["metadata"].get("visibility") == "private" and not is_system):
            raise KeymaRuntimeError("SERVICE_NOT_FOUND", f'Unknown service: {op["service"]}')

        method = next((m for m in entry["metadata"]["methods"] if m["name"] == op["method"]), None)
        if method is None or (method.get("visibility") == "private" and not is_system):
            raise KeymaRuntimeError(
                "METHOD_NOT_FOUND", f'Unknown method "{op["method"]}" on service "{op["service"]}"'
            )

        impl = getattr(entry["instance"], op["method"], None)
        if not callable(impl):
            raise KeymaRuntimeError(
                "METHOD_NOT_IMPLEMENTED", f'Service "{op["service"]}" does not implement "{op["method"]}"'
            )

        # Validate schema-typed arguments against their (ephemeral) input schemas.
        errors: List[Dict[str, Any]] = []
        for param in method["params"]:
            if param.get("schema") is None:
                continue
            param_schema = self._schema_map.get(param["schema"])
            if param_schema is None:
                continue
            value = op["args"].get(param["name"])
            if value is not None:
                errors.extend(await validate(param_schema, value))
        if errors:
            raise _ValidationFailedError(errors)

        # Invoke positionally in declared param order, with request context appended.
        args = [op["args"].get(p["name"]) for p in method["params"]]
        data = await _maybe_await(impl(*args, context))
        return {"ok": True, "data": data}

    # ── Hook folds ───────────────────────────────────────────────────────────

    async def _run_filter_hooks(
        self, context: RequestContext, schema: SchemaMetadata, where: Dict[str, Any], action: str
    ) -> Dict[str, Any]:
        acc = where
        for p in self._plugins:
            hook = getattr(p, "transform_filter", None)
            if hook is None:
                continue
            nxt = await _maybe_await(hook(context, schema, acc, action))
            if nxt is not None:
                acc = nxt
        return acc

    async def _run_projection_hooks(
        self, context: RequestContext, schema: SchemaMetadata, projection: Dict[str, Any], action: str
    ) -> Dict[str, Any]:
        acc = projection
        for p in self._plugins:
            hook = getattr(p, "transform_projection", None)
            if hook is None:
                continue
            nxt = await _maybe_await(hook(context, schema, acc, action))
            if nxt is not None:
                acc = nxt
        return acc

    async def _run_write_hooks(
        self, context: RequestContext, schema: SchemaMetadata, data: Dict[str, Any], action: str
    ) -> Dict[str, Any]:
        acc = data
        for p in self._plugins:
            hook = getattr(p, "check_write", None)
            if hook is None:
                continue
            nxt = await _maybe_await(hook(context, schema, acc, action))
            if nxt is not None:
                acc = nxt
        return acc

    async def _run_result_hooks(
        self, context: RequestContext, schema: SchemaMetadata, records: List[Dict[str, Any]], action: str
    ) -> List[Dict[str, Any]]:
        acc = records
        for p in self._plugins:
            hook = getattr(p, "transform_result", None)
            if hook is None:
                continue
            nxt = await _maybe_await(hook(context, schema, acc, action))
            if nxt is not None:
                acc = nxt
        return acc

    # ── Projection builder ───────────────────────────────────────────────────

    def _build_adapter_projection(
        self, schema: SchemaMetadata, spec: Optional[Dict[str, Any]]
    ) -> Dict[str, Any]:
        fields: Dict[str, Any] = {}
        populate: Dict[str, Any] = {}

        if spec is not None:
            entries = [
                (key, sub)
                for key, sub in spec.items()
                if (_find_field(schema, key) is None or _find_field(schema, key).get("visibility") != "private")
            ]
        else:
            entries = [(f["name"], 1) for f in all_fields(schema) if f.get("visibility") != "private"]

        edge = schema.get("edge")

        for key, sub in entries:
            field = _find_field(schema, key)
            type_ = _core_type(field["type"]) if field is not None else None

            # Edge endpoints always materialize as objects ({ id } by default, or the
            # requested sub-projection with id always included).
            if edge is not None and (key == edge["fromField"] or key == edge["toField"]):
                target_name = edge["from"] if key == edge["fromField"] else edge["to"]
                referenced = self._schema_map.get(target_name)
                if referenced is not None:
                    if sub == 1:
                        nested: Dict[str, Any] = {"fields": {"id": 1}}
                    else:
                        nested = _with_id_field(self._build_adapter_projection(referenced, sub))
                    populate[key] = {"schema": referenced, "projection": nested}
                    continue

            if type_ is not None and type_["kind"] == "reference" and sub != 1:
                referenced = self._schema_map.get(type_["schema"])
                if referenced is not None:
                    nested_projection = self._build_adapter_projection(referenced, sub)
                    populate[key] = {"schema": referenced, "projection": nested_projection}
                    continue

            if type_ is not None and type_["kind"] == "embedded" and sub != 1:
                fields[key] = _build_embedded_spec(sub)
                continue

            fields[key] = 1

        result: Dict[str, Any] = {}
        if fields:
            result["fields"] = fields
        if populate:
            result["populate"] = populate
        return result
