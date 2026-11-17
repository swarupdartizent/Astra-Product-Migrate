"""Write-once audit log (E01.F3.S1, RG-03).

Every user, agent and system action that changes state, and every denied attempt, is recorded.
Hashes, sequence numbers and timestamps are assigned by the database trigger, so callers cannot
forge them. `verify_chain` recomputes every hash and checks signed anchors.
"""

from __future__ import annotations

import csv
import io
import json
import uuid
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, cast

from opentelemetry import trace
from sqlalchemy import Table, insert, select, text
from sqlalchemy.orm import Session

from astra_migrate.db.models import AuditAnchor, AuditEvent
from astra_migrate.vault import VaultClient

ActorType = Literal["user", "agent", "system"]
ANCHOR_KEY = "platform-audit-anchor"


@dataclass(frozen=True)
class Actor:
    type: ActorType
    id: str
    name: str

    @staticmethod
    def system(component: str) -> Actor:
        return Actor("system", f"system:{component}", component)


@dataclass
class AuditQuery:
    tenant_ids: Sequence[uuid.UUID] | None = None  # None = no tenant restriction (platform scope)
    include_platform_events: bool = True
    tenant_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    actor_id: str | None = None
    actor_type: str | None = None
    action_prefix: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    before_seq: int | None = None
    limit: int = 100
    extra: dict[str, Any] = field(default_factory=dict)


def record(
    session: Session,
    actor: Actor,
    action: str,
    *,
    outcome: Literal["success", "denied", "failure"] = "success",
    tenant_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    ctx = trace.get_current_span().get_span_context()
    # seq, occurred_at, prev_hash and hash are assigned by the database trigger.
    session.execute(
        insert(cast(Table, AuditEvent.__table__)).values(
            actor_type=actor.type,
            actor_id=actor.id,
            actor_name=actor.name,
            action=action,
            outcome=outcome,
            tenant_id=tenant_id,
            project_id=project_id,
            target_type=target_type,
            target_id=target_id,
            details=details or {},
            trace_id=format(ctx.trace_id, "032x") if ctx.is_valid else None,
        )
    )


def record_independently(session_factory: Any, actor: Actor, action: str, **kw: Any) -> None:
    """Record in a separate transaction, for denials and failures whose request transaction rolls back."""
    with session_factory() as s:
        record(s, actor, action, **kw)


def _filtered(q: AuditQuery) -> Any:
    stmt = select(AuditEvent)
    if q.tenant_ids is not None:
        cond = AuditEvent.tenant_id.in_(list(q.tenant_ids))
        stmt = stmt.where(cond | AuditEvent.tenant_id.is_(None) if q.include_platform_events else cond)
    if q.tenant_id:
        stmt = stmt.where(AuditEvent.tenant_id == q.tenant_id)
    if q.project_id:
        stmt = stmt.where(AuditEvent.project_id == q.project_id)
    if q.actor_id:
        stmt = stmt.where(AuditEvent.actor_id == q.actor_id)
    if q.actor_type:
        stmt = stmt.where(AuditEvent.actor_type == q.actor_type)
    if q.action_prefix:
        stmt = stmt.where(AuditEvent.action.startswith(q.action_prefix))
    if q.since:
        stmt = stmt.where(AuditEvent.occurred_at >= q.since)
    if q.until:
        stmt = stmt.where(AuditEvent.occurred_at < q.until)
    return stmt


def query(session: Session, q: AuditQuery) -> list[AuditEvent]:
    stmt = _filtered(q)
    if q.before_seq:
        stmt = stmt.where(AuditEvent.seq < q.before_seq)
    stmt = stmt.order_by(AuditEvent.seq.desc()).limit(min(max(q.limit, 1), 500))
    return list(session.scalars(stmt))


def iter_export(session: Session, q: AuditQuery, batch: int = 1000) -> Iterator[AuditEvent]:
    stmt = _filtered(q).order_by(AuditEvent.seq.asc()).execution_options(yield_per=batch)
    yield from session.scalars(stmt)


EXPORT_FIELDS = ["seq", "occurred_at", "actor_type", "actor_id", "actor_name", "action", "outcome",
                 "tenant_id", "project_id", "target_type", "target_id", "details", "trace_id", "prev_hash", "hash"]


def to_dict(e: AuditEvent) -> dict[str, Any]:
    return {
        "seq": e.seq, "occurred_at": e.occurred_at.isoformat(), "actor_type": e.actor_type, "actor_id": e.actor_id,
        "actor_name": e.actor_name, "action": e.action, "outcome": e.outcome,
        "tenant_id": str(e.tenant_id) if e.tenant_id else None,
        "project_id": str(e.project_id) if e.project_id else None,
        "target_type": e.target_type, "target_id": e.target_id, "details": e.details, "trace_id": e.trace_id,
        "prev_hash": e.prev_hash, "hash": e.hash,
    }


def export_lines(session: Session, q: AuditQuery, fmt: Literal["jsonl", "csv"]) -> Iterator[str]:
    if fmt == "jsonl":
        for e in iter_export(session, q):
            yield json.dumps(to_dict(e), separators=(",", ":")) + "\n"
        return
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=EXPORT_FIELDS)
    w.writeheader()
    yield buf.getvalue()
    for e in iter_export(session, q):
        buf.seek(0)
        buf.truncate()
        row = to_dict(e)
        row["details"] = json.dumps(row["details"], separators=(",", ":"))
        w.writerow(row)
        yield buf.getvalue()


