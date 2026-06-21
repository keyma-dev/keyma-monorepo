"""The ``Keyma`` query builder — runtime port of ``@keyma/runtime-js`` ``query.ts``.

Only the *runtime* of query.ts is ported: leaf construction, ``Input`` placeholders,
operation building, input substitution, and result hydration. The bulk of query.ts is
TypeScript compile-time type machinery (projection math, traversal terminal-node
inference) that has no Python equivalent — Python builds operation dicts dynamically.

``Keyma`` exposes ``query`` / ``mutation`` (document builders), the leaf builders
``list`` / ``read`` / ``create`` / ``update`` / ``delete`` / ``traverse`` / ``count``
/ ``call``, and ``input`` (a request-time placeholder).
"""

from __future__ import annotations

import inspect
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .deserialize import deserialize
from .protocol import KeymaLeafResult, KeymaOperation, KeymaRequest, Transport


# ── Input placeholders ──────────────────────────────────────────────────────


class Input:
    """A request-time placeholder, substituted from a leaf's inputs map."""

    __slots__ = ("name",)

    def __init__(self, name: str) -> None:
        self.name = name


def _is_input(v: Any) -> bool:
    return isinstance(v, Input)


# ── Leaf ─────────────────────────────────────────────────────────────────────


class _Leaf:
    """A single operation leaf. Mirrors the JS leaf object (op + schema class +
    where/data/project, or spec for traverse, or service/method/args for call)."""

    __slots__ = (
        "op",
        "schema_class",
        "where",
        "data",
        "project",
        "spec",
        "service",
        "method",
        "args",
        "return_class",
        "return_array",
    )

    def __init__(
        self,
        op: str,
        *,
        schema_class: Any = None,
        where: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        project: Optional[Dict[str, Any]] = None,
        spec: Optional[Dict[str, Any]] = None,
        service: Optional[str] = None,
        method: Optional[str] = None,
        args: Optional[Dict[str, Any]] = None,
        return_class: Any = None,
        return_array: bool = False,
    ) -> None:
        self.op = op
        self.schema_class = schema_class
        self.where = where
        self.data = data
        self.project = project
        self.spec = spec
        self.service = service
        self.method = method
        self.args = args
        self.return_class = return_class
        self.return_array = return_array


# ── Leaf builders ───────────────────────────────────────────────────────────


def _list(cls: Any, where: Optional[Dict[str, Any]] = None, project: Optional[Dict[str, Any]] = None) -> _Leaf:
    return _Leaf("list", schema_class=cls, where=where, project=project)


def _read(cls: Any, where: Dict[str, Any], project: Optional[Dict[str, Any]] = None) -> _Leaf:
    return _Leaf("read", schema_class=cls, where=where, project=project)


def _create(cls: Any, data: Dict[str, Any], project: Optional[Dict[str, Any]] = None) -> _Leaf:
    return _Leaf("create", schema_class=cls, data=data, project=project)


def _update(
    cls: Any, where: Dict[str, Any], data: Dict[str, Any], project: Optional[Dict[str, Any]] = None
) -> _Leaf:
    return _Leaf("update", schema_class=cls, where=where, data=data, project=project)


def _delete(cls: Any, where: Dict[str, Any]) -> _Leaf:
    return _Leaf("delete", schema_class=cls, where=where)


def _count(cls: Any, where: Optional[Dict[str, Any]] = None) -> _Leaf:
    return _Leaf("count", schema_class=cls, where=where)


def _traverse(cls: Any, args: Dict[str, Any]) -> _Leaf:
    """Build a traverse leaf. ``args.start.schema`` and each ``step.via`` are schema
    classes; their canonical ``name`` is read off the static ``.schema`` metadata."""
    spec: Dict[str, Any] = {
        "start": {"schema": args["start"]["schema"].schema["name"], "where": args["start"]["where"]},
        "emit": args.get("emit") or "nodes",
    }
    if args.get("steps") is not None:
        steps: List[Dict[str, Any]] = []
        for s in args["steps"]:
            step: Dict[str, Any] = {"via": s["via"].schema["name"], "direction": s["direction"]}
            if s.get("edgeWhere") is not None:
                step["edgeWhere"] = s["edgeWhere"]
            if s.get("nodeWhere") is not None:
                step["nodeWhere"] = s["nodeWhere"]
            steps.append(step)
        spec["steps"] = steps
    if args.get("repeat") is not None:
        r = args["repeat"]
        rstep: Dict[str, Any] = {"via": r["via"].schema["name"], "direction": r["direction"]}
        if r.get("edgeWhere") is not None:
            rstep["edgeWhere"] = r["edgeWhere"]
        if r.get("nodeWhere") is not None:
            rstep["nodeWhere"] = r["nodeWhere"]
        spec["repeat"] = rstep
    if args.get("depth") is not None:
        spec["depth"] = args["depth"]
    if args.get("where") is not None:
        spec["where"] = args["where"]
    return _Leaf("traverse", schema_class=cls, spec=spec, project=args.get("project"))


