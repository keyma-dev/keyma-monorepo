"""Field formatting driver — mirrors ``@keyma/runtime`` ``format.test.ts``.

Drives hand-built metadata dicts: own-only ``fields`` with direct-ref ``formatters`` entries
(``{"phase", "fn"}``), inherited fields via a ``base`` link. Formatters mutate the record in place.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from keyma.runtime import format

Metadata = Dict[str, Any]


def schema_with_formatter(field_name: str, phase: str, fn: Callable[..., Any]) -> Metadata:
    return {
        "name": "test",
        "sourceName": "Test",
        "fields": [
            {"name": field_name, "type": {"kind": "string"}, "required": False, "formatters": [{"phase": phase, "fn": fn}]}
        ],
    }


def reverse(v: Any) -> Any:
    return v[::-1] if isinstance(v, str) else v


def lower(v: Any) -> Any:
    return v.lower() if isinstance(v, str) else v


def upper(v: Any) -> Any:
    return v.upper() if isinstance(v, str) else v


def test_runs_a_directly_attached_formatter():
    s = schema_with_formatter("v", "save", reverse)
    value: Dict[str, Any] = {"v": "abc"}
    format(s, value, "save")
    assert value["v"] == "cba"


def test_fields_without_formatters_are_noops():
    s: Metadata = {"name": "t", "sourceName": "T", "fields": [{"name": "v", "type": {"kind": "string"}, "required": False}]}
    value: Dict[str, Any] = {"v": "  hi  "}
    format(s, value, "save")
    assert value["v"] == "  hi  "


def test_absent_values_are_skipped():
    s = schema_with_formatter("v", "save", upper)
    value: Dict[str, Any] = {}
    format(s, value, "save")
    assert "v" not in value


def test_phase_filtering_only_applies_matching_phase():
    s: Metadata = {
        "name": "t",
        "sourceName": "T",
        "fields": [
            {
                "name": "v",
                "type": {"kind": "string"},
                "required": False,
                "formatters": [{"phase": "save", "fn": lower}, {"phase": "change", "fn": upper}],
            }
        ],
    }
    v1: Dict[str, Any] = {"v": "AbC"}
    format(s, v1, "save")
    assert v1["v"] == "abc"

    v2: Dict[str, Any] = {"v": "AbC"}
    format(s, v2, "change")
    assert v2["v"] == "ABC"


def test_parameterized_formatter_factory_closes_over_its_params():
    def truncate(max_len: int) -> Callable[..., Any]:
        def _f(v: Any) -> Any:
            return v[:max_len] if isinstance(v, str) and len(v) > max_len else v

        return _f

    s = schema_with_formatter("v", "save", truncate(3))
    value: Dict[str, Any] = {"v": "abcdef"}
    format(s, value, "save")
    assert value["v"] == "abc"


def test_formats_inherited_fields_by_walking_the_base_chain():
    base: Metadata = {
        "name": "base",
        "sourceName": "Base",
        "fields": [{"name": "name", "type": {"kind": "string"}, "required": False, "formatters": [{"phase": "save", "fn": upper}]}],
    }
    leaf: Metadata = {
        "name": "leaf",
        "sourceName": "Leaf",
        "base": base,
        "fields": [{"name": "nick", "type": {"kind": "string"}, "required": False, "formatters": [{"phase": "save", "fn": lower}]}],
    }
    value: Dict[str, Any] = {"name": "ab", "nick": "CD"}
    format(leaf, value, "save")
    assert value["name"] == "AB"
    assert value["nick"] == "cd"
