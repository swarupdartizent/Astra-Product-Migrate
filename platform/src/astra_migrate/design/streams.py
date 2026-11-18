"""Design proposals for configuration (E12.F2.S1), forms (E12.F2.S2), customer code (E12.F2.S3), integrations and
desktop links (E12.F3.S1, E12.F3.S2), reports (E12.F3.S3), web pages and security profiles (E12.F3.S4).

Everything here follows fixed rules over the harvested source, discovery and the target adapter's design section.
When the target adapter does not record what a stream needs, the stream's items are blocked with the reason.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from astra_migrate.adapters.contract import Mechanism, Naming, Retirement, TargetDesign
from astra_migrate.design.register import Item

PREFERRED = {"inbound": ("rest_api", "integration_vendor", "file_exchange"),
             "read": ("read_query", "rest_api", "integration_vendor"),
             "outbound": ("webhook", "integration_vendor", "file_exchange")}
ACCESS = ("none", "view", "edit", "full")


@dataclass
class Obj:
    type: str
    name: str
    schema: str | None
    detail: dict[str, Any] = field(default_factory=dict)
    definition: str | None = None

    @property
    def qualified(self) -> str:
        return f"{self.schema}.{self.name}" if self.schema else self.name


@dataclass
class Config:
    kind: str
    key: str
    name: str
    scope: str | None
    definition: str
    depends_on: list[str]


@dataclass
class Inputs:
    design: TargetDesign | None
    objects: list[Obj]
    config: list[Config]
    interfaces: list[dict[str, Any]]
    rate_per_minute: int | None
    entities: list[dict[str, Any]]  # name, table, key, attributes, relations
    mappings: list[dict[str, Any]]  # mapping register items (with target)
    code_types: set[str]  # source object types that hold code
    custom_tables: list[str]  # qualified customer tables (user-defined)
    converted: list[dict[str, Any]]  # latest conversion: object_type, name, status
    table_columns: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # table (lower) -> columns


def parse(definition: str | None) -> Any:
    if not definition:
        return None
    try:
        return json.loads(definition)
    except (ValueError, TypeError):
        return definition


def _truthy(v: Any) -> Any:
    if isinstance(v, str) and v.lower() in ("1", "true", "yes", "y"):
        return True
    if isinstance(v, str) and v.lower() in ("0", "false", "no", "n"):
        return False
    if isinstance(v, int) and not isinstance(v, bool) and v in (0, 1):
        return bool(v)
    return v


def matches(when: dict[str, Any], detail: Any) -> bool:
    if not isinstance(detail, dict):
        return not when
    return all(_truthy(detail.get(k)) == _truthy(v) for k, v in when.items())


def retirement(d: TargetDesign | None, object_type: str, name: str, detail: Any) -> Retirement | None:
    for r in (d.retirements if d else []):
        if r.object_type != object_type:
            continue
        if r.name_pattern and not re.search(r.name_pattern, name, re.IGNORECASE):
            continue
        if matches(r.when, detail):
            return r
    return None


def _ref(r: Retirement | Mechanism) -> str:
    return f"{r.source.reference} ({r.confidence})"


def humanize(name: str) -> str:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", re.sub(r"[_\-]+", " ", name)).strip()
    return spaced[:1].upper() + spaced[1:].lower() if spaced else name


def target_name(n: Naming, name: str, kind_prefix: str = "") -> str:
    words = [w for w in re.split(r"[^A-Za-z0-9]+", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)) if w]
    if n.case == "pascal":
        base = "".join(w[:1].upper() + w[1:].lower() for w in words)
    elif n.case == "snake":
        base = "_".join(w.lower() for w in words)
    elif n.case == "upper_snake":
        base = "_".join(w.upper() for w in words)
    else:
        base = re.sub(r"[^A-Za-z0-9_]", "_", name)
    out = f"{n.prefix}{kind_prefix}{base}"
    if not re.match(r"^[A-Za-z_]", out):
        out = f"x_{out}"
    return out[: n.max_length]


# ------------------------------------------------------------------ configuration (E12.F2.S1)

def configuration(inp: Inputs) -> list[Item]:
    d = inp.design
    form_kinds = set(d.forms.source_kinds) if d and d.forms else set()
    areas = {k: a for a in (d.configuration_areas if d else []) for k in a.source_kinds}
    detail_of = {(o.type, o.name.lower()): o.detail for o in inp.objects}
    out = []
    for c in sorted(inp.config, key=lambda c: (c.kind, c.key)):
        if c.kind in form_kinds:
            continue
        key = f"{c.kind}:{c.key}".lower()
        payload = parse(c.definition)
        src = {"kind": c.kind, "key": c.key, "name": c.name, "scope": c.scope, "depends_on": c.depends_on,
               "definition": payload}
        r = retirement(d, c.kind, c.name, detail_of.get((c.kind, c.name.lower()), payload))
        if r:
            out.append(Item("configuration", key, "in_review", src, {"retire": True, "replacement": r.replacement},
                            [f"the target retires this {c.kind}: {r.replacement}", f"source: {_ref(r)}"], None,
                            ["retired in the target: a replacement is proposed"], {},
                            {"title": f"Retire {c.kind} {c.name}"[:300],
                             "question": f"The target does not support this {c.kind}. Proposed replacement: "
                                         f"{r.replacement}",
                             "options": ["Approve retirement with the proposed replacement",
                                         "Rebuild it in the target instead"],
                             "owner_role": "solution_architect", "risk": "high", "segment": c.kind}))
            continue
        a = areas.get(c.kind)
        if a is None:
            why = ("The target adapter has no design section." if d is None else
                   f"The target adapter records no configuration area for '{c.kind}'.")
            out.append(Item("configuration", key, "blocked", src, None, [why], None, [why]))
            continue
        target = {"area": a.key, "label": a.label, "method": a.method, "key": f"{a.key}:{c.key}",
                  "definition": payload,
                  "depends_on": [f"{areas[dep.split(':', 1)[0]].key}:{dep.split(':', 1)[1]}"
                                 if dep.split(':', 1)[0] in areas and ":" in dep else dep for dep in c.depends_on]}
        ev = [f"{c.kind} is rebuilt in the target's {a.label} ({a.method})"]
        if a.notes:
            ev.append(a.notes)
        flags = ["applying it to the target needs the target's configuration API or import (with loads)"] \
            if a.method != "manual" else ["rebuilt by hand in the target from this specification"]
        out.append(Item("configuration", key, "proposed", src, target, ev, 1.0, flags))
    return out


# ------------------------------------------------------------------ forms (E12.F2.S2)

def forms(inp: Inputs) -> list[Item]:
    d = inp.design
    if not d or not d.forms:
        return []
    out = []
    for c in sorted(inp.config, key=lambda c: c.key):
        if c.kind not in d.forms.source_kinds:
            continue
        payload = parse(c.definition)
        already = bool(d.forms.already_when) and matches(d.forms.already_when, payload)
        src = {"kind": c.kind, "key": c.key, "name": c.name, "scope": c.scope, "definition": payload}
        ev = [f"the target's forms are {d.forms.format.upper()}-only ({d.forms.source.reference}, "
              f"{d.forms.confidence})",
              "already in the target format: carried over" if already else "needs conversion to the target format"]
        out.append(Item("form", f"form:{c.key}".lower(), "proposed", src,
                        {"format": d.forms.format, "conversion": "carry_over" if already else "convert"}, ev, None,
                        ["parity against the approved golden copy is required before approval"]))
    return out


# ------------------------------------------------------------------ customer code (E12.F2.S3)

def code(inp: Inputs) -> list[Item]:
    n = inp.design.naming if inp.design else None
    out = []
    objs = [("user_defined_table", t, None) for t in inp.custom_tables]
    objs += [(c["object_type"], c["name"], c["status"]) for c in inp.converted]
    for otype, qualified, conv_status in sorted(objs):
        name = qualified.split(".", 1)[-1]
        key = f"{otype}:{qualified}".lower()
        src: dict[str, Any] = {"type": otype, "name": qualified, "conversion": conv_status}
        if otype == "user_defined_table":
            src["columns"] = inp.table_columns.get(qualified.lower(), [])
        if n is None:
            why = "The target adapter records no naming and ownership rules for customer objects."
            out.append(Item("code", key, "blocked", src, None, [why], None, [why]))
            continue
        tn = target_name(n, name)
        ev = [f"named by the target's rules: schema {n.schema_}, prefix '{n.prefix}', {n.case} case "
              f"({n.source.reference}, {n.confidence})"]
        flags = []
        if otype == "user_defined_table":
            flags.append("declare the table's key: the source does not report it, and the rebuilt table needs one")
        if conv_status and conv_status != "compiled":
            flags.append(f"the dialect conversion is '{conv_status}'; it must compile before the code is rebuilt")
        out.append(Item("code", key, "proposed", src, {"schema": n.schema_, "name": tn,
                                                       "qualified": f"{n.schema_}.{tn}"}, ev, None, flags))
    return out


# ------------------------------------------------------------------ integrations and desktop links (E12.F3.S1/S2)

def direction(i: dict[str, Any]) -> str:
    if i.get("kind") == "linked_server" or i.get("source") == "configuration":
        return "outbound"
    if i.get("writes") or i.get("executes"):
        return "inbound"
    return "read"


def choose(d: TargetDesign | None, need: str) -> Mechanism | None:
    ms = [m for m in (d.mechanisms if d else []) if need in m.directions]
    order = PREFERRED[need]
    return min(ms, key=lambda m: order.index(m.kind) if m.kind in order else 99) if ms else None


def integrations(inp: Inputs) -> list[Item]:
    d = inp.design
    detail_of = {(o.type, o.name.lower()): o.detail for o in inp.objects}
    out = []
    for i in sorted(inp.interfaces, key=lambda x: x["key"]):
        if i.get("kind") == "report_tool":
            continue  # reporting tools read through the report access mechanism; see reports
        key = f"interface:{i['key']}".lower()
        need = direction(i)
        src = {k: i.get(k) for k in ("key", "name", "kind", "source", "program", "hosts", "per_day", "reads",
                                     "writes", "executes", "evidence")}
        src["direction"] = need
        detail = detail_of.get((str(i.get("kind")), str(i.get("name", "")).lower()), {})
        r = retirement(d, str(i.get("kind")), str(i.get("name", "")), detail)
        m = choose(d, "outbound" if r else need)
        if r:
            target = {"retire": True, "replacement": r.replacement,
                      "mechanism": m.key if m else None, "mechanism_kind": m.kind if m else None}
            out.append(Item("integration", key, "in_review", src, target,
                            [f"desktop-only link: {r.replacement}", f"source: {_ref(r)}"], None,
                            ["needs a target design or an approved retirement"], {"desktop": True},
                            {"title": f"Desktop link {i.get('name')}: replace or retire"[:300],
                             "question": f"This {i.get('kind')} only works on the desktop. Proposed: "
                                         f"{r.replacement}" + (f" (through {m.label})" if m else ""),
                             "options": ["Approve retirement", "Design a browser replacement"],
                             "owner_role": "solution_architect", "risk": "high", "segment": str(i.get("kind"))}))
            continue
        if m is None:
            why = ("The target adapter has no design section." if d is None else
                   f"The target adapter records no approved mechanism for {need} integrations.")
            out.append(Item("integration", key, "blocked", src, None, [why], None, [why]))
            continue
        ev = [f"{need} integration: {m.label} ({_ref(m)})"]
        flags = ["needs an end-to-end test definition"]
        per_day = float(i.get("per_day") or 0)
        if inp.rate_per_minute and per_day > inp.rate_per_minute * 1440 * 0.5:
            flags.append(f"about {per_day:.0f} calls a day would use over half the target's rate limit "
                         f"({inp.rate_per_minute}/min)")
        touches = sorted({*map(str, i.get("reads") or []), *map(str, i.get("writes") or [])})
        mapped = {str(mp["source"]["table"]).lower(): (mp.get("target") or {}).get("table")
                  for mp in inp.mappings if mp.get("target")}
        target = {"mechanism": m.key, "mechanism_kind": m.kind, "label": m.label,
                  "touches": [{"source": t, "target": mapped.get(t.lower())} for t in touches]}
        if m.notes:
            ev.append(m.notes)
        out.append(Item("integration", key, "proposed", src, target, ev, None, flags, {"desktop": False}))
    return out


# ------------------------------------------------------------------ reports (E12.F3.S3)

def reports(inp: Inputs) -> list[Item]:
    d = inp.design
    out = []
    for o in sorted((o for o in inp.objects if o.type == "view"), key=lambda o: o.qualified):
        key = f"report:{o.qualified}".lower()
        src = {"type": o.type, "name": o.qualified}
        if not d or not d.report_access or not d.naming:
            why = ("The target adapter records no report access mechanism and naming rules." if d else
                   "The target adapter has no design section.")
            out.append(Item("report", key, "blocked", src, None, [why], None, [why]))
            continue
        m = next(m for m in d.mechanisms if m.key == d.report_access)
        tn = target_name(d.naming, o.name, "rpt_")
        out.append(Item("report", key, "proposed", src,
                        {"mechanism": m.key, "label": m.label, "schema": d.naming.schema_, "name": tn,
                         "qualified": f"{d.naming.schema_}.{tn}"},
                        [f"rebuilt as a read-only procedure on {m.label} ({_ref(m)})"], None,
                        ["report parity is checked with validation (I10)"]))
    return out


# ------------------------------------------------------------------ pages and security (E12.F3.S4)

def pages(inp: Inputs) -> list[Item]:
    d = inp.design
    if not d or not d.pages:
        return []
    by_table: dict[str, list[dict[str, Any]]] = {}
    for mp in inp.mappings:
        if mp.get("target") and mp.get("status") != "rejected":
            by_table.setdefault(str(mp["source"]["table"]).lower(), []).append(mp)
    out = []
    for e in sorted(inp.entities, key=lambda e: e["name"]):
        maps = sorted(by_table.get(str(e["table"]).lower(), []), key=lambda m: m["source"].get("ordinal") or 0)
        if not maps:
            continue
        keys = {k.lower() for k in e.get("key") or []}
        fields = [{"label": humanize(str(m["target"]["column"])), "target": f"{m['target']['table']}."
                   f"{m['target']['column']}", "type": m["target"].get("type"),
                   "required": m["target"].get("nullable") is False, "source": m["source"]["column"],
                   "decided": m.get("status") == "approved"} for m in maps]
        sections = [{"label": "Key", "fields": [f for f in fields if f["source"].lower() in keys]},
                    {"label": "Details", "fields": [f for f in fields if f["source"].lower() not in keys]}]
        rel = [{"label": humanize(r), "entity": v.get("entity")} for r, v in (e.get("relations") or {}).items()]
        if rel:
            sections.append({"label": "Related", "links": rel})
        undecided = sum(1 for f in fields if not f["decided"])
        out.append(Item("page", f"page:{e['name']}".lower(), "proposed", {"entity": e["name"], "table": e["table"]},
                        {"builder": d.pages.name, "title": humanize(str(e["name"])), "sections": sections},
                        [f"drafted from the entity's mappings for {d.pages.name}; no legacy screen layout metadata "
                         "was available, so fields follow the source column order"], None,
                        ["needs designer approval"]
                        + ([f"{undecided} field mapping(s) are not approved yet"] if undecided else [])))
    return out


def security(inp: Inputs, new_objects: list[str], previous: dict[str, dict[str, Any]]) -> list[Item]:
    """One item per source security profile, listing every new object with the access a person gives it.
    The item is complete when every new object has an explicit entry (none counts)."""
    out = []
    profiles = [o for o in inp.objects if o.type == "security_profile"]
    for p in sorted(profiles, key=lambda p: p.name.lower()):
        key = f"profile:{p.name}".lower()
        old = (previous.get(key) or {}).get("entries") or {}
        entries = {o: old.get(o) for o in new_objects}
        missing = [o for o, a in entries.items() if a is None]
        out.append(Item("security", key, "proposed", {"profile": p.name, "rights": p.detail.get("detail")},
                        {"profile": p.name}, [f"{len(new_objects)} new object(s) need an access decision"], None,
                        [f"{len(missing)} object(s) have no access decision"] if missing else [],
                        {"entries": entries, "missing": missing}))
    return out
