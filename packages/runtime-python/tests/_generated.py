"""Generated-style fixtures — hand-written to mirror EXACTLY what
``@keyma/compiler/backend-python`` emits, so the runtime tests pin the calling convention the
baked codec + RPC stack must honour:

- model classes carry their metadata as ``Class.metadata`` (a camelCase ``dict``); embedded /
  reference field types key the target by ``target``; ``refs`` maps the target ``name`` to the
  generated class;
- hydration is the static ``from_value`` factory + ``_hydrate`` (008), never ``__init__``;
- a service implementation base carries ``service_name`` / ``service_private`` / ``_methods`` and a
  ``dispatch(method, payload, ctx, encoding)`` that marshals via ``encode_result`` / ``decode_args``;
- the generated client class extends ``ServiceClient`` and marshals via ``encode_args`` /
  ``decode_result``.

If the runtime's convention drifts from this shape, these break.
"""

from __future__ import annotations

import inspect

from keyma.runtime import (
    HANDLER_ERROR,
    METHOD_NOT_FOUND,
    METHOD_NOT_IMPLEMENTED,
    KeymaError,
    ServiceClient,
    decode_args,
    decode_result,
    encode_args,
    encode_result,
)


# ── Generated-style model classes (Class.metadata is a plain camelCase dict) ─────


class Address:
    @classmethod
    def from_value(cls, value=None):
        obj = cls.__new__(cls)
        obj._hydrate(value)
        return obj

    def _hydrate(self, value=None):
        if value:
            self.line1 = value.get("line1")
            self.city = value.get("city")


Address.metadata = {
    "name": "address",
    "sourceName": "Address",
    "fields": [
        {"name": "line1", "type": {"kind": "string"}},
        {"name": "city", "type": {"kind": "string"}},
    ],
}


class User:
    @classmethod
    def from_value(cls, value=None):
        obj = cls.__new__(cls)
        obj._hydrate(value)
        return obj

    def _hydrate(self, value=None):
        if value:
            self.id = value.get("id")
            self.name = value.get("name")
            self.age = value.get("age")
            self.address = value.get("address")
            self.createdAt = value.get("createdAt")


User.metadata = {
    "name": "user",
    "sourceName": "User",
    "fields": [
        {"name": "id", "type": {"kind": "id"}, "readonly": True},
        {"name": "name", "type": {"kind": "string"}},
        {"name": "age", "type": {"kind": "integer"}},
        {"name": "address", "type": {"kind": "embedded", "target": "address"}, "required": False},
        {"name": "createdAt", "type": {"kind": "dateTime"}, "required": False},
    ],
    "refs": {"address": Address},
}


# ── Generated-style service: abstract base + dispatch ────────────────────────────

_USER = {"kind": "instance", "name": "User"}
_ID = {"kind": "id"}
_REFS = {"User": User}


class UserServiceBase:
    """The generated abstract base the application extends. The wire identity is ``service_name``;
    ``_methods`` carries per-method visibility for the host gate; ``dispatch`` marshals."""

    service_name = "UserService"
    service_private = False
    _methods = {
        "create": {"private": False},
        "get": {"private": False},
        "purge": {"private": True},
    }

    async def create(self, data, ctx):
        raise KeymaError(METHOD_NOT_IMPLEMENTED, "UserService.create is not implemented")

    async def get(self, id, ctx):
        raise KeymaError(METHOD_NOT_IMPLEMENTED, "UserService.get is not implemented")

    async def purge(self, ctx):
        raise KeymaError(METHOD_NOT_IMPLEMENTED, "UserService.purge is not implemented")

    async def dispatch(self, method, payload, ctx, encoding):
        if method == "create":
            args = decode_args(encoding, [("data", _USER)], payload, _REFS)
            result = self.create(*args, ctx)
            if inspect.isawaitable(result):
                result = await result
            return encode_result(encoding, _USER, result, _REFS)
        if method == "get":
            args = decode_args(encoding, [("id", _ID)], payload, _REFS)
            result = self.get(*args, ctx)
            if inspect.isawaitable(result):
                result = await result
            return encode_result(encoding, _USER, result, _REFS)
        if method == "purge":
            result = self.purge(ctx)
            if inspect.isawaitable(result):
                result = await result
            return encode_result(encoding, None, result, _REFS)
        raise KeymaError(METHOD_NOT_FOUND, f"Method '{method}' not found")


# ── Generated-style private service (host-gated) ─────────────────────────────────


class AdminServiceBase:
    service_name = "AdminService"
    service_private = True
    _methods = {"stats": {"private": False}}

    async def stats(self, ctx):
        raise KeymaError(METHOD_NOT_IMPLEMENTED, "AdminService.stats is not implemented")

    async def dispatch(self, method, payload, ctx, encoding):
        if method == "stats":
            result = self.stats(ctx)
            if inspect.isawaitable(result):
                result = await result
            return encode_result(encoding, {"kind": "integer"}, result, _REFS)
        raise KeymaError(METHOD_NOT_FOUND, f"Method '{method}' not found")


# ── Generated-style clients ──────────────────────────────────────────────────────


class UserServiceClient(ServiceClient):
    service_name = "UserService"

    async def create(self, data):
        args = encode_args(self._encoding, [("data", _USER)], [data], _REFS)
        out = await self._invoke("create", args)
        return decode_result(self._encoding, _USER, out, _REFS)

    async def get(self, id):
        args = encode_args(self._encoding, [("id", _ID)], [id], _REFS)
        out = await self._invoke("get", args)
        return decode_result(self._encoding, _USER, out, _REFS)

    async def purge(self):
        args = encode_args(self._encoding, [], [], _REFS)
        out = await self._invoke("purge", args)
        return decode_result(self._encoding, None, out, _REFS)


class AdminServiceClient(ServiceClient):
    service_name = "AdminService"

    async def stats(self):
        args = encode_args(self._encoding, [], [], _REFS)
        out = await self._invoke("stats", args)
        return decode_result(self._encoding, {"kind": "integer"}, out, _REFS)