def _call(service: Any, method: str, args: Dict[str, Any]) -> _Leaf:
    meta = service.service
    method_meta = next((m for m in meta["methods"] if m["name"] == method), None)
    return_schema = method_meta.get("returnSchema") if method_meta else None
    return_class = (meta.get("refs") or {}).get(return_schema) if return_schema is not None else None
    return _Leaf(
        "call",
        service=meta["name"],
        method=method,
        args=args,
        return_class=return_class,
        return_array=(method_meta.get("returnArray", False) if method_meta else False),
    )


def _input(name: str) -> Input:
    return Input(name)


# ── Operation building & substitution ───────────────────────────────────────


def _substitute(template: Dict[str, Any], leaf_inputs: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, value in template.items():
        if _is_input(value):
            if value.name not in leaf_inputs:
                raise ValueError(f'Missing parameter "{value.name}"')
            out[key] = leaf_inputs[value.name]
        else:
            out[key] = value
    return out


def _substitute_step(step: Dict[str, Any], leaf_inputs: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"via": step["via"], "direction": step["direction"]}
    if step.get("edgeWhere") is not None:
        out["edgeWhere"] = _substitute(step["edgeWhere"], leaf_inputs)
    if step.get("nodeWhere") is not None:
        out["nodeWhere"] = _substitute(step["nodeWhere"], leaf_inputs)
    return out


def _substitute_spec(spec: Dict[str, Any], leaf_inputs: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "start": {"schema": spec["start"]["schema"], "where": _substitute(spec["start"]["where"], leaf_inputs)},
        "emit": spec["emit"],
    }
    if spec.get("steps") is not None:
        out["steps"] = [_substitute_step(s, leaf_inputs) for s in spec["steps"]]
    if spec.get("repeat") is not None:
        out["repeat"] = _substitute_step(spec["repeat"], leaf_inputs)
    if spec.get("depth") is not None:
        out["depth"] = spec["depth"]
    if spec.get("where") is not None:
        out["where"] = _substitute(spec["where"], leaf_inputs)
    return out


def _options_from(leaf_options: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    skip = leaf_options.get("skip")
    limit = leaf_options.get("limit")
    sort = leaf_options.get("sort")
    if skip is None and limit is None and sort is None:
        return None
    options: Dict[str, Any] = {}
    if skip is not None:
        options["skip"] = skip
    if limit is not None:
        options["limit"] = limit
    if sort is not None:
        options["sort"] = sort
    return options


def _build_operation(leaf: _Leaf, leaf_options: Dict[str, Any], leaf_inputs: Dict[str, Any]) -> KeymaOperation:
    if leaf.op == "call":
        return {
            "op": "call",
            "service": leaf.service,
            "method": leaf.method,
            "args": _substitute(leaf.args or {}, leaf_inputs),
        }

    schema_name = leaf.schema_class.schema["name"]

    if leaf.op == "list":
        op: Dict[str, Any] = {"op": "list", "schema": schema_name}
        if leaf.where is not None:
            op["where"] = _substitute(leaf.where, leaf_inputs)
        if leaf.project is not None:
            op["project"] = leaf.project
        options = _options_from(leaf_options)
        if options is not None:
            op["options"] = options
        return op

    if leaf.op == "read":
        op = {"op": "read", "schema": schema_name, "where": _substitute(leaf.where or {}, leaf_inputs)}
        if leaf.project is not None:
            op["project"] = leaf.project
        return op

    if leaf.op == "create":
        op = {"op": "create", "schema": schema_name, "data": _substitute(leaf.data or {}, leaf_inputs)}
        if leaf.project is not None:
            op["project"] = leaf.project
        return op

    if leaf.op == "update":
        op = {
            "op": "update",
            "schema": schema_name,
            "where": _substitute(leaf.where or {}, leaf_inputs),
            "data": _substitute(leaf.data or {}, leaf_inputs),
        }
        if leaf.project is not None:
            op["project"] = leaf.project
        return op

    if leaf.op == "delete":
        return {"op": "delete", "schema": schema_name, "where": _substitute(leaf.where or {}, leaf_inputs)}

    if leaf.op == "traverse":
        spec = _substitute_spec(leaf.spec, leaf_inputs)
        options = _options_from(leaf_options)
        if options is not None:
            spec["options"] = options
        op = {"op": "traverse", "schema": schema_name, "spec": spec}
        if leaf.project is not None:
            op["project"] = leaf.project
        return op

    if leaf.op == "count":
        op = {"op": "count", "schema": schema_name}
        if leaf.where is not None:
            op["where"] = _substitute(leaf.where, leaf_inputs)
        return op

    raise ValueError(f"Unknown leaf op: {leaf.op}")


# ── Hydration ────────────────────────────────────────────────────────────────


def _hydrate(leaf: _Leaf, result: KeymaLeafResult) -> KeymaLeafResult:
    if not result.get("ok"):
        return result
    if leaf.op in ("delete", "count"):
        return result
    data = result.get("data")
    if data is None:
        return result
    if leaf.op == "call":
        if leaf.return_class is None:
            return result
        cls = leaf.return_class
        schema = cls.schema
        if leaf.return_array:
            if not isinstance(data, list):
                return result
            return {"ok": True, "data": [cls(deserialize(schema, r)) if isinstance(r, dict) else r for r in data]}
        if not isinstance(data, dict):
            return result
        return {"ok": True, "data": cls(deserialize(schema, data))}
    if leaf.schema_class is None:
        return result
    cls = leaf.schema_class
    schema = cls.schema
    if leaf.op in ("list", "traverse"):
        if not isinstance(data, list):
            return result
        return {"ok": True, "data": [cls(deserialize(schema, r)) if isinstance(r, dict) else r for r in data]}
    if not isinstance(data, dict):
        return result
    return {"ok": True, "data": cls(deserialize(schema, data))}


# ── Document ─────────────────────────────────────────────────────────────────


class _Document:
    """A query/mutation document. ``request`` substitutes inputs, dispatches the
    batch through a transport, and hydrates each leaf's result."""

    __slots__ = ("_template",)

    def __init__(self, template: Dict[str, _Leaf]) -> None:
        self._template = template

    @property
    def inputs(self) -> Dict[str, Any]:
        # Phantom in the TS type system; provided here for parity.
        return {}

    async def request(
        self,
        options: Optional[Dict[str, Any]] = None,
        opts: Optional[Dict[str, Any]] = None,
        *,
        inputs: Optional[Dict[str, Any]] = None,
        transport: Optional[Transport] = None,
    ) -> Dict[str, Any]:
        # Accept both `request(options, {"inputs":..,"transport":..})` (mirroring JS)
        # and the Pythonic `request(options, inputs=.., transport=..)`.
        if opts is not None:
            if inputs is None:
                inputs = opts.get("inputs")
            if transport is None:
                transport = opts.get("transport")
        options = options or {}
        inputs = inputs or {}
        if transport is None:
            raise TypeError("request() requires a transport")

        operations: Dict[str, KeymaOperation] = {}
        for key in self._template:
            leaf = self._template[key]
            leaf_options = options.get(key) or {}
            leaf_inputs = inputs.get(key) or {}
            operations[key] = _build_operation(leaf, leaf_options, leaf_inputs)

        response = await transport({"operations": operations})
        hydrated: Dict[str, KeymaLeafResult] = {}
        for key, result in response["results"].items():
            leaf = self._template.get(key)
            hydrated[key] = result if leaf is None else _hydrate(leaf, result)
        return {"results": hydrated}


def _make_document(template: Dict[str, _Leaf]) -> _Document:
    return _Document(template)


class Keyma:
    """Namespace of query-builder entry points (mirrors the JS ``Keyma`` const)."""

    query = staticmethod(_make_document)
    mutation = staticmethod(_make_document)
    list = staticmethod(_list)
    read = staticmethod(_read)
    create = staticmethod(_create)
    update = staticmethod(_update)
    delete = staticmethod(_delete)
    traverse = staticmethod(_traverse)
    count = staticmethod(_count)
    call = staticmethod(_call)
    input = staticmethod(_input)
