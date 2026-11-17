"""Connector secrets (E01.F2.S3), audit log (E01.F3.S1) and observability (E01.F3.S2) endpoints."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from astra_migrate import audit, connector_secrets
from astra_migrate.api.errors import forbidden, invalid, not_found
from astra_migrate.api.routes.core import visible_tenant_ids
from astra_migrate.config import get_settings
from astra_migrate.db.control import get_session, session_scope
from astra_migrate.db.models import AuditAnchor, ConnectorSecret, TraceSpan, User
from astra_migrate.security.principal import CurrentPrincipal, tenant_for
from astra_migrate.security.rbac import ROLES, P
from astra_migrate.vault import get_vault

router = APIRouter()
DB = Annotated[Session, Depends(get_session)]


# ======================================================================= secrets

class SecretOut(BaseModel):
    id: uuid.UUID
    name: str
    reference: str
    description: str
    current_version: int
    created_at: datetime
    created_by_name: str | None
    rotated_at: datetime | None
    last_read_at: datetime | None
    last_read_by: str | None


class SecretIn(BaseModel):
    name: str = Field(min_length=3, max_length=64)
    description: str = Field(default="", max_length=500)
    value: str = Field(min_length=1, max_length=8192)


class RotateIn(BaseModel):
    value: str = Field(min_length=1, max_length=8192)


def _secret_out(s: Session, cs: ConnectorSecret) -> SecretOut:
    creator = s.get(User, cs.created_by)
    return SecretOut(id=cs.id, name=cs.name, reference=f"secret://{cs.name}", description=cs.description,
                     current_version=cs.current_version, created_at=cs.created_at,
                     created_by_name=creator.display_name if creator else None, rotated_at=cs.rotated_at,
                     last_read_at=cs.last_read_at, last_read_by=cs.last_read_by)


@router.get("/tenants/{tenant_id}/secrets", response_model=list[SecretOut], tags=["secrets"])
def list_secrets(tenant_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[SecretOut]:
    t = tenant_for(s, principal, tenant_id, P.SECRETS_READ)
    rows = s.scalars(select(ConnectorSecret).where(ConnectorSecret.tenant_id == t.id).order_by(ConnectorSecret.name))
    return [_secret_out(s, cs) for cs in rows]


@router.post("/tenants/{tenant_id}/secrets", response_model=SecretOut, status_code=201, tags=["secrets"])
def create_secret(tenant_id: uuid.UUID, body: SecretIn, principal: CurrentPrincipal, s: DB) -> SecretOut:
    t = tenant_for(s, principal, tenant_id, P.SECRETS_MANAGE)
    try:
        cs = connector_secrets.create(s, get_vault(), t, principal.actor, principal.user.id, body.name,
                                      body.description, body.value)
    except connector_secrets.SecretError as e:
        raise invalid("value" if "value" in str(e) else "name", str(e)) from e
    return _secret_out(s, cs)


def _secret(s: Session, tenant_id: uuid.UUID, secret_id: uuid.UUID) -> ConnectorSecret:
    cs = s.get(ConnectorSecret, secret_id)
    if cs is None or cs.tenant_id != tenant_id:
        raise not_found("Secret")
    return cs


@router.post("/tenants/{tenant_id}/secrets/{secret_id}/rotate", response_model=SecretOut, tags=["secrets"])
def rotate_secret(tenant_id: uuid.UUID, secret_id: uuid.UUID, body: RotateIn, principal: CurrentPrincipal,
                  s: DB) -> SecretOut:
    t = tenant_for(s, principal, tenant_id, P.SECRETS_MANAGE)
    cs = _secret(s, t.id, secret_id)
    connector_secrets.rotate(s, get_vault(), cs, principal.actor, principal.user.id, body.value)
    return _secret_out(s, cs)


@router.delete("/tenants/{tenant_id}/secrets/{secret_id}", status_code=204, response_class=Response,
               response_model=None, tags=["secrets"])
def delete_secret(tenant_id: uuid.UUID, secret_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> None:
    t = tenant_for(s, principal, tenant_id, P.SECRETS_MANAGE)
    connector_secrets.delete(s, get_vault(), _secret(s, t.id, secret_id), principal.actor)


# ======================================================================= audit

class AuditEventOut(BaseModel):
    seq: int
    occurred_at: datetime
    actor_type: str
    actor_id: str
    actor_name: str
    action: str
    outcome: str
    tenant_id: uuid.UUID | None
    project_id: uuid.UUID | None
    target_type: str | None
    target_id: str | None
    details: dict[str, Any]
    trace_id: str | None
    hash: str


class AuditPage(BaseModel):
    items: list[AuditEventOut]
    next_before_seq: int | None


def _audit_query(s: Session, principal: CurrentPrincipal, perm: P, tenant_id: uuid.UUID | None,
                 project_id: uuid.UUID | None, actor_id: str | None, actor_type: str | None, action: str | None,
                 since: datetime | None, until: datetime | None, before_seq: int | None, limit: int
                 ) -> audit.AuditQuery:
    if not any(g.role in ROLES and perm in ROLES[g.role].permissions for g in principal.grants):
        raise forbidden()
    ids = visible_tenant_ids(s, principal, perm)
    if tenant_id and ids is not None and tenant_id not in ids:
        raise not_found("Tenant")
    return audit.AuditQuery(tenant_ids=ids, include_platform_events=ids is None, tenant_id=tenant_id,
                            project_id=project_id, actor_id=actor_id, actor_type=actor_type, action_prefix=action,
                            since=since, until=until, before_seq=before_seq, limit=limit)


@router.get("/audit", response_model=AuditPage, tags=["audit"])
def list_audit(principal: CurrentPrincipal, s: DB, tenant_id: uuid.UUID | None = None,
               project_id: uuid.UUID | None = None, actor_id: str | None = None,
               actor_type: Literal["user", "agent", "system"] | None = None, action: str | None = None,
               since: datetime | None = None, until: datetime | None = None, before_seq: int | None = None,
               limit: Annotated[int, Query(ge=1, le=500)] = 100) -> AuditPage:
    q = _audit_query(s, principal, P.AUDIT_READ, tenant_id, project_id, actor_id, actor_type, action, since, until,
                     before_seq, limit)
    rows = audit.query(s, q)
    items = [AuditEventOut.model_validate(audit.to_dict(e)) for e in rows]
    return AuditPage(items=items, next_before_seq=rows[-1].seq if len(rows) == q.limit else None)


@router.get("/audit/export", tags=["audit"])
def export_audit(principal: CurrentPrincipal, s: DB, fmt: Annotated[Literal["csv", "jsonl"], Query(alias="format")]
                 = "csv", tenant_id: uuid.UUID | None = None, project_id: uuid.UUID | None = None,
                 actor_id: str | None = None, actor_type: Literal["user", "agent", "system"] | None = None,
                 action: str | None = None, since: datetime | None = None, until: datetime | None = None
                 ) -> StreamingResponse:
    q = _audit_query(s, principal, P.AUDIT_EXPORT, tenant_id, project_id, actor_id, actor_type, action, since, until,
                     None, 500)
    audit.record(s, principal.actor, "audit.exported", tenant_id=tenant_id, details={
        "format": fmt, "filters": {k: str(v) for k, v in {"tenant_id": tenant_id, "project_id": project_id,
                                                           "actor_id": actor_id, "actor_type": actor_type,
                                                           "action": action, "since": since,
                                                           "until": until}.items() if v}})
    s.commit()

    def stream() -> Iterator[str]:
        with session_scope() as rs:
            yield from audit.export_lines(rs, q, fmt)

    media = "text/csv" if fmt == "csv" else "application/x-ndjson"
    name = f"audit-{datetime.now().strftime('%Y%m%d-%H%M%S')}.{fmt}"
    return StreamingResponse(stream(), media_type=media,
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


class VerifyOut(BaseModel):
    ok: bool
    events_checked: int
    head_seq: int
    head_hash: str | None
    anchors_checked: int
    problems: list[str]
    anchored_seq: int | None


@router.post("/audit/verify", response_model=VerifyOut, tags=["audit"])
def verify_audit(principal: CurrentPrincipal, s: DB) -> VerifyOut:
    """Recompute every hash, check every signed anchor, then sign the current head."""
    if not principal.has_platform(P.AUDIT_VERIFY):
        raise forbidden()
    vault = get_vault()
    res = audit.verify_chain(s, vault)
    anchored = audit.anchor(s, vault) if res.ok else None
    audit.record(s, principal.actor, "audit.verified", outcome="success" if res.ok else "failure",
                 details={"events_checked": res.events_checked, "ok": res.ok, "problems": res.problems[:5]})
    return VerifyOut(ok=res.ok, events_checked=res.events_checked, head_seq=res.head_seq, head_hash=res.head_hash,
                     anchors_checked=res.anchors_checked, problems=res.problems,
                     anchored_seq=anchored.head_seq if anchored else None)


class AnchorOut(BaseModel):
    id: int
    anchored_at: datetime
    head_seq: int
    head_hash: str
    key_name: str
    key_version: int


@router.get("/audit/anchors", response_model=list[AnchorOut], tags=["audit"])
def list_anchors(principal: CurrentPrincipal, s: DB) -> list[AnchorOut]:
    if not principal.has_platform(P.AUDIT_READ):
        raise forbidden()
    rows = s.scalars(select(AuditAnchor).order_by(AuditAnchor.id.desc()).limit(50))
    return [AnchorOut(id=a.id, anchored_at=a.anchored_at, head_seq=a.head_seq, head_hash=a.head_hash,
                      key_name=a.key_name, key_version=a.key_version) for a in rows]


# ======================================================================= observability

class SummaryRow(BaseModel):
    key: str | None
    spans: int
    errors: int
    total_ms: float
    p95_ms: float
    cost_usd: float | None


class TraceRow(BaseModel):
    trace_id: str
    name: str
    started_at: datetime
    duration_ms: float
    status: str
    span_count: int
    tenant_id: str | None
    cost_usd: float | None


class SpanOut(BaseModel):
    span_id: str
    parent_span_id: str | None
    name: str
    category: str
    started_at: datetime
    duration_ms: float
    status: str
    stage: str | None
    agent: str | None
    model: str | None
    cost_usd: float | None
    attributes: dict[str, Any]


class TraceDetail(BaseModel):
    trace_id: str
    jaeger_url: str | None
    spans: list[SpanOut]


GroupBy = Literal["project", "stage", "agent", "category", "name", "tenant"]
_GROUP_COL = {"project": TraceSpan.project_id, "stage": TraceSpan.stage, "agent": TraceSpan.agent,
              "category": TraceSpan.category, "name": TraceSpan.name, "tenant": TraceSpan.tenant_id}


def _obs_scope(s: Session, principal: CurrentPrincipal) -> list[str] | None:
    if not any(g.role in ROLES and P.OBSERVABILITY_READ in ROLES[g.role].permissions for g in principal.grants):
        raise forbidden()
    ids = visible_tenant_ids(s, principal, P.OBSERVABILITY_READ)
    return None if ids is None else [str(i) for i in ids]


@router.get("/observability/summary", response_model=list[SummaryRow], tags=["observability"])
def summary(principal: CurrentPrincipal, s: DB, group_by: GroupBy = "category", since: datetime | None = None,
            category: str | None = None) -> list[SummaryRow]:
    scope = _obs_scope(s, principal)
    col = _GROUP_COL[group_by]
    stmt = select(col.label("key"), func.count().label("spans"),
                  func.count().filter(TraceSpan.status == "error").label("errors"),
                  func.sum(TraceSpan.duration_ms).label("total_ms"),
                  func.percentile_cont(0.95).within_group(TraceSpan.duration_ms).label("p95_ms"),
                  func.sum(TraceSpan.cost_usd).label("cost_usd")).group_by(col)
    if scope is not None:
        stmt = stmt.where(TraceSpan.tenant_id.in_(scope))
    if since:
        stmt = stmt.where(TraceSpan.started_at >= since)
    if category:
        stmt = stmt.where(TraceSpan.category == category)
    rows = s.execute(stmt.order_by(func.sum(TraceSpan.duration_ms).desc()).limit(200)).all()
    return [SummaryRow(key=r.key, spans=r.spans, errors=r.errors, total_ms=float(r.total_ms or 0),
                       p95_ms=float(r.p95_ms or 0), cost_usd=float(r.cost_usd) if r.cost_usd is not None else None)
            for r in rows]


@router.get("/observability/traces", response_model=list[TraceRow], tags=["observability"])
def traces(principal: CurrentPrincipal, s: DB, limit: Annotated[int, Query(ge=1, le=200)] = 50,
           status: Literal["ok", "error"] | None = None) -> list[TraceRow]:
    scope = _obs_scope(s, principal)
    roots = select(TraceSpan).where(TraceSpan.parent_span_id.is_(None))
    if scope is not None:
        roots = roots.where(TraceSpan.tenant_id.in_(scope))
    if status:
        roots = roots.where(TraceSpan.status == status)
    out: list[TraceRow] = []
    for r in s.scalars(roots.order_by(TraceSpan.started_at.desc()).limit(limit)):
        agg = s.execute(select(func.count(), func.sum(TraceSpan.cost_usd))
                        .where(TraceSpan.trace_id == r.trace_id)).one()
        out.append(TraceRow(trace_id=r.trace_id, name=r.name, started_at=r.started_at, duration_ms=r.duration_ms,
                            status=r.status, span_count=agg[0], tenant_id=r.tenant_id,
                            cost_usd=float(agg[1]) if agg[1] is not None else None))
    return out


@router.get("/observability/traces/{trace_id}", response_model=TraceDetail, tags=["observability"])
def trace_detail(trace_id: str, principal: CurrentPrincipal, s: DB) -> TraceDetail:
    scope = _obs_scope(s, principal)
    spans = list(s.scalars(select(TraceSpan).where(TraceSpan.trace_id == trace_id).order_by(TraceSpan.started_at)))
    if not spans or (scope is not None and not any(sp.tenant_id in scope for sp in spans)):
        raise not_found("Trace")
    jaeger = "http://localhost:16686/trace/" + trace_id if get_settings().environment == "local" else None
    return TraceDetail(trace_id=trace_id, jaeger_url=jaeger, spans=[SpanOut(
        span_id=sp.span_id, parent_span_id=sp.parent_span_id, name=sp.name, category=sp.category,
        started_at=sp.started_at, duration_ms=sp.duration_ms, status=sp.status, stage=sp.stage, agent=sp.agent,
        model=sp.model, cost_usd=sp.cost_usd, attributes=sp.attributes) for sp in spans])
