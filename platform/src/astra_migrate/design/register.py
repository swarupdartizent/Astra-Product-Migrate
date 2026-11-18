"""The design register: one item per source element and stream, in the tenant database.

An item's body holds its `source` (what it was proposed from, with a digest), its proposed `target`, `evidence`,
`confidence`, `flags` and, once a person decides, `decision`. A new design run keeps people's decisions while the
source digest is unchanged; when the source changed, the item returns to proposed and the earlier decision is kept
as `previous_decision`.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import psycopg

from astra_migrate.db.models import Tenant
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

STREAMS = ("mapping", "configuration", "form", "code", "integration", "report", "page", "security")
STATUSES = ("proposed", "in_review", "approved", "rejected", "blocked")
DECIDED = ("approved", "rejected")


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:32]


@dataclass
class Item:
    stream: str
    key: str
    status: str  # proposed | in_review | blocked
    source: dict[str, Any]
    target: dict[str, Any] | None
    evidence: list[str] = field(default_factory=list)
    confidence: float | None = None
    flags: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)
    review: dict[str, Any] | None = None  # request for the review queue: title, question, options, owner_role, risk

    def body(self) -> dict[str, Any]:
        return {"source": self.source, "source_digest": digest(self.source), "target": self.target,
                "proposed_target": self.target, "evidence": self.evidence, "confidence": self.confidence,
                "flags": self.flags, **self.extra}


@contextmanager
def connect(t: Tenant) -> Iterator[psycopg.Connection[Any]]:
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        yield tc


def get(tc: psycopg.Connection[Any], project_id: uuid.UUID, stream: str, key: str) -> dict[str, Any] | None:
    row = tc.execute("SELECT status, body, run_id, updated_by, updated_at FROM estate.design_items "
                     "WHERE project_id = %s AND stream = %s AND key = %s", (project_id, stream, key)).fetchone()
    return _row(stream, key, row) if row else None


def _row(stream: str, key: str, row: Any) -> dict[str, Any]:
    return {"stream": stream, "key": key, "status": row[0], **row[1], "run_id": str(row[2]),
            "updated_by": row[3], "updated_at": row[4].isoformat() if row[4] else None}


def items(tc: psycopg.Connection[Any], project_id: uuid.UUID, stream: str | None = None,
          status: str | None = None) -> list[dict[str, Any]]:
    sql = ("SELECT stream, key, status, body, run_id, updated_by, updated_at FROM estate.design_items "
           "WHERE project_id = %s")
    params: list[Any] = [project_id]
    if stream:
        sql += " AND stream = %s"
        params.append(stream)
    if status:
        sql += " AND status = %s"
        params.append(status)
    return [_row(r[0], r[1], r[2:]) for r in tc.execute(sql + " ORDER BY stream, key", params).fetchall()]


def counts(tc: psycopg.Connection[Any], project_id: uuid.UUID) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for stream, status, n in tc.execute("SELECT stream, status, count(*) FROM estate.design_items "
                                        "WHERE project_id = %s GROUP BY stream, status", (project_id,)).fetchall():
        out.setdefault(stream, {})[status] = int(n)
    return out


def store(tc: psycopg.Connection[Any], project_id: uuid.UUID, run_id: uuid.UUID, stream: str, new: list[Item],
          by: str) -> tuple[list[Item], int]:
    """Replace a stream's items with a new run's proposals, keeping decisions on unchanged sources.
    Returns the items that still need a review request, and how many decisions were kept."""
    old = {i["key"]: i for i in items(tc, project_id, stream)}
    need_review: list[Item] = []
    kept = 0
    rows = []
    for it in new:
        body = it.body()
        status = it.status
        prev = old.get(it.key)
        if prev and prev["status"] in DECIDED and prev.get("source_digest") == body["source_digest"]:
            status, kept = prev["status"], kept + 1
            for k in ("decision", "target", "files", "parity", "tests", "test_runs", "key_columns"):
                if k in prev:
                    body[k] = prev[k]
        else:
            if prev and prev.get("decision"):
                body["previous_decision"] = prev["decision"]
            for k in ("files", "parity", "tests", "test_runs", "key_columns"):
                if prev and k in prev and k not in body:
                    body[k] = prev[k]
            if prev and prev["status"] == "in_review" and prev.get("review_item_id") \
                    and prev.get("source_digest") == body["source_digest"]:
                body["review_item_id"] = prev["review_item_id"]
            elif it.review:
                need_review.append(it)
        rows.append((project_id, stream, it.key, run_id, status, json.dumps(body, default=str), by))
    with tc.transaction():
        tc.execute("DELETE FROM estate.design_items WHERE project_id = %s AND stream = %s", (project_id, stream))
        with tc.cursor() as cur:
            cur.executemany("INSERT INTO estate.design_items(project_id, stream, key, run_id, status, body, "
                            "updated_by) VALUES (%s,%s,%s,%s,%s,%s,%s)", rows)
    return need_review, kept


def update(tc: psycopg.Connection[Any], project_id: uuid.UUID, stream: str, key: str, status: str | None,
           changes: dict[str, Any], by: str) -> dict[str, Any]:
    cur = get(tc, project_id, stream, key)
    if cur is None:
        raise KeyError(key)
    body = {k: v for k, v in cur.items() if k not in ("stream", "key", "status", "run_id", "updated_by",
                                                     "updated_at")}
    body.update(changes)
    tc.execute("UPDATE estate.design_items SET status = %s, body = %s, updated_by = %s, updated_at = now() "
               "WHERE project_id = %s AND stream = %s AND key = %s",
               (status or cur["status"], json.dumps(body, default=str), by, project_id, stream, key))
    out = get(tc, project_id, stream, key)
    assert out is not None
    return out


def decision(who: dict[str, str], action: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {"action": action, "reason": reason, **who, "at": datetime.now(UTC).isoformat(), **extra}
