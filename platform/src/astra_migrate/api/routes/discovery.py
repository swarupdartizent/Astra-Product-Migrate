"""Discovery (E08, E13.F2.S1): activity imports, discovery runs, the knowledge graph, results and the
coverage report that the discovery gate needs."""

from __future__ import annotations

import base64
import binascii
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.api.errors import Problem, conflict, forbidden, invalid, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import (
    ActivityImport,
    AdapterRun,
    CoverageReport,
    DiscoveryRun,
    SourceConnection,
    Tenant,
    User,
)
from astra_migrate.discovery.activity import ActivityError
from astra_migrate.discovery.graph import STREAM_TITLES
from astra_migrate.discovery.jobs import import_activity
from astra_migrate.jobs.runner import actor_dict, enqueue
from astra_migrate.security.principal import CurrentPrincipal, Principal, project_for, tenant_for
from astra_migrate.security.rbac import P
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

router = APIRouter(tags=["discovery"])
DB = Annotated[Session, Depends(get_session)]
MAX_IMPORT_BYTES = 25 * 1024 * 1024


# ------------------------------------------------------------------ activity imports

class ActivityIn(BaseModel):
    filename: str = Field(min_length=5, max_length=255, pattern=r"(?i)^[^/\\]+\.(jsonl|ndjson|json|csv)$")
    content_base64: str = Field(min_length=4)


class ActivityOut(BaseModel):
    id: uuid.UUID
    connection_id: uuid.UUID
    filename: str
    sha256: str
    records: int
    first_at: datetime | None
    last_at: datetime | None
    days: int
    created_by: str | None
    created_at: datetime


def _import_out(s: Session, i: ActivityImport) -> ActivityOut:
    u = s.get(User, i.created_by)
    days = (i.last_at - i.first_at).days + 1 if i.first_at and i.last_at else 0
    return ActivityOut(id=i.id, connection_id=i.connection_id, filename=i.filename, sha256=i.sha256, records=i.records,
                       first_at=i.first_at, last_at=i.last_at, days=days, created_by=u.display_name if u else None,
                       created_at=i.created_at)


def _conn(s: Session, principal: Principal, connection_id: uuid.UUID, perm: P) -> tuple[SourceConnection, Tenant]:
    c = s.get(SourceConnection, connection_id)
    if c is None:
        raise not_found("Connection")
    return c, tenant_for(s, principal, c.tenant_id, perm)


