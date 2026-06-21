"""Port of ``@keyma/runtime-js`` ``test/call.test.ts``.

describe groups:
  - "KeymaServer — call dispatch"
  - "call — plugin hooks"
  - "Keyma.call — client builder"
"""

from typing import Any, Dict, List, Optional

import pytest

from keyma.runtime import (
    Keyma,
    KeymaServer,
    brand_schema,
    brand_service,
    create_direct_transport,
)
from keyma.runtime.testing import InMemoryAdapter

from fixtures import ORGANIZATION_SCHEMA


# ── fixtures ─────────────────────────────────────────────────────────────────


def required(v, field):
    if v is None or v == "":
        return {"field": field, "code": "required", "message": "required"}
    return None


GREET_INPUT_SCHEMA: Dict[str, Any] = {
    "name": "greetInput",
    "sourceName": "GreetInput",
    "ephemeral": True,
    "fields": [{"name": "name", "type": {"kind": "string"}, "validators": [required]}],
}


class GreetResultCtor:
    def __init__(self, value: Optional[Dict[str, Any]] = None) -> None:
        if value:
            for k, v in value.items():
                setattr(self, k, v)


GREET_RESULT_SCHEMA: Dict[str, Any] = {
    "name": "greetResult",
    "sourceName": "GreetResult",
    "ephemeral": True,
    "fields": [{"name": "message", "type": {"kind": "string"}}],
}
GreetResult = brand_schema(GreetResultCtor, GREET_RESULT_SCHEMA)


GREET_SERVICE_META: Dict[str, Any] = {
    "name": "GreetService",
    "methods": [
        {"name": "greet", "params": [{"name": "input", "schema": "greetInput"}], "returnSchema": "greetResult"},
        {"name": "shout", "params": [{"name": "text"}]},
        {"name": "boom", "params": []},
        {"name": "secret", "visibility": "private", "params": []},
    ],
    "refs": {"greetResult": GreetResult},
}


class GreetServiceBase:
    pass


brand_service(GreetServiceBase, GREET_SERVICE_META)


