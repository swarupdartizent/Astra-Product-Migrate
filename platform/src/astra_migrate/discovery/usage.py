"""Usage of legacy elements (E08.F1.S3) and the interfaces that connect to the database (E08.F2.S2).

Usage comes from activity records (login and query logs) over a window, and from the engine's own
statistics where the adapter can read them. Use also flows through code: a used view uses what it reads,
an executed procedure uses what it touches, and a written table fires its triggers. An element with no
direct or indirect use in the window is flagged for retirement review, never retired automatically.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from astra_migrate.adapters.source import MetadataObject
from astra_migrate.discovery.activity import Event

DEFAULT_WINDOW_DAYS = 90
REPORT_TOOLS = re.compile(r"power\s*bi|excel|crystal|ssrs|report|tableau|qlik|looker|cognos|business\s*objects",
                          re.IGNORECASE)


@dataclass
class ElementUsage:
    element: str  # schema.name
    kind: str
    reads: int = 0
    writes: int = 0
    executions: int = 0
    last_used: datetime | None = None
    via: list[str] = field(default_factory=list)  # indirect use through these elements

    @property
    def direct(self) -> int:
        return self.reads + self.writes + self.executions


@dataclass
class UsageResult:
    window_start: datetime | None
    window_end: datetime | None
    evidence_days: int
    elements: dict[str, ElementUsage]
    unused: list[str]
    note: str | None = None


def _key(name: str) -> str:
    return name.lower()


def measure(events: list[Event], objects: list[MetadataObject], tables: list[str], as_of: datetime,
            window_days: int = DEFAULT_WINDOW_DAYS) -> UsageResult:
    start = as_of - timedelta(days=window_days)
    inside = [e for e in events if start <= e.ts.replace(tzinfo=None) <= as_of.replace(tzinfo=None)]
    elements: dict[str, ElementUsage] = {}
    for t in tables:
        elements[_key(t)] = ElementUsage(t, "table")
    code_types = {"view", "procedure", "function", "trigger"}
    for o in objects:
        if o.type in code_types or o.type == "user_defined_table":
            elements.setdefault(_key(o.qualified), ElementUsage(o.qualified, o.type))
    for e in inside:
        for name, attr in [(n, "reads") for n in e.reads] + [(n, "writes") for n in e.writes] + \
                          [(n, "executions") for n in e.executes]:
            u = elements.get(_key(name))
            if u is None:
                continue
            setattr(u, attr, getattr(u, attr) + 1)
            if u.last_used is None or e.ts > u.last_used:
                u.last_used = e.ts
    # Indirect use: through code dependencies and triggers on written tables.
    deps = {_key(o.qualified): [_key(d) for d in o.depends_on] for o in objects}
    triggers: dict[str, list[str]] = defaultdict(list)
    for o in objects:
        if o.type == "trigger" and o.detail.get("on_table"):
            triggers[_key(f"{o.schema}.{o.detail['on_table']}")].append(_key(o.qualified))
    used = {k for k, u in elements.items() if u.direct}
    frontier = list(used)
    while frontier:
        k = frontier.pop()
        src = elements[k]
        nxt = list(deps.get(k, []))
        if src.writes:
            nxt += triggers.get(k, [])  # writing a table fires its triggers
        for k2 in nxt:
            u2 = elements.get(k2)
            if u2 is None:
                continue
            if src.element not in u2.via:
                u2.via.append(src.element)
            if k2 not in used:
                used.add(k2)
                frontier.append(k2)
    unused = sorted(u.element for k, u in elements.items() if k not in used)
    first: datetime | None = None
    last: datetime | None = None
    days = 0
    if inside:
        first, last = min(e.ts for e in inside), max(e.ts for e in inside)
        days = max(1, (last - first).days + 1)
    note = None if days >= window_days else (
        f"Activity evidence covers {days} day(s) of the {window_days}-day window; unused flags are provisional.")
    return UsageResult(first, last, days, elements, unused if inside else [], note)


@dataclass
class Interface:
    key: str
    name: str
    kind: str  # program | report_tool | linked_server | external_program
    source: str  # query_log | login_log | code | configuration | session
    program: str | None
    hosts: list[str]
    logins: list[str]
    events: int
    per_day: float
    first_seen: datetime | None
    last_seen: datetime | None
    reads: list[str]
    writes: list[str]
    executes: list[str]
    evidence: list[str]


def find_interfaces(events: list[Event], product_clients: list[str], exclude_programs: list[str],
                    evidence_days: int) -> list[Interface]:
    """Group activity by program: everything that is not the product's own client or the platform itself
    is an interface."""
    clients = [re.compile(p, re.IGNORECASE) for p in product_clients]
    excluded = {p.lower() for p in exclude_programs}
    groups: dict[str, list[Event]] = defaultdict(list)
    for e in events:
        prog = e.program or "(no program name)"
        if prog.lower() in excluded or any(c.search(prog) for c in clients):
            continue
        groups[prog].append(e)
    out = []
    for prog, evs in sorted(groups.items()):
        reads = sorted({o for e in evs for o in e.reads})
        writes = sorted({o for e in evs for o in e.writes})
        execs = sorted({o for e in evs for o in e.executes})
        sources = {"query_log" if e.statement else "login_log" for e in evs}
        out.append(Interface(
            key=f"program:{prog.lower()}", name=prog, kind="report_tool" if REPORT_TOOLS.search(prog) else "program",
            source="query_log" if "query_log" in sources else "login_log", program=prog,
            hosts=sorted({e.host for e in evs if e.host}), logins=sorted({e.login for e in evs}),
            events=len(evs), per_day=round(len(evs) / max(1, evidence_days), 2),
            first_seen=min(e.ts for e in evs), last_seen=max(e.ts for e in evs),
            reads=reads, writes=writes, executes=execs, evidence=sorted(sources)))
    return out


FOUR_PART = re.compile(r"\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b")


def code_interfaces(objects: list[MetadataObject]) -> list[Interface]:
    """Linked-server references in code: server.database.schema.object."""
    found: dict[str, Interface] = {}
    for o in objects:
        if not o.definition:
            continue
        for m in FOUR_PART.finditer(o.definition):
            server = m.group(1)
            key = f"linked_server:{server.lower()}"
            itf = found.setdefault(key, Interface(key, server, "linked_server", "code", None, [], [], 0, 0.0, None,
                                                  None, [], [], [], []))
            target = ".".join(m.groups())
            write = re.search(r"\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+" + re.escape(target),
                              o.definition, re.IGNORECASE)
            (itf.writes if write else itf.reads).append(target)
            if o.qualified not in itf.evidence:
                itf.evidence.append(o.qualified)
    for itf in found.values():
        itf.reads, itf.writes = sorted(set(itf.reads)), sorted(set(itf.writes))
    return sorted(found.values(), key=lambda i: i.key)


def configured_interfaces(objects: list[MetadataObject], interface_types: set[str]) -> list[Interface]:
    return [Interface(f"{o.type}:{o.name.lower()}", o.name, o.type, "configuration", None, [], [], 0, 0.0, None,
                      None, [], [], [], [f"{o.type}:{o.qualified}"])
            for o in objects if o.type in interface_types]
