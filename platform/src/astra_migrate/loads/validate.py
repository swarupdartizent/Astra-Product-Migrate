"""Validation of transformed records (E14.F1.S1): structural, reference, semantic and business rules.

Every failure names the rule, the record and a proposed fix in plain language.

- Structural: the target baseline's required columns, string lengths and numeric precision.
- Reference: the source adapter's relations, carried to the target through the approved mappings. A parent must be
  in this load or an earlier one.
- Semantic and business: the domain packs' executable rules (order, within, sum_equals, not_null), with concepts and
  attributes translated to target tables and columns through the source adapter's bindings and the mappings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from astra_migrate.design.mapping import family, length_of
from astra_migrate.rules.checks import NotNullCheck, OrderCheck, SumEqualsCheck, WithinCheck, parse_check


@dataclass
class Failure:
    rule: str
    kind: str  # structural | reference | semantic | business
    severity: str  # blocking | warning
    column: str | None
    message: str
    fix: str

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@dataclass
class Relation:
    child_table: str
    child_column: str
    parent_table: str
    parent_column: str
    name: str


@dataclass
class Rule:
    id: str
    statement: str
    severity: str
    check: Any
    kind: str = "business"


@dataclass
class Context:
    columns: dict[str, dict[str, dict[str, Any]]]  # target table (lower) -> column (lower) -> {name, type, nullable}
    keys: dict[str, list[str]]  # target table (lower) -> key columns
    relations: list[Relation] = field(default_factory=list)
    known_keys: dict[str, set[str]] = field(default_factory=dict)  # target table (lower) -> keys loaded earlier
    # concept -> (target table, {attribute: target column}, {relation: (child column, parent concept)})
    concepts: dict[str, tuple[str, dict[str, str], dict[str, tuple[str, str]]]] = field(default_factory=dict)
    rules: list[Rule] = field(default_factory=list)


def record_key(row: dict[str, Any], key_cols: list[str]) -> str:
    return "|".join("" if row.get(c) is None else str(row.get(c)) for c in key_cols)


def _num(v: Any) -> Decimal | None:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


def _date(v: Any) -> datetime | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v
    if isinstance(v, date):
        return datetime(v.year, v.month, v.day)
    try:
        return datetime.fromisoformat(str(v)[:26])
    except ValueError:
        return None


def structural(table: str, row: dict[str, Any], cols: dict[str, dict[str, Any]]) -> list[Failure]:
    out = []
    for c in cols.values():
        name, t = str(c["name"]), str(c.get("type") or "")
        v = row.get(name)
        if v is None:
            if c.get("nullable") is False:
                out.append(Failure("STRUCT-REQUIRED", "structural", "blocking", name,
                                   f"{name} is required by the target but is empty.",
                                   f"Map a source value to {table}.{name}, or correct the record at source."))
            continue
        n = length_of(t)
        if family(t) == "string" and n and n > 0 and len(str(v)) > n:
            out.append(Failure("STRUCT-LENGTH", "structural", "blocking", name,
                               f"{name} has {len(str(v))} characters; the target allows {n}.",
                               "Shorten the value at source, or agree a mapping rule that abbreviates it."))
        m = re.search(r"\((\d+)\s*,\s*(\d+)\)", t)
        if family(t) == "numeric" and m:
            d = _num(v)
            p, s = int(m.group(1)), int(m.group(2))
            exp = d.normalize().as_tuple().exponent if d is not None else 0
            if d is not None and isinstance(exp, int) and -exp > s:
                out.append(Failure("STRUCT-SCALE", "structural", "blocking", name,
                                   f"{name} = {d} has more than {s} decimal places.",
                                   "Round at source with the finance owner's agreement; the load never rounds."))
            if d is not None and len(str(abs(int(d)))) > p - s:
                out.append(Failure("STRUCT-PRECISION", "structural", "blocking", name,
                                   f"{name} = {d} is too large for {t}.", "Correct the amount at source."))
    return out


def run(ctx: Context, rows: dict[str, list[dict[str, Any]]]) -> dict[tuple[str, str], list[Failure]]:
    """Validate every transformed row. Returns failures by (target table lower, record key)."""
    fails: dict[tuple[str, str], list[Failure]] = {}

    def add(table: str, row: dict[str, Any], f: Failure) -> None:
        fails.setdefault((table, record_key(row, ctx.keys.get(table, []))), []).append(f)

    for table, rs in rows.items():
        cols = ctx.columns.get(table, {})
        for row in rs:
            for f in structural(table, row, cols):
                add(table, row, f)
    # reference
    present = {t: {record_key(r, ctx.keys.get(t, [])) for r in rs} for t, rs in rows.items()}
    for rel in ctx.relations:
        parents = {str(r.get(rel.parent_column)) for r in rows.get(rel.parent_table, []) if r.get(rel.parent_column)
                   is not None} | ctx.known_keys.get(rel.parent_table, set())
        if rel.parent_table in present and ctx.keys.get(rel.parent_table) == [rel.parent_column]:
            parents |= present[rel.parent_table]
        for row in rows.get(rel.child_table, []):
            v = row.get(rel.child_column)
            if v is not None and str(v) not in parents:
                add(rel.child_table, row, Failure(
                    f"REF-{rel.name.upper()}", "reference", "blocking", rel.child_column,
                    f"{rel.child_column} = {v} refers to {rel.parent_table} {v}, which is in neither this load nor an "
                    "earlier one.", f"Load the {rel.parent_table} record first, or correct the reference at source."))
    # semantic and business rules from the domain packs
    for rule in ctx.rules:
        for (table, key), f in _rule(ctx, rule, rows):
            fails.setdefault((table, key), []).append(f)
    return fails


def _rule(ctx: Context, rule: Rule, rows: dict[str, list[dict[str, Any]]]) -> list[tuple[tuple[str, str], Failure]]:
    c = rule.check
    out: list[tuple[tuple[str, str], Failure]] = []
    bound = ctx.concepts.get(c.concept)
    if bound is None:
        return out
    table, attrs, rels = bound

    def f(col: str | None, msg: str, fix: str) -> Failure:
        return Failure(rule.id, rule.kind, rule.severity, col, f"{rule.statement} {msg}", fix)

    def k(t: str, r: dict[str, Any]) -> tuple[str, str]:
        return (t, record_key(r, ctx.keys.get(t, [])))

    if isinstance(c, NotNullCheck):
        col = attrs.get(c.attribute)
        if col is not None:
            for r in rows.get(table, []):
                if r.get(col) is None:
                    out.append((k(table, r), f(col, f"{col} is empty.", f"Fill {col} at source.")))
    elif isinstance(c, OrderCheck):
        a, b = attrs.get(c.first), attrs.get(c.second)
        if a is not None and b is not None:
            for r in rows.get(table, []):
                x, y = _date(r.get(a)) or _num(r.get(a)), _date(r.get(b)) or _num(r.get(b))
                if x is not None and y is not None and (x > y or (x == y and not c.allow_equal)):  # type: ignore[operator]
                    out.append((k(table, r), f(a, f"{a} = {r.get(a)} is after {b} = {r.get(b)}.",
                                               f"Correct {a} or {b} at source; the transformation copies them "
                                               "unchanged.")))
    elif isinstance(c, WithinCheck):
        dcol, rel = attrs.get(c.date), rels.get(c.relation)
        pb = ctx.concepts.get(rel[1]) if rel else None
        if dcol and rel and pb:
            ptable, pattrs, _ = pb
            s, e = pattrs.get(c.start), pattrs.get(c.end)
            pkey = ctx.keys.get(ptable, [])
            parents = {record_key(p, pkey): p for p in rows.get(ptable, [])}
            if s is not None and e is not None and len(pkey) == 1:
                for r in rows.get(table, []):
                    p = parents.get(str(r.get(rel[0])))
                    d = _date(r.get(dcol))
                    lo, hi = (_date(p.get(s)), _date(p.get(e))) if p else (None, None)
                    if d and ((lo and d < lo) or (hi and d > hi)):
                        out.append((k(table, r), f(dcol, f"{dcol} = {r.get(dcol)} is outside {lo} to {hi}.",
                                                   f"Correct {dcol} or the parent's dates at source.")))
    elif isinstance(c, SumEqualsCheck):
        tcol = attrs.get(c.total)
        cb = ctx.concepts.get(c.child_concept)
        if tcol and cb:
            ctable, cattrs, crels = cb
            pcol, rel = cattrs.get(c.part), crels.get(c.child_relation)
            pkey = ctx.keys.get(table, [])
            if pcol and rel and len(pkey) == 1:
                q = Decimal(1).scaleb(-c.scale)
                sums: dict[str, Decimal] = {}
                for ch in rows.get(ctable, []):
                    v = _num(ch.get(pcol))
                    if v is not None:
                        sums[str(ch.get(rel[0]))] = sums.get(str(ch.get(rel[0])), Decimal(0)) + v
                for r in rows.get(table, []):
                    tot = _num(r.get(tcol))
                    key = record_key(r, pkey)
                    if tot is None or key not in sums:
                        continue
                    diff = (tot - sums[key]).quantize(q)
                    if abs(diff) > c.tolerance:
                        out.append((k(table, r), f(tcol, f"{tcol} = {tot} but its {ctable} parts add up to "
                                                         f"{sums[key].quantize(q)} (difference {diff}).",
                                                   "Find the missing or extra part at source; amounts are never "
                                                   "adjusted by the load.")))
    return out


def compile_rules(raw: list[tuple[str, str, str, dict[str, Any], str]]) -> list[Rule]:
    """(id, statement, severity, check, pack type) -> rules; domain packs are semantic, others business."""
    out = []
    for rid, statement, severity, check, ptype in raw:
        try:
            out.append(Rule(rid, statement, severity, parse_check(check),
                            "semantic" if ptype == "domain" else "business"))
        except ValueError:
            continue
    return out