class GreetServiceImpl(GreetServiceBase):
    async def greet(self, input: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
        identity = ctx.get("identity") or {}
        who = f" (by {identity['id']})" if identity.get("id") else ""
        return {"message": f"Hi {input['name']}{who}"}

    def shout(self, text: str, ctx: Dict[str, Any]) -> str:
        return text.upper()

    def boom(self, ctx: Dict[str, Any]):
        raise Exception("kaboom")

    def secret(self, ctx: Dict[str, Any]) -> str:
        return "classified"


ADMIN_SERVICE_META: Dict[str, Any] = {
    "name": "AdminService",
    "visibility": "private",
    "methods": [{"name": "wipe", "params": []}],
}


class AdminServiceBase:
    pass


brand_service(AdminServiceBase, ADMIN_SERVICE_META)


class AdminServiceImpl(AdminServiceBase):
    def wipe(self, ctx: Dict[str, Any]) -> str:
        return "wiped"


# Client-side handle for Keyma.call(...) — the Python builder reads `service.service`
# metadata off the class, so the base branded class is the handle.
GreetService = GreetServiceBase


def make_server(plugins: Optional[List[Any]] = None):
    adapter = InMemoryAdapter()
    server = KeymaServer(
        schemas=[GREET_INPUT_SCHEMA, GREET_RESULT_SCHEMA, ORGANIZATION_SCHEMA],
        adapter=adapter,
        plugins=plugins or [],
        services=[GreetServiceImpl(), lambda: AdminServiceImpl()],
    )
    return server, adapter


async def call(
    server: KeymaServer,
    op: Dict[str, Any],
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    req = {
        "operations": {
            "a": {"op": "call", "service": op["service"], "method": op["method"], "args": op.get("args") or {}}
        }
    }
    resp = await server.handle(req, context or {})
    return resp["results"]["a"]


# ── tests ────────────────────────────────────────────────────────────────────

# describe group: "KeymaServer — call dispatch"


async def test_dispatches_to_the_registered_impl_and_returns_the_value():
    server, _ = make_server()
    r = await call(server, {"service": "GreetService", "method": "shout", "args": {"text": "hey"}})
    assert r["ok"] == True
    assert r["data"] == "HEY"


async def test_validates_schema_typed_args_against_their_input_schema():
    server, _ = make_server()
    r = await call(server, {"service": "GreetService", "method": "greet", "args": {"input": {"name": ""}}})
    assert r["ok"] == False
    assert r["code"] == "VALIDATION_FAILED"
    assert [e["code"] for e in (r.get("errors") or [])] == ["required"]


async def test_passes_request_context_to_the_handler_as_the_trailing_argument():
    server, _ = make_server()
    r = await call(
        server,
        {"service": "GreetService", "method": "greet", "args": {"input": {"name": "Ann"}}},
        {"identity": {"id": "u1"}},
    )
    assert r["ok"] == True
    assert r["data"]["message"] == "Hi Ann (by u1)"


async def test_unknown_service_service_not_found():
    server, _ = make_server()
    r = await call(server, {"service": "Nope", "method": "x"})
    assert r["code"] == "SERVICE_NOT_FOUND"


async def test_unknown_method_method_not_found():
    server, _ = make_server()
    r = await call(server, {"service": "GreetService", "method": "nope"})
    assert r["code"] == "METHOD_NOT_FOUND"


async def test_a_handler_that_throws_becomes_internal_error():
    server, _ = make_server()
    r = await call(server, {"service": "GreetService", "method": "boom"})
    assert r["ok"] == False
    assert r["code"] == "INTERNAL_ERROR"
    assert r["source"] == "runtime"


async def test_private_methods_are_hidden_from_non_system_callers():
    server, _ = make_server()
    denied = await call(server, {"service": "GreetService", "method": "secret"})
    assert denied["code"] == "METHOD_NOT_FOUND"
    ok = await call(
        server,
        {"service": "GreetService", "method": "secret"},
        {"identity": {"isSystem": True}},
    )
    assert ok["data"] == "classified"


async def test_private_services_are_hidden_from_non_system_callers_factory_provider():
    server, _ = make_server()
    denied = await call(server, {"service": "AdminService", "method": "wipe"})
    assert denied["code"] == "SERVICE_NOT_FOUND"
    ok = await call(
        server,
        {"service": "AdminService", "method": "wipe"},
        {"identity": {"isSystem": True}},
    )
    assert ok["data"] == "wiped"


async def test_batches_a_call_alongside_a_crud_op_in_one_request():
    server, _ = make_server()
    resp = await server.handle(
        {
            "operations": {
                "n": {"op": "count", "schema": "organization"},
                "g": {"op": "call", "service": "GreetService", "method": "shout", "args": {"text": "hi"}},
            }
        }
    )
    assert resp["results"]["n"]["data"] == 0
    assert resp["results"]["g"]["data"] == "HI"


# describe group: "call — plugin hooks"


async def test_runs_op_level_hooks_for_a_call_op_without_crashing_on_op_schema():
    events: List[str] = []

    class SpyPlugin:
        name = "spy"

        def transform_operation(self, _ctx, op):
            events.append(f"transform:{op['op']}")
            # A real plugin must guard schema access since calls have no schema.
            if "schema" in op:
                events.append(f"schema:{op['schema']}")
            return None

        def before_operation(self, _ctx, op):
            events.append(f"before:{op['op']}")

        def after_operation(self, _ctx, op, result):
            events.append(f"after:{op['op']}:{result['ok']}")

    server, _ = make_server([SpyPlugin()])
    await call(server, {"service": "GreetService", "method": "shout", "args": {"text": "x"}})
    assert events == ["transform:call", "before:call", "after:call:True"]


# describe group: "Keyma.call — client builder"


async def test_builds_a_call_op_substitutes_inputs_and_hydrates_a_schema_return():
    server, _ = make_server()
    transport = create_direct_transport(server)
    doc = Keyma.mutation({"g": Keyma.call(GreetService, "greet", {"input": {"name": "Ada"}})})
    res = await doc.request({}, inputs={}, transport=transport)
    results = res["results"]
    assert results["g"]["ok"] == True
    data = results["g"]["data"]
    assert isinstance(data, GreetResultCtor)
    assert data.message == "Hi Ada"


async def test_passes_a_primitive_return_through_without_hydration():
    server, _ = make_server()
    transport = create_direct_transport(server)
    doc = Keyma.mutation({"s": Keyma.call(GreetService, "shout", {"text": "loud"})})
    res = await doc.request({}, inputs={}, transport=transport)
    assert res["results"]["s"]["data"] == "LOUD"


async def test_substitutes_an_input_placeholder_into_call_args():
    server, _ = make_server()
    transport = create_direct_transport(server)
    doc = Keyma.mutation({"s": Keyma.call(GreetService, "shout", {"text": Keyma.input("t")})})
    res = await doc.request({}, inputs={"s": {"t": "param"}}, transport=transport)
    assert res["results"]["s"]["data"] == "PARAM"
