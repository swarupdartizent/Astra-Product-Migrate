"""Configuration discovery (E08.F2.S3) and document sizing (E13.F2.S1)."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from astra_migrate.adapters.contract import DocumentStore, SourceAdapterContent
from astra_migrate.adapters.engines import EngineError, Session


@dataclass
class ConfigItem:
    kind: str
    key: str
    name: str
    scope: str | None
    definition: str
    depends_on: list[str] = field(default_factory=list)

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.definition.encode()).hexdigest()[:16]

    @property
    def ref(self) -> str:
        return f"{self.kind}:{self.key}"


@dataclass
class ConfigResult:
    items: list[ConfigItem]
    problems: list[str]

    def by_kind(self) -> dict[str, int]:
        out: dict[str, int] = defaultdict(int)
        for i in self.items:
            out[i.kind] += 1
        return dict(out)


def _definition(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, dict | list):
        return json.dumps(v, sort_keys=True)
    s = str(v)
    try:
        return json.dumps(json.loads(s), sort_keys=True)
    except (json.JSONDecodeError, ValueError):
        return s


def read_configuration(sess: Session, content: SourceAdapterContent) -> ConfigResult:
    items: list[ConfigItem] = []
    problems: list[str] = []
    for kind in content.configuration:
        q = kind.queries.get(sess.engine)  # type: ignore[call-overload]
        if not q:
            problems.append(f"{kind.label}: no query for {sess.engine}")
            continue
        try:
            rows = sess.query(q)
        except EngineError as e:
            problems.append(f"{kind.label}: {e}")
            continue
        for r in ({k.lower(): v for k, v in row.items()} for row in rows):
            deps = [d.strip() for d in str(r.get("depends_on") or "").split(",") if d.strip()]
            items.append(ConfigItem(kind.kind, str(r["key"]), str(r.get("name") or r["key"]),
                                    str(r["scope"]) if r.get("scope") is not None else None,
                                    _definition(r.get("definition")), deps))
    return ConfigResult(items, problems)


def scope_differences(items: list[ConfigItem]) -> dict[str, Any]:
    """Compare configuration between scopes (for example books): items only in some scopes, and items
    present in several scopes with different definitions."""
    scopes = sorted({i.scope for i in items if i.scope is not None})
    by_name: dict[tuple[str, str], dict[str, ConfigItem]] = defaultdict(dict)
    for i in items:
        if i.scope is not None:
            by_name[(i.kind, i.name)][i.scope] = i
    only, different, same = [], [], 0
    for (kind, name), per in sorted(by_name.items()):
        missing = [s for s in scopes if s not in per]
        if missing:
            only.append({"kind": kind, "name": name, "present_in": sorted(per), "missing_in": missing})
        digests = {s: i.digest for s, i in per.items()}
        if len(set(digests.values())) > 1:
            different.append({"kind": kind, "name": name, "definitions": digests})
        elif not missing:
            same += 1
    return {"scopes": scopes, "only_in_some": only, "different": different, "same_everywhere": same}


# ------------------------------------------------------------------ document sizing

AGE_BUCKETS = [(365, "under 1 year"), (3 * 365, "1-3 years"), (7 * 365, "3-7 years"), (None, "over 7 years")]


def _bucket(created: datetime | None, as_of: datetime) -> str:
    if created is None:
        return "unknown age"
    days = (as_of - created.replace(tzinfo=None)).days
    for limit, label in AGE_BUCKETS:
        if limit is None or days < limit:
            return label
    return "over 7 years"


def _doc_type(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else "(no extension)"


@dataclass
class DocSizing:
    rows: list[dict[str, Any]]  # type, age, link_entity, count, bytes
    total_count: int
    total_bytes: int


def size_documents(sess: Session, d: DocumentStore, as_of: datetime) -> DocSizing:
    s, n = d.table.split(".", 1)
    cols = [f"{sess.quote(d.name_column)} AS doc_name", f"{sess.quote(d.link_type_column)} AS link_type"]
    cols.append(f"{sess.quote(d.created_column)} AS created" if d.created_column else "NULL AS created")
    cols.append(f"{sess.size_expr(sess.quote(d.content_column))} AS size_bytes" if d.content_column
                else "NULL AS size_bytes")
    agg: dict[tuple[str, str, str], list[int]] = defaultdict(lambda: [0, 0])
    total_c = total_b = 0
    for batch in sess.stream(f"SELECT {', '.join(cols)} FROM {sess.quote(s)}.{sess.quote(n)}", batch=5000):
        for r in batch:
            created = r.get("created")
            key = (_doc_type(str(r.get("doc_name") or "")),
                   _bucket(created if isinstance(created, datetime) else None, as_of),
                   d.link_types.get(str(r.get("link_type") or "").strip(), "unknown"))
            size = int(r.get("size_bytes") or 0)
            agg[key][0] += 1
            agg[key][1] += size
            total_c += 1
            total_b += size
    rows = [{"type": k[0], "age": k[1], "link_entity": k[2], "count": v[0], "bytes": v[1]}
            for k, v in sorted(agg.items())]
    return DocSizing(rows, total_c, total_b)