@router.post("/source-connections/{connection_id}/activity", response_model=ActivityOut, status_code=201)
def upload_activity(connection_id: uuid.UUID, body: ActivityIn, principal: CurrentPrincipal, s: DB) -> ActivityOut:
    """Import login and query records in the activity format (docs/discovery.md)."""
    c, t = _conn(s, principal, connection_id, P.SOURCE_MANAGE)
    try:
        data = base64.b64decode(body.content_base64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise invalid("content_base64", "The file content is not valid base64.") from e
    if len(data) > MAX_IMPORT_BYTES:
        raise invalid("content_base64", "Imports are limited to 25 MB per file; split larger logs.")
    try:
        imp = import_activity(s, c, t, principal.user, principal.actor, body.filename, data)
    except ActivityError as e:
        raise invalid("content_base64", str(e)) from e
    return _import_out(s, imp)


@router.get("/source-connections/{connection_id}/activity", response_model=list[ActivityOut])
def list_activity(connection_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[ActivityOut]:
    c, _ = _conn(s, principal, connection_id, P.TENANT_READ)
    return [_import_out(s, i) for i in s.scalars(select(ActivityImport).where(ActivityImport.connection_id == c.id)
                                                 .order_by(ActivityImport.created_at.desc()))]


# ------------------------------------------------------------------ discovery runs

class RunIn(BaseModel):
    connection_id: uuid.UUID
    window_days: int = Field(default=90, ge=7, le=730)
    as_of: datetime | None = Field(default=None, description="End of the usage window; default now")


class RunOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    connection_id: uuid.UUID
    connection_name: str | None
    adapter: str
    status: str
    status_detail: str | None
    as_of: datetime
    window_days: int
    phases: dict[str, Any]
    summary: dict[str, Any]
    job_id: uuid.UUID | None
    requested_by: str
    created_at: datetime
    finished_at: datetime | None
    coverage_report_id: uuid.UUID | None


def _run_out(s: Session, r: DiscoveryRun) -> RunOut:
    c = s.get(SourceConnection, r.connection_id)
    rep = s.scalar(select(CoverageReport.id).where(CoverageReport.discovery_run_id == r.id))
    return RunOut(id=r.id, project_id=r.project_id, connection_id=r.connection_id,
                  connection_name=c.name if c else None,
                  adapter=r.adapter, status=r.status, status_detail=r.status_detail, as_of=r.as_of,
                  window_days=r.window_days, phases=r.phases, summary=r.summary, job_id=r.job_id,
                  requested_by=str(r.requested_by.get("name", "")), created_at=r.created_at,
                  finished_at=r.finished_at, coverage_report_id=rep)


@router.post("/projects/{project_id}/discovery-runs", response_model=RunOut, status_code=202)
def start_run(project_id: uuid.UUID, body: RunIn, principal: CurrentPrincipal, s: DB) -> RunOut:
    t, p = project_for(s, principal, project_id, None)
    if not principal.has_on_tenant(P.SOURCE_MANAGE, t):
        raise forbidden("You need permission to run discovery on this tenant's sources.")
    c = s.get(SourceConnection, body.connection_id)
    if c is None or c.tenant_id != t.id:
        raise invalid("connection_id", "Choose a source connection of this project's tenant.")
    if s.scalar(select(AdapterRun.id).where(AdapterRun.connection_id == c.id, AdapterRun.kind == "check",
                                            AdapterRun.status == "succeeded")) is None:
        raise conflict("Check the connection first", "Discovery starts only after a connection check has proved "
                                                      "the account is read-only.")
    busy = s.scalar(select(DiscoveryRun.id).where(DiscoveryRun.project_id == p.id,
                                                  DiscoveryRun.status.in_(("queued", "running"))))
    if busy is not None:
        raise conflict("A discovery run is already in progress for this project")
    run = DiscoveryRun(tenant_id=t.id, project_id=p.id, connection_id=c.id, adapter=c.adapter, status="queued",
                       as_of=body.as_of or datetime.now(UTC), window_days=body.window_days, phases={}, summary={},
                       requested_by=actor_dict(principal.actor))
    s.add(run)
    s.flush()
    job = enqueue(s, "discovery.run", f"Discovery of {c.name} for {p.name}", principal.actor, {"run_id": str(run.id)},
                  tenant_id=t.id, project_id=p.id)
    run.job_id = job.id
    audit.record(s, principal.actor, "discovery.run_requested", tenant_id=t.id, project_id=p.id,
                 target_type="discovery_run", target_id=str(run.id),
                 details={"connection": c.name, "window_days": body.window_days})
    return _run_out(s, run)


@router.get("/projects/{project_id}/discovery-runs", response_model=list[RunOut])
def list_runs(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[RunOut]:
    _, p = project_for(s, principal, project_id, None)
    return [_run_out(s, r) for r in s.scalars(select(DiscoveryRun).where(DiscoveryRun.project_id == p.id)
                                              .order_by(DiscoveryRun.created_at.desc()).limit(50))]


def _run(s: Session, principal: Principal, run_id: uuid.UUID) -> tuple[DiscoveryRun, Tenant]:
    r = s.get(DiscoveryRun, run_id)
    if r is None:
        raise not_found("Discovery run")
    t, _ = project_for(s, principal, r.project_id, None)
    return r, t


@router.get("/discovery-runs/{run_id}", response_model=RunOut)
def get_run(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> RunOut:
    r, _ = _run(s, principal, run_id)
    return _run_out(s, r)


def _section(t: Tenant, run_id: uuid.UUID, section: str) -> Any:
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        row = tc.execute("SELECT payload FROM estate.discovery_results WHERE run_id = %s AND section = %s",
                         (run_id, section)).fetchone()
    if row is None:
        raise not_found("Discovery result")
    return row[0]


SECTIONS = ("profile", "usage", "rules", "interfaces", "configuration", "documents", "dictionary", "gaps")


@router.get("/discovery-runs/{run_id}/results/{section}")
def results(run_id: uuid.UUID, section: str, principal: CurrentPrincipal, s: DB) -> Any:
    """One section of the run's results: profile, usage, rules, interfaces, configuration, documents,
    dictionary or gaps."""
    if section not in SECTIONS:
        raise not_found("Result section")
    r, t = _run(s, principal, run_id)
    if r.status != "succeeded":
        raise conflict(f"The discovery run is {r.status}.")
    return _section(t, r.id, section)


# ------------------------------------------------------------------ knowledge graph

@router.get("/discovery-runs/{run_id}/graph")
def graph(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB, kind: str | None = None, stream: str | None = None,
          q: str | None = None, unused: bool | None = None, offset: Annotated[int, Query(ge=0)] = 0,
          limit: Annotated[int, Query(ge=1, le=500)] = 100) -> dict[str, Any]:
    r, t = _run(s, principal, run_id)
    where, params = ["run_id = %s"], [r.id]
    if kind:
        where.append("kind = %s")
        params.append(kind)  # type: ignore[arg-type]
    if stream:
        where.append("stream = %s")
        params.append(stream)  # type: ignore[arg-type]
    if q:
        where.append("element ILIKE %s")
        params.append(f"%{q}%")  # type: ignore[arg-type]
    if unused is not None:
        where.append("COALESCE((usage->>'unused')::boolean, false) = %s")
        params.append(unused)  # type: ignore[arg-type]
    clause = " AND ".join(where)
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        total = tc.execute(f"SELECT count(*) FROM estate.kg_nodes WHERE {clause}", params).fetchone()
        rows = tc.execute("SELECT node_id, kind, stream, element, usage, concept, target, props FROM estate.kg_nodes "
                          f"WHERE {clause} ORDER BY stream, kind, element OFFSET %s LIMIT %s",
                          [*params, offset, limit]).fetchall()
        kinds = tc.execute("SELECT kind, stream, count(*) FROM estate.kg_nodes WHERE run_id = %s GROUP BY kind, stream "
                           "ORDER BY stream, kind", (r.id,)).fetchall()
    keys = ("id", "kind", "stream", "element", "usage", "concept", "target", "props")
    return {"total": total[0] if total else 0, "offset": offset,
            "counts": [{"kind": k, "stream": st, "nodes": n} for k, st, n in kinds],
            "streams": STREAM_TITLES, "nodes": [dict(zip(keys, row, strict=True)) for row in rows]}


@router.get("/discovery-runs/{run_id}/graph/nodes")
def node(run_id: uuid.UUID, node_id: str, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """One node with its edges in both directions and the names of the nodes at the other end."""
    r, t = _run(s, principal, run_id)
    with tenant_connection(t, get_vault()) as tc:
        n = tc.execute("SELECT node_id, kind, stream, element, usage, concept, target, props FROM estate.kg_nodes "
                       "WHERE run_id = %s AND node_id = %s", (r.id, node_id)).fetchone()
        if n is None:
            raise not_found("Node")
        out_e = tc.execute("SELECT e.kind, e.dst, n.element, n.kind, e.props FROM estate.kg_edges e LEFT JOIN "
                           "estate.kg_nodes n ON n.run_id = e.run_id AND n.node_id = e.dst WHERE e.run_id = %s AND "
                           "e.src = %s ORDER BY e.kind, n.element LIMIT 1000", (r.id, node_id)).fetchall()
        in_e = tc.execute("SELECT e.kind, e.src, n.element, n.kind, e.props FROM estate.kg_edges e LEFT JOIN "
                          "estate.kg_nodes n ON n.run_id = e.run_id AND n.node_id = e.src WHERE e.run_id = %s AND "
                          "e.dst = %s ORDER BY e.kind, n.element LIMIT 1000", (r.id, node_id)).fetchall()
    keys = ("id", "kind", "stream", "element", "usage", "concept", "target", "props")
    ek = ("type", "node_id", "element", "node_kind", "props")
    return {"node": dict(zip(keys, n, strict=True)), "outgoing": [dict(zip(ek, e, strict=True)) for e in out_e],
            "incoming": [dict(zip(ek, e, strict=True)) for e in in_e]}


# ------------------------------------------------------------------ coverage report (E08.F3.S1)

class ReportOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    discovery_run_id: uuid.UUID
    coverage_pct: int
    streams: list[dict[str, Any]]
    gaps: list[dict[str, Any]]
    waivers: list[dict[str, Any]]
    status: str
    blocking_open: list[str]
    decided_by: str | None
    decided_at: datetime | None
    decision_note: str | None
    created_at: datetime
    can_decide: bool


def _report_out(s: Session, principal: Principal, t: Tenant, r: CoverageReport) -> ReportOut:
    waived = {w["gap_id"] for w in r.waivers}
    open_blocking = [g["id"] for g in r.gaps if g["severity"] == "blocking" and g["id"] not in waived]
    u = s.get(User, r.decided_by) if r.decided_by else None
    return ReportOut(id=r.id, project_id=r.project_id, discovery_run_id=r.discovery_run_id,
                     coverage_pct=r.coverage_pct, streams=r.streams, gaps=r.gaps, waivers=r.waivers, status=r.status,
                     blocking_open=open_blocking, decided_by=u.display_name if u else None, decided_at=r.decided_at,
                     decision_note=r.decision_note, created_at=r.created_at,
                     can_decide=r.status == "draft" and principal.has_on_project(P.STAGE_MANAGE, t, r.project_id))


@router.get("/projects/{project_id}/coverage-reports", response_model=list[ReportOut])
def list_reports(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[ReportOut]:
    t, p = project_for(s, principal, project_id, None)
    return [_report_out(s, principal, t, r) for r in s.scalars(
        select(CoverageReport).where(CoverageReport.project_id == p.id).order_by(CoverageReport.created_at.desc()))]


def _report(s: Session, principal: Principal, report_id: uuid.UUID) -> tuple[CoverageReport, Tenant]:
    r = s.get(CoverageReport, report_id, with_for_update=True)
    if r is None:
        raise not_found("Coverage report")
    t, _ = project_for(s, principal, r.project_id, P.STAGE_MANAGE)
    return r, t


class WaiveIn(BaseModel):
    gap_id: str
    reason: str = Field(min_length=15, max_length=2000)


@router.post("/coverage-reports/{report_id}/waivers", response_model=ReportOut)
def waive(report_id: uuid.UUID, body: WaiveIn, principal: CurrentPrincipal, s: DB) -> ReportOut:
    """Accept a gap with a written reason, so it no longer blocks the report."""
    r, t = _report(s, principal, report_id)
    if r.status != "draft":
        raise conflict(f"The report is {r.status}.")
    if body.gap_id not in {g["id"] for g in r.gaps}:
        raise invalid("gap_id", "No such gap in this report.")
    if body.gap_id in {w["gap_id"] for w in r.waivers}:
        raise conflict("This gap is already waived.")
    r.waivers = [*r.waivers, {"gap_id": body.gap_id, "reason": body.reason.strip(), "by": principal.user.display_name,
                              "by_id": str(principal.user.id), "at": datetime.now(UTC).isoformat()}]
    audit.record(s, principal.actor, "discovery.gap_waived", tenant_id=t.id, project_id=r.project_id,
                 target_type="coverage_report", target_id=str(r.id), details={"gap": body.gap_id,
                                                                              "reason": body.reason.strip()})
    return _report_out(s, principal, t, r)


class DecideIn(BaseModel):
    accept: bool
    note: str = Field(min_length=10, max_length=2000)


@router.post("/coverage-reports/{report_id}/decision", response_model=ReportOut)
def decide(report_id: uuid.UUID, body: DecideIn, principal: CurrentPrincipal, s: DB) -> ReportOut:
    """Accept or reject the report. Accepting needs every blocking gap waived; the discovery stage gate then
    opens for this project."""
    r, t = _report(s, principal, report_id)
    if r.status != "draft":
        raise conflict(f"The report is {r.status}.")
    out = _report_out(s, principal, t, r)
    if body.accept and out.blocking_open:
        raise Problem(409, "gaps-open", "Blocking gaps remain", "Waive each blocking gap with a reason, or run "
                      "discovery again after closing it.", errors=[{"field": "gaps", "message": g}
                                                                   for g in out.blocking_open])
    if body.accept:
        for old in s.scalars(select(CoverageReport).where(CoverageReport.project_id == r.project_id,
                                                          CoverageReport.status == "accepted")):
            old.status = "superseded"
    r.status = "accepted" if body.accept else "rejected"
    r.decided_by, r.decided_at, r.decision_note = principal.user.id, datetime.now(UTC), body.note.strip()
    s.flush()
    audit.record(s, principal.actor, f"discovery.coverage_{r.status}", tenant_id=t.id, project_id=r.project_id,
                 target_type="coverage_report", target_id=str(r.id),
                 details={"coverage_pct": r.coverage_pct, "waivers": len(r.waivers), "note": body.note.strip()})
    return _report_out(s, principal, t, r)
