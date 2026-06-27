"""End-to-end ``@Service`` calls over the in-process direct transport — both encodings, with host
visibility gating and ``ctx`` honoured. Drives the generated-style fixtures in ``_generated.py``,
so it pins the runtime calling convention against the backend's emitted shape."""

from __future__ import annotations

import pytest

from keyma.runtime import (
    HANDLER_ERROR,
    METHOD_NOT_FOUND,
    SERVICE_NOT_FOUND,
    CallRequest,
    KeymaError,
    ServiceHost,
    create_direct_transport,
)

from _generated import (
    AdminServiceBase,
    AdminServiceClient,
    User,
    UserServiceBase,
    UserServiceClient,
)


# ── Application service implementations (extend the generated bases) ─────────────


class UserService(UserServiceBase):
    def __init__(self):
        self.store = {}

    async def create(self, data, ctx):
        # `ctx` is injected last; the impl may be sync or async (this one is async). The caller
        # identity is baked into a serialized field so it survives the round-trip.
        caller = (ctx or {}).get("identity", {}).get("id", "anon")
        uid = f"user-{caller}"
        record = User.from_value({"id": uid, "name": data.name, "age": data.age})
        self.store[uid] = record
        return record

    def get(self, id, ctx):  # a SYNC impl — the host awaits whatever dispatch returns
        return self.store.get(id)

    async def purge(self, ctx):
        self.store.clear()


class AdminService(AdminServiceBase):
    async def stats(self, ctx):
        return 42


def _host():
    host = ServiceHost()
    host.register(UserService())
    host.register(AdminService())
    return host


@pytest.mark.parametrize("encoding", ["json", "binary"])
async def test_round_trip_call_both_encodings(encoding):
    host = _host()
    transport = create_direct_transport(host, encoding=encoding)
    client = UserServiceClient(transport)

    created = await client.create(User.from_value({"name": "Ada", "age": 36}))
    assert isinstance(created, User)
    assert created.id == "user-anon"  # default non-system ctx has no identity id
    assert created.name == "Ada"
    assert created.age == 36

    fetched = await client.get("user-anon")
    assert isinstance(fetched, User)
    assert fetched.name == "Ada"


@pytest.mark.parametrize("encoding", ["json", "binary"])
async def test_void_return(encoding):
    host = _host()
    # `purge` is a private method — reachable only with a system ctx.
    transport = create_direct_transport(host, is_system=True, encoding=encoding)
    client = UserServiceClient(transport)
    await client.create(User.from_value({"name": "Ada", "age": 36}))
    result = await client.purge()
    assert result is None


async def test_ctx_is_honoured():
    host = _host()
    transport = create_direct_transport(host, ctx={"identity": {"id": "caller-9"}})
    client = UserServiceClient(transport)
    created = await client.create(User.from_value({"name": "Bo", "age": 20}))
    assert created.id == "user-caller-9"


# ── Visibility gating (probe-resistant) ──────────────────────────────────────────


async def test_private_service_hidden_from_non_system_caller():
    host = _host()
    transport = create_direct_transport(host)  # default non-system
    client = AdminServiceClient(transport)
    with pytest.raises(KeymaError) as exc:
        await client.stats()
    assert exc.value.code == SERVICE_NOT_FOUND


async def test_private_service_reachable_by_system_caller():
    host = _host()
    transport = create_direct_transport(host, is_system=True)
    client = AdminServiceClient(transport)
    assert await client.stats() == 42


async def test_private_method_hidden_from_non_system_caller():
    host = _host()
    transport = create_direct_transport(host)  # purge is private
    client = UserServiceClient(transport)
    with pytest.raises(KeymaError) as exc:
        await client.purge()
    assert exc.value.code == METHOD_NOT_FOUND


# ── Error surfaces ───────────────────────────────────────────────────────────────


async def test_unknown_service_is_not_found():
    host = _host()
    result = await host.handle(CallRequest("Nope", "x", None), {}, "json")
    assert result.ok is False
    assert result.code == SERVICE_NOT_FOUND


async def test_unknown_method_is_not_found():
    host = _host()
    result = await host.handle(CallRequest("UserService", "nope", {}), {}, "json")
    assert result.ok is False
    assert result.code == METHOD_NOT_FOUND


async def test_handler_exception_collapses_to_handler_error():
    class Boom(UserServiceBase):
        async def get(self, id, ctx):
            raise RuntimeError("kaboom")

    host = ServiceHost()
    host.register(Boom())
    transport = create_direct_transport(host)
    client = UserServiceClient(transport)
    with pytest.raises(KeymaError) as exc:
        await client.get("x")
    assert exc.value.code == HANDLER_ERROR
    assert "kaboom" in exc.value.message


async def test_unimplemented_method_raises_not_implemented():
    # A base method left unimplemented raises METHOD_NOT_IMPLEMENTED through the envelope.
    host = ServiceHost()
    host.register(UserServiceBase())  # no overrides
    transport = create_direct_transport(host)
    client = UserServiceClient(transport)
    with pytest.raises(KeymaError) as exc:
        await client.get("x")
    assert exc.value.code == "METHOD_NOT_IMPLEMENTED"