# ---------------------------------------------------------------------- verification

@dataclass
class VerifyResult:
    ok: bool
    events_checked: int
    head_seq: int
    head_hash: str | None
    anchors_checked: int
    problems: list[str]


def anchor(session: Session, vault: VaultClient) -> AuditAnchor | None:
    head = session.execute(text("select seq, hash from audit_events order by seq desc limit 1")).first()
    if head is None:
        return None
    vault.ensure_signing_key(ANCHOR_KEY)
    sig, ver = vault.sign(ANCHOR_KEY, f"{head.seq}:{head.hash}".encode())
    a = AuditAnchor(head_seq=head.seq, head_hash=head.hash, signature=sig, key_name=ANCHOR_KEY, key_version=ver)
    session.add(a)
    session.flush()
    return a


def verify_chain(session: Session, vault: VaultClient, max_problems: int = 20) -> VerifyResult:
    problems: list[str] = []
    rows = session.execute(text(
        "select seq, prev_hash, hash, audit_hash(e) as recomputed from audit_events e order by seq"
    )).yield_per(5000)
    expected_prev = "0" * 64
    expected_seq = 1
    count = 0
    head_seq, head_hash = 0, None
    hashes: dict[int, str] = {}
    for r in rows:
        count += 1
        if r.seq != expected_seq:
            problems.append(f"Sequence gap: expected {expected_seq}, found {r.seq} (records missing)")
        if r.prev_hash != expected_prev:
            problems.append(f"Record {r.seq}: link to previous record is broken")
        if r.recomputed != r.hash:
            problems.append(f"Record {r.seq}: content does not match its hash (record was altered)")
        expected_prev, expected_seq = r.hash, r.seq + 1
        head_seq, head_hash = r.seq, r.hash
        hashes[r.seq] = r.hash
        if len(problems) >= max_problems:
            break

    anchors = list(session.scalars(select(AuditAnchor).order_by(AuditAnchor.id)))
    for a in anchors:
        if not vault.verify(a.key_name, f"{a.head_seq}:{a.head_hash}".encode(), a.signature):
            problems.append(f"Anchor {a.id}: signature is not valid")
        elif hashes.get(a.head_seq) != a.head_hash:
            problems.append(f"Anchor {a.id}: signed head at record {a.head_seq} no longer matches the log")
    return VerifyResult(not problems, count, head_seq, head_hash, len(anchors), problems)
