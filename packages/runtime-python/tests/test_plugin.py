"""Port of ``@keyma/runtime-js`` ``test/plugin.test.ts``.

describe("KeymaServer — plugin surface")
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from keyma.runtime import KeymaPluginError, KeymaServer
from fixtures import USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA


# ── Recording in-memory adapter ──────────────────────────────────────────────


def _apply_embedded_spec(value: Dict[str, Any], spec: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, sub in spec.items():
        if sub == 1:
            result[key] = value.get(key)
        else:
            nested = value.get(key)
            result[key] = (
                _apply_embedded_spec(nested, sub)
                if isinstance(nested, dict)
                else None
            )
    return result


def _apply_projection(record: Dict[str, Any], projection: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, spec in (projection.get("fields") or {}).items():
        if spec == 1:
            result[key] = record.get(key)
        else:
            value = record.get(key)
            result[key] = (
                _apply_embedded_spec(value, spec) if isinstance(value, dict) else None
            )
    return result


class RecordingAdapter:
    def __init__(self) -> None:
        self.stores: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.calls: List[Dict[str, Any]] = []
        self._counter = 0

    def _store_for(self, schema: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        s = self.stores.get(schema["name"])
        if s is None:
            s = {}
            self.stores[schema["name"]] = s
        return s

    async def ensure_schema(self, schema: Dict[str, Any]) -> None:
        self._store_for(schema)

    async def create(
        self,
        schema: Dict[str, Any],
        data: Dict[str, Any],
        projection: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        self.calls.append({"kind": "create", "schema": schema["name"], "data": data})
        store = self._store_for(schema)
        self._counter += 1
        id_ = data.get("id") or f"{schema['name']}-{self._counter}"
        record = {**data, "id": id_}
        store[id_] = record
        return _apply_projection(record, projection) if projection is not None else record

    async def read(
        self,
        schema: Dict[str, Any],
        where: Dict[str, Any],
        projection: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        self.calls.append({"kind": "read", "schema": schema["name"], "where": where})
        store = self._store_for(schema)
        id_ = where["id"]
        record = store.get(id_)
        if record is None or projection is None:
            return record
        return _apply_projection(record, projection)

    async def list(self, schema: Dict[str, Any], query: Dict[str, Any]) -> List[Dict[str, Any]]:
        self.calls.append({"kind": "list", "schema": schema["name"], "query": query})
        results = list(self._store_for(schema).values())
        # Honor a minimal $eq predicate (the only one the tests need).
        for field, spec in query["where"].items():
            if isinstance(spec, dict) and "$eq" in spec:
                expect = spec["$eq"]
                results = [r for r in results if r.get(field) == expect]
            else:
                results = [r for r in results if r.get(field) == spec]
        if query.get("projection") is not None:
            proj = query["projection"]
            results = [_apply_projection(r, proj) for r in results]
        return results

    async def update(
        self,
        schema: Dict[str, Any],
        where: Dict[str, Any],
        data: Dict[str, Any],
        projection: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        self.calls.append(
            {"kind": "update", "schema": schema["name"], "where": where, "data": data}
        )
        store = self._store_for(schema)
        id_ = where["id"]
        existing = store.get(id_) or {}
        updated = {**existing, **data, "id": id_}
        store[id_] = updated
        return _apply_projection(updated, projection) if projection is not None else updated

    async def delete(self, schema: Dict[str, Any], where: Dict[str, Any]) -> None:
        self.calls.append({"kind": "delete", "schema": schema["name"], "where": where})
        store = self._store_for(schema)
        id_ = where["id"]
        store.pop(id_, None)

    async def count(self, schema: Dict[str, Any], where: Optional[Dict[str, Any]] = None) -> int:
        self.calls.append(
            {"kind": "count", "schema": schema["name"], "where": where or {}}
        )
        return 0


def make_server(plugins: List[Any]):
    adapter = RecordingAdapter()
    server = KeymaServer(
        schemas=[USER_SCHEMA, ORGANIZATION_SCHEMA, ADDRESS_SCHEMA],
        adapter=adapter,
        plugins=plugins,
    )
    return server, adapter


def _find_call(adapter: RecordingAdapter, kind: str) -> Optional[Dict[str, Any]]:
    for c in adapter.calls:
        if c["kind"] == kind:
            return c
    return None


# ── Tests ────────────────────────────────────────────────────────────────────


async def test_transform_filter_rewritten_where_reaches_the_adapter():
    class Plugin:
        name = "scope"

        def transform_filter(self, ctx, schema, where, action):
            return {"$and": [where, {"tenant": {"$eq": "t1"}}]}

    server, adapter = make_server([Plugin()])
    req = {
        "operations": {
            "a": {"op": "list", "schema": "user", "where": {"active": True}},
        }
    }
    await server.handle(req)
    call = _find_call(adapter, "list")
    assert call is not None and call["kind"] == "list"
    assert call["query"]["where"] == {
        "$and": [{"active": True}, {"tenant": {"$eq": "t1"}}],
    }


async def test_transform_filter_plugins_fold_in_registration_order():
    log: List[str] = []

    class P1:
        name = "p1"

        def transform_filter(self, ctx, schema, where, action):
            log.append(f"p1 saw {json.dumps(where, separators=(',', ':'))}")
            return {**where, "p1": 1}

    class P2:
        name = "p2"

        def transform_filter(self, ctx, schema, where, action):
            log.append(f"p2 saw {json.dumps(where, separators=(',', ':'))}")
            return {**where, "p2": 1}

    server, adapter = make_server([P1(), P2()])
    await server.handle(
        {"operations": {"a": {"op": "list", "schema": "user", "where": {"x": 0}}}}
    )
    call = _find_call(adapter, "list")
    assert call is not None and call["kind"] == "list"
    assert call["query"]["where"] == {"x": 0, "p1": 1, "p2": 1}
    assert log[0] == 'p1 saw {"x":0}'
    assert log[1] == 'p2 saw {"x":0,"p1":1}'


async def test_keyma_plugin_error_forbidden_from_before_operation_surfaces_with_source_origin():
    class Plugin:
        name = "deny-all"

        def before_operation(self, ctx, op):
            raise KeymaPluginError("FORBIDDEN", "nope", "deny-all")

    server, _ = make_server([Plugin()])
    resp = await server.handle({"operations": {"a": {"op": "list", "schema": "user"}}})
    a = resp["results"]["a"]
    assert a["ok"] == False
    assert a["code"] == "FORBIDDEN"
    assert a["source"] == "plugin"
    assert a["origin"] == "deny-all"


async def test_keyma_plugin_error_field_forbidden_from_check_write_carries_field_extras():
    class Plugin:
        name = "no-secret"

        def check_write(self, ctx, schema, data, action):
            if "secret" in data:
                raise KeymaPluginError(
                    "FIELD_FORBIDDEN",
                    "Forbidden fields: secret",
                    "no-secret",
                    {"fields": ["secret"]},
                )

    server, _ = make_server([Plugin()])
    resp = await server.handle(
        {
            "operations": {
                "a": {
                    "op": "create",
                    "schema": "user",
                    "data": {"email": "u@x.com", "name": "Alice", "secret": "shh"},
                },
            }
        }
    )
    a = resp["results"]["a"]
    assert a["code"] == "FIELD_FORBIDDEN"
    assert a["source"] == "plugin"
    assert a["fields"] == ["secret"]


async def test_non_keyma_exceptions_become_internal_error_not_poisoning_the_batch():
    class Plugin:
        name = "boom"

        def before_operation(self, ctx, op):
            if "schema" in op and op["schema"] == "user":
                raise Exception("kaboom")

    server, adapter = make_server([Plugin()])
    adapter.stores["organization"] = {
        "o1": {"id": "o1", "name": "Acme", "tier": "pro"}
    }
    resp = await server.handle(
        {
            "operations": {
                "bad": {"op": "list", "schema": "user"},
                "good": {"op": "list", "schema": "organization"},
            }
        }
    )
    bad = resp["results"]["bad"]
    good = resp["results"]["good"]
    assert bad["code"] == "INTERNAL_ERROR"
    assert bad["source"] == "runtime"
    assert bad["error"] == "kaboom"
    assert good["ok"] == True


async def test_transform_projection_trims_fields_before_adapter_call():
    class Plugin:
        name = "hide-email"

        def transform_projection(self, ctx, schema, proj, action):
            if proj.get("fields") is not None:
                rest = {k: v for k, v in proj["fields"].items() if k != "email"}
                return {**proj, "fields": rest}
            return proj

    server, adapter = make_server([Plugin()])
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "a@b.com", "name": "Alice"}
    }
    resp = await server.handle(
        {"operations": {"a": {"op": "read", "schema": "user", "where": {"id": "u1"}}}}
    )
    a = resp["results"]["a"]
    assert a["ok"] == True
    assert ("email" in a["data"]) == False
    assert a["data"]["name"] == "Alice"


async def test_transform_result_post_processes_records_on_the_way_out():
    class Plugin:
        name = "strip-extras"

        def transform_result(self, ctx, schema, records, action):
            return [{"id": r["id"], "name": r["name"]} for r in records]

    server, adapter = make_server([Plugin()])
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "a@b.com", "name": "Alice", "extra": 1},
        "u2": {"id": "u2", "email": "b@b.com", "name": "Bob", "extra": 2},
    }
    resp = await server.handle({"operations": {"a": {"op": "list", "schema": "user"}}})
    a = resp["results"]["a"]
    assert a["data"] == [
        {"id": "u1", "name": "Alice"},
        {"id": "u2", "name": "Bob"},
    ]


async def test_check_write_returned_data_replaces_the_payload_sent_to_the_adapter():
    class Plugin:
        name = "force-tenant"

        def check_write(self, ctx, schema, data, action):
            return {**data, "tenant": "t1"}

    server, adapter = make_server([Plugin()])
    await server.handle(
        {
            "operations": {
                "a": {
                    "op": "create",
                    "schema": "user",
                    "data": {"email": "u@x.com", "name": "Alice"},
                },
            }
        }
    )
    created = _find_call(adapter, "create")
    assert created is not None and created["kind"] == "create"
    assert created["data"]["tenant"] == "t1"


async def test_context_passed_through_handle_to_plugins():
    seen: Dict[str, Any] = {}

    class Plugin:
        name = "see-ctx"

        def before_operation(self, ctx, op):
            identity = ctx.get("identity")
            seen["id"] = identity.get("id") if identity else None

    server, adapter = make_server([Plugin()])
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "a@b.com", "name": "Alice"}
    }
    await server.handle(
        {"operations": {"a": {"op": "read", "schema": "user", "where": {"id": "u1"}}}},
        {"identity": {"id": "alice"}},
    )
    assert seen["id"] == "alice"


async def test_init_called_once_sees_all_schemas():
    state: Dict[str, Any] = {"init_count": 0, "seen_schemas": []}

    class Plugin:
        name = "init-check"

        def init(self, server):
            state["init_count"] += 1
            state["seen_schemas"] = [s["name"] for s in server.schemas]

    server, adapter = make_server([Plugin()])
    adapter.stores["user"] = {}
    await server.handle({"operations": {"a": {"op": "list", "schema": "user"}}})
    await server.handle({"operations": {"b": {"op": "list", "schema": "user"}}})
    assert state["init_count"] == 1
    assert "user" in state["seen_schemas"]
    assert "organization" in state["seen_schemas"]


async def test_after_operation_errors_thrown_there_do_not_poison_the_response():
    class Plugin:
        name = "noisy-logger"

        def after_operation(self, ctx, op, result):
            raise Exception("logger blew up")

    server, adapter = make_server([Plugin()])
    adapter.stores["user"] = {
        "u1": {"id": "u1", "email": "a@b.com", "name": "Alice"}
    }
    resp = await server.handle(
        {"operations": {"a": {"op": "read", "schema": "user", "where": {"id": "u1"}}}}
    )
    a = resp["results"]["a"]
    assert a["ok"] == True
