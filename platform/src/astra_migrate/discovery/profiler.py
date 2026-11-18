"""Data profiling (E08.F1.S2): null rates, distinct counts, value patterns, broken references and a
data quality score per table and per estate.

Only aggregates and value *shapes* are kept (for example `99-9999999`), never the values themselves.

Score per table, 0-100 (the weights are deliberate and shown in every result):
  completeness  1 - mean null rate over columns that are mostly filled (null rate below 50%)    weight 0.4
  validity      share of values matching each text column's dominant shape, where one shape
                covers at least 80% of the sample                                               weight 0.3
  integrity     1 - (rows with a broken reference / rows), over the table's outgoing relations   weight 0.3
A component with nothing to measure counts as 1.0. The estate score is the row-weighted mean.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from astra_migrate.adapters.engines import EngineError, Session
from astra_migrate.discovery.dictionary import Column, DataDictionary, Relation

WEIGHTS = {"completeness": 0.4, "validity": 0.3, "integrity": 0.3}
TEXT_TYPES = {"char", "varchar", "nchar", "nvarchar", "text", "ntext", "long varchar", "long nvarchar"}
NO_DISTINCT = {"text", "ntext", "image", "xml", "varbinary", "binary", "long binary", "long varchar",
               "long nvarchar", "sql_variant", "geography", "geometry", "hierarchyid"}
SAMPLE = 1000


def shape(value: object) -> str:
    """The shape of a value: letters become A, digits 9, other characters stay."""
    s = str(value)
    if len(s) > 40:
        return f"text({len(s) // 10 * 10}+)"
    return re.sub(r"[0-9]", "9", re.sub(r"[A-Za-z]", "A", s))


@dataclass
class ColumnProfile:
    column: str
    data_type: str
    rows: int
    nulls: int
    distinct: int | None
    patterns: list[dict[str, object]]  # [{"shape": "99-9999999", "share": 0.97}]

    @property
    def null_rate(self) -> float:
        return self.nulls / self.rows if self.rows else 0.0

    @property
    def dominant_share(self) -> float | None:
        return float(self.patterns[0]["share"]) if self.patterns else None  # type: ignore[arg-type]


@dataclass
class BrokenReference:
    relation: str
    from_table: str
    from_column: str
    to_table: str
    to_column: str
    enforced: bool
    broken_rows: int


@dataclass
class TableProfile:
    table: str
    rows: int
    columns: list[ColumnProfile] = field(default_factory=list)
    broken: list[BrokenReference] = field(default_factory=list)
    components: dict[str, float] = field(default_factory=dict)
    score: float = 100.0
    error: str | None = None


def _q(sess: Session, qualified: str) -> str:
    s, n = qualified.split(".", 1)
    return f"{sess.quote(s)}.{sess.quote(n)}"


def _base(t: str) -> str:
    return t.lower().split("(")[0].strip()


def profile_table(sess: Session, table: str, cols: list[Column], relations: list[Relation]) -> TableProfile:
    tq = _q(sess, table)
    parts = ["COUNT(*) AS n"]
    for i, c in enumerate(cols):
        parts.append(f"COUNT({sess.quote(c.name)}) AS c{i}")
        if _base(c.data_type) not in NO_DISTINCT:
            parts.append(f"COUNT(DISTINCT {sess.quote(c.name)}) AS d{i}")
    try:
        agg = sess.query(f"SELECT {', '.join(parts)} FROM {tq}")[0]
    except EngineError as e:
        return TableProfile(table, 0, error=str(e))
    rows = int(agg["n"])
    tp = TableProfile(table, rows)
    text_cols = [c for c in cols if _base(c.data_type) in TEXT_TYPES
                 and (c.max_length is None or 0 < c.max_length <= 400)]
    samples: dict[str, Counter[str]] = {c.name: Counter() for c in text_cols}
    if text_cols and rows:
        sel = ", ".join(sess.quote(c.name) for c in text_cols)
        try:
            for r in sess.query(f"SELECT TOP {SAMPLE} {sel} FROM {tq}"):
                for c in text_cols:
                    v = r.get(c.name)
                    if v is not None and str(v).strip():
                        samples[c.name][shape(str(v).strip())] += 1
        except EngineError:
            pass
    for i, c in enumerate(cols):
        dist = agg.get(f"d{i}")
        cnt = samples.get(c.name, Counter())
        total = sum(cnt.values())
        pats = [{"shape": s, "share": round(n / total, 4)} for s, n in cnt.most_common(5)] if total else []
        tp.columns.append(ColumnProfile(c.name, c.data_type, rows, rows - int(agg[f"c{i}"]),
                                        int(dist) if dist is not None else None, pats))
    for rel in relations:
        if rel.from_table.lower() != table.lower():
            continue
        fc, tc = sess.quote(rel.from_column), sess.quote(rel.to_column)
        try:
            n = sess.query(f"SELECT COUNT(*) AS n FROM {tq} x WHERE x.{fc} IS NOT NULL AND NOT EXISTS "
                           f"(SELECT 1 FROM {_q(sess, rel.to_table)} p WHERE p.{tc} = x.{fc})")[0]["n"]
        except EngineError:
            continue
        tp.broken.append(BrokenReference(rel.name, rel.from_table, rel.from_column, rel.to_table, rel.to_column,
                                         rel.enforced, int(n)))
    score_table(tp)
    return tp


def score_table(tp: TableProfile) -> None:
    filled = [c.null_rate for c in tp.columns if c.null_rate < 0.5]
    completeness = 1 - (sum(filled) / len(filled)) if filled else 1.0
    dominant = [c.dominant_share for c in tp.columns if c.dominant_share is not None and c.dominant_share >= 0.8]
    validity = sum(d for d in dominant if d is not None) / len(dominant) if dominant else 1.0
    broken = sum(b.broken_rows for b in tp.broken)
    integrity = 1 - min(1.0, broken / tp.rows) if tp.rows and tp.broken else 1.0
    tp.components = {"completeness": round(completeness, 4), "validity": round(validity, 4),
                     "integrity": round(integrity, 4)}
    tp.score = round(100 * sum(WEIGHTS[k] * v for k, v in tp.components.items()), 2)


@dataclass
class Profile:
    tables: list[TableProfile]

    @property
    def estate_score(self) -> float:
        total = sum(t.rows for t in self.tables if t.error is None)
        if not total:
            return 100.0
        return round(sum(t.score * t.rows for t in self.tables if t.error is None) / total, 2)


def profile(sess: Session, dd: DataDictionary, exclude: list[str]) -> Profile:
    skip = {x.lower() for x in exclude}
    return Profile([profile_table(sess, t, cols, dd.relations) for t, cols in sorted(dd.tables().items())
                    if t.lower() not in skip])
