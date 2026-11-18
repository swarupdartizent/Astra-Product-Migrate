"""Data dictionary harvest (E08.F1.S1): tables, fields, types, relations and code lists."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from astra_migrate.adapters.contract import SourceAdapterContent
from astra_migrate.adapters.engines import EngineError, Session


@dataclass
class Column:
    table: str  # schema.name
    name: str
    data_type: str
    max_length: int | None
    nullable: bool
    ordinal: int


@dataclass
class Relation:
    name: str
    from_table: str
    from_column: str
    to_table: str
    to_column: str
    enforced: bool  # a foreign key in the database, or a soft relation the adapter declares


@dataclass
class CodeList:
    name: str
    table: str
    values: list[dict[str, str]]


@dataclass
class DataDictionary:
    columns: list[Column] = field(default_factory=list)
    relations: list[Relation] = field(default_factory=list)
    code_lists: list[CodeList] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    def tables(self) -> dict[str, list[Column]]:
        out: dict[str, list[Column]] = {}
        for c in self.columns:
            out.setdefault(c.table, []).append(c)
        for cols in out.values():
            cols.sort(key=lambda c: c.ordinal)
        return out


def _low(r: dict[str, Any]) -> dict[str, Any]:
    return {k.lower(): v for k, v in r.items()}


def harvest(sess: Session, content: SourceAdapterContent) -> DataDictionary:
    d = DataDictionary()
    spec = content.dictionary
    if spec is None:
        d.problems.append("The adapter declares no data dictionary queries.")
        return d
    q = spec.columns.get(sess.engine)  # type: ignore[call-overload]
    if not q:
        d.problems.append(f"The adapter has no column query for {sess.engine}.")
        return d
    try:
        for r in map(_low, sess.query(q)):
            d.columns.append(Column(f"{r['table_schema']}.{r['table_name']}", str(r["column_name"]),
                                    str(r["data_type"]),
                                    int(r["max_length"]) if r.get("max_length") is not None else None,
                                    bool(r.get("nullable")), int(r.get("ordinal") or 0)))
    except EngineError as e:
        d.problems.append(f"Columns could not be read: {e}")
    rq = spec.relations.get(sess.engine)  # type: ignore[call-overload]
    if rq:
        try:
            for r in map(_low, sess.query(rq)):
                d.relations.append(Relation(str(r["name"]), f"{r['from_schema']}.{r['from_table']}",
                                            str(r["from_column"]), f"{r['to_schema']}.{r['to_table']}",
                                            str(r["to_column"]), True))
        except EngineError as e:
            d.problems.append(f"Relations could not be read: {e}")
    for sr in spec.soft_relations:
        d.relations.append(Relation(f"soft:{sr.from_table}.{sr.from_column}", sr.from_table, sr.from_column,
                                    sr.to_table, sr.to_column, False))
    for cl in spec.code_lists:
        s, n = cl.table.split(".", 1)
        try:
            rows = sess.query(f"SELECT {sess.quote(cl.code_column)} AS code, {sess.quote(cl.label_column)} AS label "
                              f"FROM {sess.quote(s)}.{sess.quote(n)} ORDER BY {sess.quote(cl.code_column)}")
            d.code_lists.append(CodeList(cl.name, cl.table, [{"code": str(r["code"]), "label": str(r["label"])}
                                                             for r in rows]))
        except EngineError as e:
            d.problems.append(f"Code list {cl.name} could not be read: {e}")
    return d
