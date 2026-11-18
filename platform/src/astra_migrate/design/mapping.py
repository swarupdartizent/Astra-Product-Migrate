"""Mapping proposals (E12.F1.S1): every in-scope source column gets a proposed target column with its evidence,
precedents and a confidence score. Items below the review threshold go to expert review.

Confidence = 0.55 x name + 0.25 x type + 0.20 x table, then +0.15 when a precedent in this tenant chose the same
target, -0.15 when one chose another, and -0.10 when the runner-up is within 0.05 (ambiguous). Each part is listed
as evidence, so the score is never a black box.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from astra_migrate.design.register import Item

DEFAULT_THRESHOLD = 0.8
MIN_CANDIDATE = 0.45

FAMILIES = {
    "numeric": ("int", "bigint", "smallint", "tinyint", "integer", "numeric", "decimal", "money", "smallmoney",
                "float", "real", "double", "unsigned"),
    "string": ("char", "varchar", "nchar", "nvarchar", "text", "ntext", "long varchar", "long nvarchar", "xml",
               "sysname"),
    "date": ("date", "datetime", "datetime2", "smalldatetime", "time", "datetimeoffset", "timestamp"),
    "bool": ("bit", "boolean"),
    "binary": ("binary", "varbinary", "image", "long binary", "rowversion"),
    "guid": ("uniqueidentifier",),
}
CONVERTIBLE = {("numeric", "string"): 0.6, ("date", "string"): 0.5, ("bool", "numeric"): 0.8,
               ("bool", "string"): 0.5, ("guid", "string"): 0.7}


def family(t: str) -> str:
    base = re.sub(r"\(.*\)", "", (t or "").lower()).strip()
    for fam, names in FAMILIES.items():
        if base in names or base.split(" ")[0] in names:
            return fam
    return "other"


def length_of(t: str) -> int | None:
    m = re.search(r"\((\d+|max)\)", (t or "").lower())
    if not m:
        return None
    return -1 if m.group(1) == "max" else int(m.group(1))


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def tokens(name: str) -> set[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", name))
    return {t for t in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if t}


def name_similarity(a: str, b: str) -> float:
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = tokens(a), tokens(b)
    score = 0.9 * len(ta & tb) / len(ta | tb) if ta and tb else 0.0
    if min(len(na), len(nb)) >= 4 and (na.startswith(nb) or nb.startswith(na)):
        score = max(score, 0.75)
    return round(score, 3)


def type_score(src: str, src_len: int | None, tgt: str) -> tuple[float, str | None]:
    fs, ft = family(src), family(tgt)
    if fs == ft:
        tl = length_of(tgt)
        if fs == "string" and src_len and src_len > 0 and tl and tl > 0 and src_len > tl:
            return 0.6, f"source values up to {src_len} characters may not fit the target's {tl}"
        return 1.0, None
    s = CONVERTIBLE.get((fs, ft))
    if s is not None:
        return s, f"converts {fs} to {ft}"
    return 0.0, f"{fs} does not convert to {ft}"


@dataclass
class SourceColumn:
    table: str
    name: str
    data_type: str
    max_length: int | None
    nullable: bool
    ordinal: int


@dataclass
class TargetTable:
    schema: str
    name: str
    columns: list[dict[str, Any]]
    concept: str | None = None

    @property
    def qualified(self) -> str:
        return f"{self.schema}.{self.name}"


@dataclass
class TableMatch:
    target: TargetTable
    score: float
    basis: str


@dataclass
class Inputs:
    columns: list[SourceColumn]
    targets: list[TargetTable]
    delta_tables: dict[str, str] = field(default_factory=dict)  # source table (lower) -> target table name (lower)
    entities: dict[str, dict[str, Any]] = field(default_factory=dict)  # table (lower) -> {concept, attributes}
    precedents: dict[str, list[dict[str, Any]]] = field(default_factory=dict)  # table.column (lower) -> decisions
    in_scope: set[str] | None = None  # source tables (lower); None = all
    threshold: float = DEFAULT_THRESHOLD


def match_table(table: str, inp: Inputs) -> TableMatch | None:
    by_name = {t.name.lower(): t for t in inp.targets}
    by_q = {t.qualified.lower(): t for t in inp.targets}
    short = table.split(".", 1)[-1].lower()
    d = inp.delta_tables.get(table.lower())
    if d and (by_q.get(d) or by_name.get(d.split(".", 1)[-1])):
        tt = by_q.get(d) or by_name[d.split(".", 1)[-1]]
        return TableMatch(tt, 1.0, f"the version delta matched {table} to {tt.qualified}")
    if short in by_name:
        return TableMatch(by_name[short], 0.95, f"same table name in the target baseline ({by_name[short].qualified})")
    concept = (inp.entities.get(table.lower()) or {}).get("concept")
    if concept:
        hit = next((t for t in inp.targets if t.concept == concept), None)
        if hit:
            return TableMatch(hit, 0.9, f"both bound to the concept {concept}")
    best = max(inp.targets, key=lambda t: name_similarity(short, t.name), default=None)
    if best is not None:
        s = name_similarity(short, best.name)
        if s >= 0.5:
            return TableMatch(best, round(s, 3), f"similar table name ({best.qualified}, {s:.2f})")
    return None


def _attribute_for(col: str, ent: dict[str, Any]) -> str | None:
    for attr, column in (ent.get("attributes") or {}).items():
        if str(column).lower() == col.lower():
            return str(attr)
    return None


def _score(c: SourceColumn, tc: dict[str, Any], tm: TableMatch, attr: str | None) -> tuple[float, list[str], list[str]]:
    ev, flags = [], []
    ns = name_similarity(c.name, str(tc["name"]))
    if attr and norm(attr) == norm(str(tc["name"])):
        ns = max(ns, 0.95)
        ev.append(f"the source adapter binds {c.name} to the concept attribute '{attr}'")
    ev.append(f"name similarity {ns:.2f} ({c.name} → {tc['name']})")
    ts, note = type_score(c.data_type, c.max_length, str(tc.get("type", "")))
    ev.append(f"type {c.data_type} → {tc.get('type')}: {ts:.2f}" + (f" ({note})" if note else ""))
    if note and ts < 1.0:
        flags.append(note)
    if c.nullable and tc.get("nullable") is False:
        flags.append("the source allows nulls but the target column is required")
    ev.append(f"table: {tm.basis} ({tm.score:.2f})")
    return round(0.55 * ns + 0.25 * ts + 0.20 * tm.score, 3), ev, flags


def propose(inp: Inputs) -> tuple[list[Item], dict[str, Any]]:
    by_table: dict[str, list[SourceColumn]] = {}
    for c in inp.columns:
        if inp.in_scope is None or c.table.lower() in inp.in_scope:
            by_table.setdefault(c.table, []).append(c)
    out: list[Item] = []
    gaps: list[dict[str, Any]] = []
    for table, cols in sorted(by_table.items()):
        tm = match_table(table, inp)
        ent = inp.entities.get(table.lower()) or {}
        chosen: dict[str, tuple[float, SourceColumn]] = {}
        drafts: dict[str, dict[str, Any]] = {}
        for c in sorted(cols, key=lambda c: c.ordinal):
            cands: list[tuple[float, dict[str, Any], list[str], list[str]]] = []
            if tm:
                attr = _attribute_for(c.name, ent)
                for tc in tm.target.columns:
                    sc, ev, fl = _score(c, tc, tm, attr)
                    if sc >= MIN_CANDIDATE:
                        cands.append((sc, tc, ev, fl))
            cands.sort(key=lambda x: -x[0])
            drafts[c.name] = {"col": c, "cands": cands}
        # one target column per source column: the strongest claim wins, the others take their next candidate
        for _name, d in sorted(drafts.items(), key=lambda kv: -(kv[1]["cands"][0][0] if kv[1]["cands"] else 0)):
            pick = None
            for cand in d["cands"]:
                tcol = str(cand[1]["name"]).lower()
                if tcol not in chosen:
                    pick = cand
                    chosen[tcol] = (cand[0], d["col"])
                    break
                d.setdefault("lost", []).append(f"{cand[1]['name']} was taken by {chosen[tcol][1].name}")
            d["pick"] = pick
        for c in sorted(cols, key=lambda c: c.ordinal):
            d = drafts[c.name]
            key = f"{table}.{c.name}".lower()
            prec = inp.precedents.get(key) or inp.precedents.get(f"*.{c.name}".lower()) or []
            src = {"table": table, "column": c.name, "type": c.data_type, "max_length": c.max_length,
                   "nullable": c.nullable, "ordinal": c.ordinal}
            pick = d["pick"]
            if pick is None:
                ev = [f"no target column scored {MIN_CANDIDATE} or more"
                      + (f" in {tm.target.qualified}" if tm else " (no matching target table)")]
                ev += d.get("lost", [])
                out.append(_item(key, src, None, 0.0, ev, [], prec, table, inp.threshold))
                continue
            conf, tc, ev, flags = pick
            ev = list(ev) + d.get("lost", [])
            agree = [p for p in prec if (p.get("target") or {}).get("column", "").lower() == str(tc["name"]).lower()]
            if prec:
                if agree:
                    conf += 0.15
                    ev.append(f"{len(agree)} earlier decision(s) in this tenant chose the same target")
                else:
                    conf -= 0.15
                    ev.append(f"{len(prec)} earlier decision(s) in this tenant chose a different target")
            runner = next((x for x in d["cands"] if x is not pick), None)
            if runner and pick[0] - runner[0] < 0.05:
                conf -= 0.10
                flags = [*flags, f"ambiguous: {runner[1]['name']} scored {runner[0]:.2f}"]
            assert tm is not None
            target = {"table": tm.target.qualified, "column": str(tc["name"]), "type": tc.get("type"),
                      "nullable": tc.get("nullable")}
            out.append(_item(key, src, target, round(max(0.0, min(1.0, conf)), 2), ev, flags, prec, table,
                             inp.threshold))
        if tm:
            mapped = {k for k in chosen}
            req = [str(tc["name"]) for tc in tm.target.columns
                   if tc.get("nullable") is False and not tc.get("default") and str(tc["name"]).lower() not in mapped]
            if req:
                gaps.append({"source_table": table, "target_table": tm.target.qualified, "required_unmapped": req})
    summary = {"columns": len(out), "in_review": sum(1 for i in out if i.status == "in_review"),
               "no_target": sum(1 for i in out if i.target is None), "required_unmapped": gaps,
               "threshold": inp.threshold}
    return out, summary


def _item(key: str, src: dict[str, Any], target: dict[str, Any] | None, conf: float, ev: list[str],
          flags: list[str], prec: list[dict[str, Any]], table: str, threshold: float) -> Item:
    low = target is None or conf < threshold
    proposal = (f"{src['table']}.{src['column']} → {target['table']}.{target['column']}" if target
                else f"{src['table']}.{src['column']} has no proposed target")
    review = None
    if low:
        review = {"title": f"Mapping: {proposal}"[:300],
                  "question": (f"Confidence {conf:.2f} is below the review threshold {threshold:.2f}. "
                               + ("Accept the proposed mapping, decide the column is not migrated, or change it to "
                                  "another target column (schema.table.column)." if target else
                                  "Decide the column is not migrated, or change it to a target column "
                                  "(schema.table.column).")),
                  "options": (["Accept the proposed mapping"] if target else [])
                  + ["No target: the column is not migrated"],
                  "owner_role": "data_sme", "risk": "high" if target is None else "medium", "confidence": conf,
                  "segment": table}
    return Item("mapping", key, "in_review" if low else "proposed", src, target, ev, conf, flags,
                {"precedents": prec[:10]}, review)
