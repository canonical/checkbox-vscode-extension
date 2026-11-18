#!/usr/bin/env python3
"""
Dump unit ids and references as computed by checkbox-ng (plainbox).

This is the source of truth the TypeScript language server is compared
against (see test/parity.test.ts). It only uses public-ish plainbox APIs so
that any upstream change in parsing or reference semantics shows up as a
parity failure.

Usage: dump_units.py <manage.py> [<manage.py> ...] > units.json
"""

import json
import logging
import os
import sys

from plainbox.impl.providers.embedded_providers import (
    ManagePyProvider1PlugIn,
)
from plainbox.impl.providers import special
from plainbox.impl.resource import ResourceProgram, parse_imports_stmt
from plainbox.impl.secure.plugins import now
from plainbox.impl.secure.providers.v1 import Provider1
from plainbox.impl.session.state import SessionState
from plainbox.impl.unit import all_units, get_array_field_qualify
from plainbox.impl.unit.job import JobDefinition
from plainbox.impl.xparsers import (
    IncludeStmtList,
    ReErr,
    RePattern,
    Visitor,
)

logger = logging.getLogger("dump_units")

LIST_FIELDS = {
    "depends": "depends",
    "after": "after",
    "before": "before",
    "salvages": "salvages",
    "setup_include": "setup_include",
    "bootstrap_include": "bootstrap_include",
    "nested_part": "nested_part",
}
INCLUDE_FIELDS = ("include", "exclude", "mandatory_include")


def _safe(fn):
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - report, don't crash
        return {"error": str(exc)}


def _includes(unit, field):
    value = unit._data.get(field)
    if value is None:
        return []
    if isinstance(value, str):
        parsed = IncludeStmtList.parse(value)
    else:
        parsed = IncludeStmtList.from_preparsed(value)
    result = []

    class V(Visitor):
        def visit_IncludeStmt_node(self, node):
            pattern = node.pattern
            if isinstance(pattern, ReErr):
                kind, target = "error", pattern.text
            elif isinstance(pattern, RePattern):
                kind = "pattern"
                target = unit.qualify_pattern(pattern.text)
            else:
                kind, target = "fixed", unit.qualify_id(pattern.text)
            result.append(
                {"kind": kind, "text": pattern.text, "target": target}
            )

    V().visit(parsed)
    return result


def _data(unit):
    """Field values; jobs of parametric templates render them on access."""
    if not getattr(unit, "is_parametric", False):
        return unit._data
    return {key: unit.get_record_value(key) for key in unit._data}


def _generated_ids(unit):
    """Mirror SessionState._add_job_siblings_unit (siblings + flags)."""
    if unit.unit != "job":
        return []
    ids = []
    siblings = list(unit.siblings or [])
    siblings += SessionState._get_flags_siblings(None, unit)
    for overrides in siblings:
        data = {
            key: value
            for key, value in _data(unit).items()
            if not key.endswith("siblings")
        }
        data.update(overrides)
        sibling = JobDefinition(data, provider=unit.provider)
        ids.append(sibling.id)
        ids.extend(_generated_ids(sibling))
    return sorted(ids)


def dump_unit(unit, root):
    data = _data(unit)
    entry = {
        "file": os.path.relpath(unit.origin.source.filename, root),
        "line": unit.origin.line_start,
        "unit": unit.unit,
        "partial_id": getattr(unit, "partial_id", None),
        "id": getattr(unit, "id", None),
        "plugin": getattr(unit, "plugin", None),
        "refs": {},
    }
    refs = entry["refs"]
    if unit.unit in ("template", "parametric template"):
        entry["template_id"] = unit.template_id
        if data.get("template-resource") is not None:
            refs["template-resource"] = _safe(lambda: [unit.resource_id])
        if data.get("template-imports") is not None:
            refs["template-imports"] = _safe(
                lambda: sorted(
                    job_id for job_id, _ in unit.get_imported_jobs()
                )
            )
        if data.get("template-filter") is not None:
            refs["template-filter"] = _safe(
                lambda: sorted(unit.get_filter_program().required_resources)
            )
    for field, name in LIST_FIELDS.items():
        if data.get(field) is not None:
            refs[field] = _safe(
                lambda: sorted(
                    get_array_field_qualify(
                        data[field], name, unit.qualify_id, logger
                    )
                )
            )
    imports = []
    if data.get("imports") is not None:
        refs["imports"] = _safe(
            lambda: sorted(
                job_id for job_id, _ in parse_imports_stmt(data["imports"])
            )
        )
        imports = _safe(lambda: list(parse_imports_stmt(data["imports"])))
    if data.get("category_id") is not None:
        refs["category_id"] = [unit.qualify_id(data["category_id"])]
    if data.get("requires") is not None and unit.unit in (
        "job",
        "template",
        "setup_job",
    ):
        refs["requires"] = _safe(
            lambda: sorted(
                ResourceProgram(
                    data["requires"], unit.provider.namespace, imports
                ).required_resources
            )
        )
    if unit.unit == "test plan":
        overrides = data.get("category-overrides")
        if overrides is not None:
            refs["category-overrides"] = _safe(
                lambda: sorted(
                    value
                    for _, category_id, pattern in (
                        unit.parse_category_overrides(overrides)
                    )
                    for value in (category_id, pattern)
                )
            )
        for field in INCLUDE_FIELDS:
            if data.get(field) is not None:
                refs[field] = _safe(lambda: _includes(unit, field))
    entry["generated_ids"] = _safe(lambda: _generated_ids(unit))
    return entry


def dump_fields():
    all_units.load()
    fields = {}
    for cls in all_units.get_all_plugin_objects():
        symbols = cls.Meta.fields.get_all_symbols()
        fields[cls.Meta.name] = sorted(str(s) for s in symbols)
    return fields


def _load_provider(manage_py):
    # Built-in plainbox providers only call setup() under __main__, so take
    # their definition from special.py but load the units from manage_py's
    # directory: checkbox-ng may be installed elsewhere (not editable).
    provider_dir = os.path.dirname(os.path.abspath(manage_py))
    parent = os.path.dirname(provider_dir)
    get_def = getattr(
        special, "get_{}_def".format(os.path.basename(provider_dir)), None
    )
    if get_def and parent.endswith(
        os.path.join("plainbox", "impl", "providers")
    ):
        definition = get_def()
        definition.location = provider_dir
        return Provider1.from_definition(definition, secure=False)
    with open(manage_py, encoding="UTF-8") as stream:
        text = stream.read()
    plugin = ManagePyProvider1PlugIn(
        manage_py, text, now(), validate=False, check=False
    )
    return plugin.plugin_object


def main(argv):
    root = os.getcwd()
    providers = []
    for manage_py in argv:
        provider = _load_provider(manage_py)
        units = [
            dump_unit(unit, root)
            for unit in provider.unit_list
            if unit.unit != "file"
        ]
        providers.append(
            {
                "manage_py": os.path.relpath(manage_py, root),
                "namespace": provider.namespace,
                "units": sorted(
                    units, key=lambda u: (u["file"], u["line"] or 0)
                ),
            }
        )
    json.dump(
        {"providers": providers, "fields": dump_fields()},
        sys.stdout,
        indent=1,
        sort_keys=True,
    )


if __name__ == "__main__":
    main(sys.argv[1:])
