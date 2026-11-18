"""Code reader (E08.F2.S1): business rules hidden in database code and automation settings.

Static analysis of procedures, triggers, functions and views (and the adapter's automation objects, such as
external programs). Each rule has a kind, a plain-language statement, a confidence, the code excerpt with
line numbers, and the fields it reads or sets, resolved to table.column through the statement's aliases
(a trigger's `inserted` and `deleted` rows resolve to the trigger's table).

Confidence reflects how explicit the code is:
  validation   0.90  a condition that rejects the change with an error
  derivation   0.75  a value the code sets from other values
  calculation  0.70  a function that computes a value
  automation   0.80  an external program or job started by an event
  audit        0.60  a side effect that records history
  interface    0.50  code that reaches another system (dynamic SQL, linked servers)

Screens are linked when the adapter supplies screen metadata; estates without it report that gap.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp

from astra_migrate.adapters.source import MetadataObject

CONFIDENCE = {"validation": 0.9, "derivation": 0.75, "calculation": 0.7, "automation": 0.8, "audit": 0.6,
              "interface": 0.5}
_VALIDATION = re.compile(
    r"\bIF\s+(?P<cond>.+?)\s+(?:BEGIN\s+)?(?:RAISERROR\s*\(\s*N?'(?P<msg>(?:[^']|'')*)'|THROW\s+\d+\s*,\s*N?'(?P<msg2>(?:[^']|'')*)')",
    re.IGNORECASE | re.DOTALL)
_UPDATE = re.compile(r"\bUPDATE\b.+?(?=;|\n\s*(?:END|GO)\b|\Z)", re.IGNORECASE | re.DOTALL)
_INSERT = re.compile(r"\bINSERT\s+INTO\s+(?P<t>[\[\]\w.]+).+?(?=;|\n\s*(?:END|GO)\b|\Z)", re.IGNORECASE | re.DOTALL)
_DYNAMIC = re.compile(r"\b(sp_executesql|EXEC\s*\(\s*@)", re.IGNORECASE)
_RETURN = re.compile(r"\bRETURN\s*\((?P<expr>.+?)\)\s*(?:;|\n\s*END\b)", re.IGNORECASE | re.DOTALL)
_AUDITISH = re.compile(r"audit|history|log", re.IGNORECASE)


@dataclass
class Rule:
    id: str
    object: str
    object_type: str
    kind: str
    statement: str
    confidence: float
    excerpt: str
    line_from: int
    line_to: int
    reads: list[str] = field(default_factory=list)
    sets: list[str] = field(default_factory=list)

    @property
    def fields(self) -> list[str]:
        return sorted(set(self.reads) | set(self.sets))


def _lines(text: str, start: int, end: int) -> tuple[int, int, str]:
    a = text.count("\n", 0, start) + 1
    b = text.count("\n", 0, end) + 1
    rows = text.splitlines()[a - 1:b]
    return a, b, "\n".join(f"{a + i:>4}  {r}" for i, r in enumerate(rows))


def _clean(name: str) -> str:
    return ".".join(p.strip("[]\"") for p in name.split("."))


def _columns(sql: str, own_table: str | None) -> tuple[list[str], list[str]]:
    """(columns read, columns set) as table.column, via the statement's aliases."""
    try:
        tree = sqlglot.parse_one(sql, read="tsql")
    except (sqlglot.errors.ParseError, sqlglot.errors.TokenError):
        return [], []
    if tree is None:
        return [], []
    aliases: dict[str, str] = {}
    tables: list[str] = []
    for t in tree.find_all(exp.Table):
        if not t.name:
            continue
        name = ".".join(p for p in (t.db or "dbo", t.name))
        if t.name.lower() in ("inserted", "deleted") and own_table:
            name = own_table
        tables.append(name)
        aliases[(t.alias or t.name).lower()] = name
    uniq = sorted(set(tables))

    def resolve(c: exp.Column) -> str | None:
        if c.table:
            base = aliases.get(c.table.lower())
            return f"{base}.{c.name}" if base else None
        return f"{uniq[0]}.{c.name}" if len(uniq) == 1 else None

    sets: set[str] = set()
    if isinstance(tree, exp.Update):
        target = tree.this
        tname = aliases.get((target.alias_or_name if isinstance(target, exp.Table) else "").lower())
        for eq in tree.expressions:
            if isinstance(eq, exp.EQ) and isinstance(eq.this, exp.Column):
                col = eq.this
                base = aliases.get(col.table.lower()) if col.table else tname
                if base:
                    sets.add(f"{base}.{col.name}")
    reads = set()
    for c in tree.find_all(exp.Column):
        if not c.name:
            continue
        r = resolve(c)
        if r and r not in sets:
            reads.add(r)
    return sorted(reads), sorted(sets)


