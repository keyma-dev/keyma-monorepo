"""Port of ``@keyma/runtime-js`` ``test/format.test.ts``.

Group: format — direct-ref formatters
"""

from typing import Any, Dict

from keyma.runtime import format


def schema_with_formatter(field_name: str, phase: str, fn) -> Dict[str, Any]:
    return {
        "name": "test",
        "sourceName": "Test",
        "fields": [
            {
                "name": field_name,
                "type": {"kind": "string"},
                "required": False,
                "formatters": [{"phase": phase, "fn": fn}],
            }
        ],
    }


def reverse(v):
    return v[::-1] if isinstance(v, str) else v


def lower(v):
    return v.lower() if isinstance(v, str) else v


def upper(v):
    return v.upper() if isinstance(v, str) else v


async def test_runs_a_formatter_attached_directly_to_the_field_metadata():
    s = schema_with_formatter("v", "save", reverse)
    value: Dict[str, Any] = {"v": "abc"}
    await format(s, value, "save")
    assert value["v"] == "cba"


async def test_fields_without_formatters_are_no_ops():
    s: Dict[str, Any] = {
        "name": "t",
        "sourceName": "T",
        "fields": [{"name": "v", "type": {"kind": "string"}, "required": False}],
    }
    value: Dict[str, Any] = {"v": "  hi  "}
    await format(s, value, "save")
    assert value["v"] == "  hi  "


async def test_phase_filtering_only_applies_formatters_with_matching_phase():
    s: Dict[str, Any] = {
        "name": "t",
        "sourceName": "T",
        "fields": [
            {
                "name": "v",
                "type": {"kind": "string"},
                "required": False,
                "formatters": [
                    {"phase": "save", "fn": lower},
                    {"phase": "change", "fn": upper},
                ],
            }
        ],
    }
    v1: Dict[str, Any] = {"v": "AbC"}
    await format(s, v1, "save")
    assert v1["v"] == "abc"

    v2: Dict[str, Any] = {"v": "AbC"}
    await format(s, v2, "change")
    assert v2["v"] == "ABC"


async def test_a_parameterized_formatter_factory_closes_over_its_params():
    def truncate(max_len: int):
        def _f(v):
            return v[:max_len] if isinstance(v, str) and len(v) > max_len else v

        return _f

    s = schema_with_formatter("v", "save", truncate(3))
    value: Dict[str, Any] = {"v": "abcdef"}
    await format(s, value, "save")
    assert value["v"] == "abc"


async def test_awaits_async_formatters():
    async def async_upper(v):
        return v.upper() if isinstance(v, str) else v

    s = schema_with_formatter("v", "save", async_upper)
    value: Dict[str, Any] = {"v": "ab"}
    await format(s, value, "save")
    assert value["v"] == "AB"
