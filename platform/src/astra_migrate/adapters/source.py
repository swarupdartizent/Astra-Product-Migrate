"""Source adapter operations over any adapter pack (E05.F1.S1, E05.F2.S2-S4).

These functions take an open read-only engine session and the adapter pack's content, and return
plain results. Where results are stored (the tenant's own database) is decided by the caller.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from astra_migrate.adapters.contract import DocumentStore, Entity, SourceAdapterContent, Trap
from astra_migrate.adapters.engines import EngineError, Session, jsonable

MAX_DEFINITION = 2_000_000


@dataclass
class MetadataObject:
    type: str
    name: str
    schema: str | None
    owner: str | None
    modified_at: str | None
    definition: str | None
    depends_on: list[str] = field(default_factory=list)
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def qualified(self) -> str:
        return f"{self.schema}.{self.name}" if self.schema else self.name

    @property
    def definition_sha256(self) -> str | None:
        return hashlib.sha256(self.definition.encode()).hexdigest() if self.definition else None


@dataclass
class Coverage:
    object_type: str
    label: str
    required: bool
    status: str  # read | failed | empty
    count: int
    error: str | None = None
    dependencies: str = "not_declared"  # read | failed | not_declared
    code_missing: int = 0  # code objects whose source text could not be read


@dataclass
class MetadataResult:
    objects: list[MetadataObject]
    coverage: list[Coverage]

    @property
    def complete(self) -> bool:
        return all(c.status != "failed" and c.code_missing == 0 for c in self.coverage if c.required)

    def by_type(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for o in self.objects:
            out[o.type] = out.get(o.type, 0) + 1
        return out


def _s(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def read_metadata(sess: Session, content: SourceAdapterContent) -> MetadataResult:
    objects: list[MetadataObject] = []
    coverage: list[Coverage] = []
    for ot in content.object_types:
        sql = ot.queries.get(sess.engine)  # type: ignore[call-overload]
        if sql is None:
            coverage.append(Coverage(ot.key, ot.label, ot.required, "failed", 0,
                                     f"No query for engine {sess.engine}"))
            continue
        try:
            rows = sess.query(sql)
        except EngineError as e:
            coverage.append(Coverage(ot.key, ot.label, ot.required, "failed", 0, str(e)))
            continue
        found: dict[str, MetadataObject] = {}
        missing_code = 0
        for r in rows:
            low = {k.lower(): v for k, v in r.items()}
            name = _s(low.get("name"))
            if not name:
                continue
            definition = _s(low.get("definition"))
            if definition and len(definition) > MAX_DEFINITION:
                definition = definition[:MAX_DEFINITION]
            if ot.code and not definition:
                missing_code += 1
            detail_raw = low.get("detail")
            try:
                detail = json.loads(detail_raw) if isinstance(detail_raw, str) and detail_raw else {}
            except json.JSONDecodeError:
                detail = {"raw": str(detail_raw)[:2000]}
            if isinstance(detail, list):
                detail = {"items": detail}
            extra = {k: jsonable(v) for k, v in low.items()
                     if k not in {"name", "schema", "owner", "modified_at", "definition", "detail"}}
            if extra:
                detail = {**extra, **detail} if isinstance(detail, dict) else extra
            o = MetadataObject(ot.key, name, _s(low.get("schema")), _s(low.get("owner")), _s(low.get("modified_at")),
                               definition, [], detail if isinstance(detail, dict) else {})
            found[o.qualified.lower()] = o
        dep_status = "not_declared"
        dep_sql = ot.dependencies.get(sess.engine)  # type: ignore[call-overload]
        if dep_sql:
            try:
                for r in sess.query(dep_sql):
                    low = {k.lower(): v for k, v in r.items()}
                    key, target = _s(low.get("name")), _s(low.get("depends_on"))
                    if key and target and key.lower() in found and target not in found[key.lower()].depends_on:
                        found[key.lower()].depends_on.append(target)
                dep_status = "read"
            except EngineError:
                dep_status = "failed"
        objects.extend(found.values())
        coverage.append(Coverage(ot.key, ot.label, ot.required, "read" if found else "empty", len(found),
                                 None, dep_status, missing_code))
    return MetadataResult(objects, coverage)


# ------------------------------------------------------------------ traps

@dataclass
class TrapFinding:
    trap_id: str
    title: str
    severity: str
    stream: str
    advice: str
    origin: str  # pack | curated
    hits: list[str]


def evaluate_traps(sess: Session, traps: list[tuple[Trap, str]], meta: MetadataResult) -> tuple[
        list[TrapFinding], list[dict[str, str]]]:
    """Return the traps that apply to this estate, and any traps that could not be evaluated."""
    findings: list[TrapFinding] = []
    errors: list[dict[str, str]] = []
    for trap, origin in traps:
        d = trap.detect
        hits: list[str] = []
        if d.kind == "object_exists":
            name_re = re.compile(d.name_pattern, re.IGNORECASE) if d.name_pattern else None
            def_re = re.compile(d.definition_pattern, re.IGNORECASE | re.DOTALL) if d.definition_pattern else None
            for o in meta.objects:
                if o.type != d.object_type:
                    continue
                if name_re and not name_re.search(o.qualified):
                    continue
                if def_re and not (o.definition and def_re.search(o.definition)):
                    continue
                hits.append(o.qualified)
        else:
            sql = d.queries.get(sess.engine)  # type: ignore[call-overload]
            if not sql:
                continue  # the trap does not apply to this engine
            try:
                rows = sess.query(sql, limit=500)
            except EngineError as e:
                errors.append({"trap": trap.id, "error": str(e)})
                continue
            for r in rows:
                vals = [str(v) for v in r.values() if v is not None]
                hits.append(" · ".join(vals)[:300] or "(row)")
        if hits:
            findings.append(TrapFinding(trap.id, trap.title, trap.severity, trap.stream, trap.advice, origin,
                                        sorted(set(hits))[:500]))
    return findings, errors


# ------------------------------------------------------------------ extraction

def entity_key(e: Entity, row: dict[str, Any]) -> str:
    return "|".join(str(row.get(k)) for k in e.key)


def _cols(sess: Session, cols: list[str]) -> str:
    return ", ".join(sess.quote(c) for c in cols)


def _table(sess: Session, qualified: str) -> str:
    schema, name = qualified.split(".", 1)
    return f"{sess.quote(schema)}.{sess.quote(name)}"


def count_rows(sess: Session, e: Entity, since: Any = None) -> int:
    sql = f"SELECT COUNT(*) AS n FROM {_table(sess, e.table)}"
    params: tuple[Any, ...] = ()
    if since is not None and e.delta_column:
        sql += f" WHERE {sess.quote(e.delta_column)} > %s"
        params = (since,)
    rows = sess.query(sql, params or None)
    return int(rows[0]["n"]) if rows else 0


def extract_entity(sess: Session, e: Entity, since: Any = None, batch: int = 1000
                   ) -> Iterator[list[tuple[str, dict[str, Any]]]]:
    """Yield batches of (key, row) for one entity, in full or rows changed after `since`."""
    sql = f"SELECT * FROM {_table(sess, e.table)}"
    params: tuple[Any, ...] = ()
    if since is not None and e.delta_column:
        sql += f" WHERE {sess.quote(e.delta_column)} > %s"
        params = (since,)
    sql += f" ORDER BY {_cols(sess, e.key)}"
    for rows in sess.stream(sql, params or None, batch=batch):
        yield [(entity_key(e, r), {k: jsonable(v) for k, v in r.items()}) for r in rows]


def watermark(sess: Session, e: Entity) -> Any:
    if not e.delta_column:
        return None
    rows = sess.query(f"SELECT MAX({sess.quote(e.delta_column)}) AS w FROM {_table(sess, e.table)}")
    return rows[0]["w"] if rows else None


@dataclass
class Document:
    key: str
    name: str
    link_type: str | None
    link_entity: str | None
    link_key: str | None
    created_at: str | None
    content: bytes | None

    @property
    def sha256(self) -> str | None:
        return hashlib.sha256(self.content).hexdigest() if self.content is not None else None


def extract_documents(sess: Session, d: DocumentStore, since: Any = None, batch: int = 200
                      ) -> Iterator[list[Document]]:
    cols = [d.key, d.name_column, d.link_type_column, d.link_key_column]
    if d.created_column:
        cols.append(d.created_column)
    if d.content_column:
        cols.append(d.content_column)
    sql = f"SELECT {_cols(sess, cols)} FROM {_table(sess, d.table)}"
    params: tuple[Any, ...] = ()
    if since is not None and d.delta_column:
        sql += f" WHERE {sess.quote(d.delta_column)} > %s"
        params = (since,)
    sql += f" ORDER BY {sess.quote(d.key)}"
    for rows in sess.stream(sql, params or None, batch=batch):
        out = []
        for r in rows:
            lt = r.get(d.link_type_column)
            content = r.get(d.content_column) if d.content_column else None
            out.append(Document(
                key=str(r.get(d.key)), name=str(r.get(d.name_column) or ""),
                link_type=str(lt) if lt is not None else None,
                link_entity=d.link_types.get(str(lt).strip()) if lt is not None else None,
                link_key=str(r.get(d.link_key_column)) if r.get(d.link_key_column) is not None else None,
                created_at=_s(r.get(d.created_column)) if d.created_column else None,
                content=bytes(content) if isinstance(content, bytes | bytearray | memoryview) else None))
        yield out