def _trigger_table(o: MetadataObject) -> str | None:
    on = o.detail.get("on_table")
    return f"{o.schema}.{on}" if on else None


def _rule_id(obj: str, kind: str, start: int) -> str:
    return "R-" + hashlib.sha256(f"{obj}|{kind}|{start}".encode()).hexdigest()[:10]


def read_object(o: MetadataObject) -> list[Rule]:
    text = o.definition or ""
    if not text:
        return []
    own = _trigger_table(o) if o.type == "trigger" else None
    rules: list[Rule] = []
    taken: list[tuple[int, int]] = []
    for m in _VALIDATION.finditer(text):
        cond = re.sub(r"\s+", " ", m.group("cond")).strip()
        msg = (m.group("msg") or m.group("msg2") or "").replace("''", "'")
        inner = re.match(r"EXISTS\s*\((.*)\)\s*$", cond, re.IGNORECASE | re.DOTALL)
        probe = inner.group(1) if inner else f"SELECT 1 FROM {own or 'dbo.x'} WHERE {cond}"
        reads, _ = _columns(probe, own)
        a, b, ex = _lines(text, m.start(), m.end())
        taken.append((m.start(), m.end()))
        rules.append(Rule(_rule_id(o.qualified, "validation", m.start()), o.qualified, o.type, "validation",
                          f"Rejects the change when {cond}" + (f": \"{msg}\"" if msg else ""),
                          CONFIDENCE["validation"], ex, a, b, reads, []))
    for m in _UPDATE.finditer(text):
        if any(s <= m.start() < e for s, e in taken):
            continue
        stmt = m.group(0)
        reads, sets = _columns(stmt, own)
        if not sets:
            continue
        a, b, ex = _lines(text, m.start(), m.end())
        rules.append(Rule(_rule_id(o.qualified, "derivation", m.start()), o.qualified, o.type, "derivation",
                          f"Sets {', '.join(sets)} from "
                          f"{', '.join(r for r in reads if r not in sets) or 'other values'}",
                          CONFIDENCE["derivation"], ex, a, b, [r for r in reads if r not in sets], sets))
    for m in _INSERT.finditer(text):
        target = _clean(m.group("t"))
        if "." in target and target.count(".") >= 3:
            continue  # linked-server write: an interface, reported by the interface finder
        if not _AUDITISH.search(target):
            continue
        a, b, ex = _lines(text, m.start(), m.end())
        rules.append(Rule(_rule_id(o.qualified, "audit", m.start()), o.qualified, o.type, "audit",
                          f"Records history in {target if '.' in target else 'dbo.' + target}",
                          CONFIDENCE["audit"], ex, a, b, [], []))
    for m in _DYNAMIC.finditer(text):
        a, b, ex = _lines(text, m.start(), m.end())
        rules.append(Rule(_rule_id(o.qualified, "interface", m.start()), o.qualified, o.type, "interface",
                          "Builds and runs SQL at run time; what it touches is visible only in the code text",
                          CONFIDENCE["interface"], ex, a, b, [], []))
    if o.type == "function":
        for m in _RETURN.finditer(text):
            reads, _ = _columns(m.group("expr"), own)
            a, b, ex = _lines(text, m.start(), m.end())
            rules.append(Rule(_rule_id(o.qualified, "calculation", m.start()), o.qualified, o.type, "calculation",
                              f"Calculates a value from {', '.join(reads) or 'its inputs'}",
                              CONFIDENCE["calculation"], ex, a, b, reads, []))
    return rules


def read_automation(o: MetadataObject) -> Rule:
    cmd = str(o.detail.get("command_line") or "")
    event = str(o.detail.get("trigger_event") or "an event")
    return Rule(_rule_id(o.qualified, "automation", 0), o.qualified, o.type, "automation",
                f"Runs '{cmd or o.name}' when {event} happens", CONFIDENCE["automation"],
                f"{o.type}: {o.name}\ncommand: {cmd}\nevent: {event}", 0, 0, [], [])


def read_all(objects: list[MetadataObject], automation_types: set[str]) -> list[Rule]:
    rules: list[Rule] = []
    for o in objects:
        if o.type in automation_types:
            rules.append(read_automation(o))
        elif o.definition:
            rules.extend(read_object(o))
    return rules
