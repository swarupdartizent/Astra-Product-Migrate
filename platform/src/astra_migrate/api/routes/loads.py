"""Loads, validation, reconciliation, documents, parity and coexistence (E13, E14, E15.F1.S2)."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters.jobs import adapter_pack, content_of
from astra_migrate.adapters.target import TargetClient, target_pack
from astra_migrate.api.errors import conflict, forbidden, invalid, not_found
from astra_migrate.connector_secrets import SecretError, read_for_connector
from astra_migrate.db.control import get_session
from astra_migrate.db.models import (
    AdapterRun,
    CoexistenceSchedule,
    LoadRun,
    ParityRun,
    ReconBreak,
    SourceConnection,
    TargetConnection,
    Tenant,
    User,
)
from astra_migrate.jobs.runner import enqueue
from astra_migrate.loads import coexistence, documents, engine, parity
from astra_migrate.security.principal import CurrentPrincipal, Principal, project_for
from astra_migrate.security.rbac import P
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

router = APIRouter(tags=["loads"])
DB = Annotated[Session, Depends(get_session)]
FAILED = ("rejected", "invalid", "blocked")


def _name(s: Session, uid: uuid.UUID | None) -> str | None:
    u = s.get(User, uid) if uid else None
    return u.display_name if u else None


def _run_out(s: Session, r: LoadRun) -> dict[str, Any]:
    return {"id": str(r.id), "number": r.number, "kind": r.kind, "status": r.status,
            "status_detail": r.status_detail, "parent_run_id": str(r.parent_run_id) if r.parent_run_id else None,
            "extract_run_id": str(r.extract_run_id) if r.extract_run_id else None,
            "target_connection_id": str(r.target_connection_id) if r.target_connection_id else None,
            "segment": r.segment, "artifacts": r.artifacts, "packs": r.packs, "input_digest": r.input_digest,
            "result_digest": r.result_digest, "summary": r.summary, "job_id": str(r.job_id) if r.job_id else None,
            "requested_by": r.requested_by.get("name"),
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None}


def _run(s: Session, principal: Principal, run_id: uuid.UUID) -> tuple[Tenant, LoadRun]:
    r = s.get(LoadRun, run_id)
    if r is None:
        raise not_found("Load run")
    t, _ = project_for(s, principal, r.project_id, None)
    return t, r


# ------------------------------------------------------------------ load runs (E13.F1)

class Segment(BaseModel):
    column: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    values: list[str] = Field(min_length=1, max_length=100)


class LoadIn(BaseModel):
    kind: Literal["rehearsal", "load", "delta"]
    extract_run_id: uuid.UUID
    target_connection_id: uuid.UUID | None = None
    segment: Segment | None = Field(default=None, description="Load only rows whose column has one of the values")


@router.post("/projects/{project_id}/load-runs", status_code=201)
def start_load(project_id: uuid.UUID, body: LoadIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Start a numbered run with the approved transformation code, the pack versions and the extract pinned.
    A rehearsal transforms, validates and reconciles without sending anything."""
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    if body.kind != "rehearsal":
        if not principal.has_on_tenant(P.TARGET_LOAD, t):
            raise forbidden("You need permission to load into this tenant's target.")
        tc = s.get(TargetConnection, body.target_connection_id) if body.target_connection_id else None
        if tc is None or tc.tenant_id != t.id:
            raise invalid("target_connection_id", "Choose a target connection of this project's tenant.")
    elif body.target_connection_id is not None:
        raise invalid("target_connection_id", "A rehearsal sends nothing; leave the target connection empty.")
    if body.kind == "delta":
        ar = s.get(AdapterRun, body.extract_run_id)
        if ar is None or ar.mode != "delta":
            raise invalid("extract_run_id", "A delta load needs a delta extract (changes since the last extract).")
    if s.scalar(select(LoadRun.id).where(LoadRun.project_id == p.id,
                                         LoadRun.status.in_(("queued", "running")))) is not None:
        raise conflict("A load run is already running for this project")
    try:
        run = engine.start(s, t, p, body.kind, principal.actor, body.extract_run_id, body.target_connection_id,
                           body.segment.model_dump() if body.segment else None)
    except engine.LoadError as e:
        raise conflict("The load cannot start", str(e)) from e
    return _run_out(s, run)


@router.get("/projects/{project_id}/load-runs")
def list_loads(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    _, p = project_for(s, principal, project_id, None)
    return [_run_out(s, r) for r in s.scalars(select(LoadRun).where(LoadRun.project_id == p.id)
                                              .order_by(LoadRun.number.desc()).limit(100))]


@router.get("/load-runs/{run_id}")
def get_load(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, r = _run(s, principal, run_id)
    out = _run_out(s, r)
    out["can_load"] = principal.has_on_tenant(P.TARGET_LOAD, t)
    out["can_triage"] = principal.has_on_project(P.REVIEW_RESOLVE, t, r.project_id)
    return out


@router.get("/load-runs/{run_id}/records")
def records(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB, status: str | None = None,
            table: str | None = None, triage: str | None = None, owner: str | None = None,
            q: Annotated[str | None, Query(max_length=200)] = None, errors_only: bool = True,
            offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 100
            ) -> dict[str, Any]:
    """The run's records. By default the error queue: records the target rejected, validation stopped, or that
    could not be sent."""
    t, r = _run(s, principal, run_id)
    where: list[str] = ["run_id = %s"]
    params: list[Any] = [r.id]
    if status:
        where.append("status = %s")
        params.append(status)
    elif errors_only:
        where.append("status = ANY(%s)")
        params.append(list(FAILED))
    for col, val in (("target_table", table), ("triage", triage), ("owner", owner)):
        if val:
            where.append(f"{col} = %s")
            params.append(val)
    if q:
        where.append("(record_key ILIKE %s OR reason ILIKE %s)")
        params += [f"%{q}%", f"%{q}%"]
    clause = " AND ".join(where)
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        total = tc.execute(f"SELECT count(*) FROM estate.load_records WHERE {clause}", params).fetchone()
        rows = tc.execute(
            f"SELECT target_table, record_key, source_key, segment, payload, status, http_status, reason, failures, "
            f"owner, triage, fixed_payload, note FROM estate.load_records WHERE {clause} ORDER BY target_table, "
            f"record_key OFFSET %s LIMIT %s", [*params, offset, limit]).fetchall()
        facets = dict(tc.execute("SELECT status, count(*) FROM estate.load_records WHERE run_id = %s GROUP BY status",
                                 (r.id,)).fetchall())
    keys = ("table", "key", "source_key", "segment", "payload", "status", "http_status", "reason", "failures",
            "owner", "triage", "fixed_payload", "note")
    return {"items": [dict(zip(keys, x, strict=True)) for x in rows], "total": total[0] if total else 0,
            "by_status": facets}


class TriageIn(BaseModel):
    table: str
    key: str
    owner: str | None = Field(default=None, max_length=200)
    triage: Literal["open", "fixed", "wont_fix"] | None = None
    fixed_payload: dict[str, Any] | None = None
    note: str | None = Field(default=None, max_length=2000)


@router.patch("/load-runs/{run_id}/records")
def triage_record(run_id: uuid.UUID, body: TriageIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, r = _run(s, principal, run_id)
    if not principal.has_on_project(P.REVIEW_RESOLVE, t, r.project_id):
        raise forbidden("You cannot work the error queue on this project.")
    if body.triage == "wont_fix" and len((body.note or "").strip()) < 10:
        raise invalid("note", "Say why the record will not be fixed (at least 10 characters).")
    try:
        with tenant_connection(t, get_vault()) as tc, tc.transaction():
            engine.triage(tc, r.id, body.table, body.key, body.owner, body.triage, body.fixed_payload, body.note)
    except engine.LoadError as e:
        raise invalid("key", str(e)) from e
    audit.record(s, principal.actor, "load.record_triaged", tenant_id=t.id, project_id=r.project_id,
                 target_type="load_run", target_id=str(r.id),
                 details={"table": body.table, "key": body.key, "owner": body.owner, "triage": body.triage,
                          "fixed": body.fixed_payload is not None})
    return {"ok": True}


class ReloadIn(BaseModel):
    records: list[dict[str, str]] = Field(min_length=1, max_length=5000, description="[{table, key}]")


@router.post("/load-runs/{run_id}/reload", status_code=201)
def reload(run_id: uuid.UUID, body: ReloadIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Reload only the chosen failed records (their fixed payload when one was entered) as a new numbered run with
    the same approved code."""
    t, r = _run(s, principal, run_id)
    if not principal.has_on_tenant(P.TARGET_LOAD, t) or not principal.has_on_project(P.STAGE_MANAGE, t, r.project_id):
        raise forbidden("You need permission to load into this tenant's target.")
    if r.kind == "rehearsal" or r.target_connection_id is None:
        raise conflict("Nothing to reload", "A rehearsal sends nothing; start a load instead.")
    with tenant_connection(t, get_vault()) as tc:
        found = {(a, b) for a, b in tc.execute(
            "SELECT target_table, record_key FROM estate.load_records WHERE run_id = %s AND status = ANY(%s)",
            (r.id, list(FAILED))).fetchall()}
    keys = []
    for rec in body.records:
        if (rec.get("table"), rec.get("key")) not in found:
            raise invalid("records", f"{rec.get('table')} {rec.get('key')} is not a failed record of this run.")
        keys.append({"run_id": str(r.id), "table": rec["table"], "key": rec["key"]})
    from astra_migrate.db.models import Project

    p = s.get(Project, r.project_id)
    assert p is not None
    try:
        new = engine.start(s, t, p, "reload", principal.actor, None, r.target_connection_id, None, parent=r,
                           reload_keys=keys)
    except engine.LoadError as e:
        raise conflict("The reload cannot start", str(e)) from e
    with tenant_connection(t, get_vault()) as tc, tc.transaction():
        for k in keys:
            tc.execute("UPDATE estate.load_records SET triage = 'reloaded', note = COALESCE(note, '') || %s WHERE "
                       "run_id = %s AND target_table = %s AND record_key = %s",
                       (f" Reloaded in run {new.number}.", r.id, k["table"], k["key"]))
    return _run_out(s, new)


# ------------------------------------------------------------------ documents (E13.F2.S2)

@router.post("/load-runs/{run_id}/document-checks")
def check_documents(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, r = _run(s, principal, run_id)
    if not principal.has_on_project(P.STAGE_MANAGE, t, r.project_id):
        raise forbidden("You cannot run document checks on this project.")
    if r.status != "succeeded" or r.extract_run_id is None:
        raise conflict("Nothing to check", "Document checks run on a finished load with an extract.")
    bp = engine.approved_blueprint(s, r.project_id)
    ar = s.get(AdapterRun, r.extract_run_id)
    conn = s.get(SourceConnection, ar.connection_id) if ar else None
    content = content_of(adapter_pack(s, conn.adapter)) if conn else None
    ents = {e.table.lower(): e.name for e in getattr(content, "entities", [])}
    with tenant_connection(t, get_vault()) as tc:
        tables = {}
        for a in r.artifacts:
            row = tc.execute("SELECT inputs FROM estate.build_code WHERE artifact_id = %s",
                             (uuid.UUID(a["id"]),)).fetchone()
            if row and row[0]["source_table"].lower() in ents:
                tables[ents[row[0]["source_table"].lower()]] = row[0]["target_table"].lower()
    runs = [x.id for x in s.scalars(select(LoadRun).where(LoadRun.project_id == r.project_id,
                                                          LoadRun.number <= r.number))]
    client, tcontent = None, None
    if r.target_connection_id:
        tconn = s.get(TargetConnection, r.target_connection_id)
        assert tconn is not None
        _pk, tcontent = target_pack(s, tconn.adapter)
        try:
            secret = read_for_connector(s, get_vault(), t, tconn.client_secret_ref, f"target:{tconn.name}")
            client = TargetClient(tconn, tcontent, secret)
        except SecretError as e:
            raise conflict("The target connection's secret cannot be read", str(e)) from e
    with tenant_connection(t, get_vault()) as tc:
        res = documents.check(tc, r.id, r.extract_run_id, runs, tables,
                              bp.documents.retrieval_sample_size if bp else 200, client, tcontent)
    summary = dict(r.summary)
    summary["documents"] = res
    r.summary = summary
    audit.record(s, principal.actor, "load.documents_checked", tenant_id=t.id, project_id=r.project_id,
                 target_type="load_run", target_id=str(r.id), details=res)
    return res


@router.get("/load-runs/{run_id}/document-checks")
def document_checks(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB, status: str | None = None,
                    offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 100
                    ) -> dict[str, Any]:
    t, r = _run(s, principal, run_id)
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        params: list[Any] = [r.id]
        clause = "run_id = %s" + (" AND status = %s" if status else "")
        if status:
            params.append(status)
        rows = tc.execute(f"SELECT doc_key, link_entity, link_key, status, detail FROM estate.document_checks WHERE "
                          f"{clause} ORDER BY status, doc_key OFFSET %s LIMIT %s", [*params, offset, limit]).fetchall()
        total = tc.execute(f"SELECT count(*) FROM estate.document_checks WHERE {clause}", params).fetchone()
    return {"items": [dict(zip(("doc_key", "entity", "link_key", "status", "detail"), x, strict=True))
                      for x in rows], "total": total[0] if total else 0, "summary": r.summary.get("documents")}


# ------------------------------------------------------------------ reconciliation breaks (E14.F1.S2, E15.F1.S2)

def _break_out(s: Session, b: ReconBreak) -> dict[str, Any]:
    return {"id": str(b.id), "origin": b.origin, "load_run_id": str(b.load_run_id) if b.load_run_id else None,
            "scope": b.scope, "measure": b.measure,
            "source_value": str(b.source_value) if b.source_value is not None else None,
            "target_value": str(b.target_value) if b.target_value is not None else None,
            "difference": str(b.difference) if b.difference is not None else None, "detail": b.detail,
            "owner_role": b.owner_role, "owner_user_id": str(b.owner_user_id) if b.owner_user_id else None,
            "owner": _name(s, b.owner_user_id), "status": b.status, "close_reason": b.close_reason,
            "closed_by": _name(s, b.closed_by), "closed_at": b.closed_at.isoformat() if b.closed_at else None,
            "created_at": b.created_at.isoformat() if b.created_at else None}


@router.get("/projects/{project_id}/recon-breaks")
def list_breaks(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
                origin: Literal["load", "coexistence"] | None = None, status: Literal["open", "closed"] | None = None,
                load_run_id: uuid.UUID | None = None) -> list[dict[str, Any]]:
    _, p = project_for(s, principal, project_id, None)
    stmt = select(ReconBreak).where(ReconBreak.project_id == p.id)
    for col, val in ((ReconBreak.origin, origin), (ReconBreak.status, status), (ReconBreak.load_run_id, load_run_id)):
        if val is not None:
            stmt = stmt.where(col == val)
    return [_break_out(s, b) for b in s.scalars(stmt.order_by(ReconBreak.created_at.desc()).limit(500))]


class BreakIn(BaseModel):
    owner_user_id: uuid.UUID | None = None
    close_reason: str | None = Field(default=None, min_length=10, max_length=4000)


@router.patch("/recon-breaks/{break_id}")
def update_break(break_id: uuid.UUID, body: BreakIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    b = s.get(ReconBreak, break_id, with_for_update=True)
    if b is None:
        raise not_found("Break")
    t, _ = project_for(s, principal, b.project_id, P.REVIEW_RESOLVE)
    if b.status == "closed":
        raise conflict("The break is closed")
    if body.owner_user_id is not None:
        u = s.get(User, body.owner_user_id)
        if u is None or u.kind != "person" or not u.is_active:
            raise invalid("owner_user_id", "Choose an active person.")
        b.owner_user_id = u.id
    if body.close_reason:
        if b.owner_user_id is None:
            raise invalid("owner_user_id", "A break has an owner until it is closed: name one first.")
        b.status, b.close_reason, b.closed_by, b.closed_at = ("closed", body.close_reason.strip(), principal.user.id,
                                                              datetime.now(UTC))
    s.flush()
    audit.record(s, principal.actor, "recon.break_updated", tenant_id=t.id, project_id=b.project_id,
                 target_type="recon_break", target_id=str(b.id),
                 details={"owner": str(b.owner_user_id) if b.owner_user_id else None, "status": b.status,
                          "reason": b.close_reason, "measure": b.measure, "scope": b.scope})
    return _break_out(s, b)


# ------------------------------------------------------------------ parity (E14.F2.S1, S3, S4)

class FileIn(BaseModel):
    name: str = Field(min_length=5, max_length=200, pattern=r"(?i)\.(csv|json)$")
    content_base64: str = Field(max_length=60 * 1024 * 1024)


class ParityIn(BaseModel):
    kind: Literal["rating", "report", "workflow", "period_close"]
    name: str = Field(min_length=3, max_length=200)
    spec: parity.Spec
    source: FileIn
    target: FileIn


def _file(f: FileIn, field: str) -> tuple[bytes, list[dict[str, Any]]]:
    try:
        data = base64.b64decode(f.content_base64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise invalid(field, "The file is not valid base64.") from e
    try:
        return data, parity.parse(data, f.name)
    except parity.ParityInputError as e:
        raise invalid(field, str(e)) from e


def _parity_out(s: Session, r: ParityRun) -> dict[str, Any]:
    return {"id": str(r.id), "kind": r.kind, "name": r.name, "spec": r.spec, "summary": r.summary,
            "source_sha256": r.source_sha256, "target_sha256": r.target_sha256, "created_by": _name(s, r.created_by),
            "created_at": r.created_at.isoformat() if r.created_at else None}


@router.post("/projects/{project_id}/parity-runs", status_code=201)
def start_parity(project_id: uuid.UUID, body: ParityIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    sb, src = _file(body.source, "source")
    tb, tgt = _file(body.target, "target")
    try:
        cases, summary = parity.compare(body.kind, body.spec, src, tgt)
    except parity.ParityInputError as e:
        raise invalid("spec", str(e)) from e
    run = ParityRun(tenant_id=t.id, project_id=p.id, kind=body.kind, name=body.name.strip(),
                    spec=body.spec.model_dump(), summary={**summary, "open": len(cases), "passed": not cases},
                    source_sha256=hashlib.sha256(sb).hexdigest(), target_sha256=hashlib.sha256(tb).hexdigest(),
                    created_by=principal.user.id)
    s.add(run)
    s.flush()
    with tenant_connection(t, get_vault()) as tc, tc.transaction(), tc.cursor() as cur:
        migrate_tenant_schema(tc)
        cur.executemany("INSERT INTO estate.parity_cases(run_id, case_key, kind, field, source_value, target_value, "
                        "inputs) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        [(run.id, c.key, c.kind, c.field, c.source, c.target, json.dumps(c.inputs, default=str))
                         for c in cases])
    audit.record(s, principal.actor, "parity.run", tenant_id=t.id, project_id=p.id, target_type="parity_run",
                 target_id=str(run.id), details={"kind": body.kind, "name": run.name, **summary,
                                                 "source_sha256": run.source_sha256,
                                                 "target_sha256": run.target_sha256})
    return _parity_out(s, run)


@router.get("/projects/{project_id}/parity-runs")
def list_parity(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
                kind: Literal["rating", "report", "workflow", "period_close"] | None = None) -> list[dict[str, Any]]:
    _, p = project_for(s, principal, project_id, None)
    stmt = select(ParityRun).where(ParityRun.project_id == p.id)
    if kind:
        stmt = stmt.where(ParityRun.kind == kind)
    return [_parity_out(s, r) for r in s.scalars(stmt.order_by(ParityRun.created_at.desc()).limit(100))]


def _parity(s: Session, principal: Principal, run_id: uuid.UUID) -> tuple[Tenant, ParityRun]:
    r = s.get(ParityRun, run_id)
    if r is None:
        raise not_found("Parity run")
    t, _ = project_for(s, principal, r.project_id, None)
    return t, r


@router.get("/parity-runs/{run_id}/cases")
def parity_cases(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB, status: str | None = None,
                 offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 100
                 ) -> dict[str, Any]:
    t, r = _parity(s, principal, run_id)
    params: list[Any] = [r.id]
    clause = "run_id = %s" + (" AND status = %s" if status else "")
    if status:
        params.append(status)
    with tenant_connection(t, get_vault()) as tc:
        rows = tc.execute(f"SELECT case_key, kind, field, source_value, target_value, inputs, status, decided_by, "
                          f"decided_at, note FROM estate.parity_cases WHERE {clause} ORDER BY case_key, field "
                          f"OFFSET %s LIMIT %s", [*params, offset, limit]).fetchall()
        total = tc.execute(f"SELECT count(*) FROM estate.parity_cases WHERE {clause}", params).fetchone()
    keys = ("key", "kind", "field", "source_value", "target_value", "inputs", "status", "decided_by", "decided_at",
            "note")
    return {"run": _parity_out(s, r), "total": total[0] if total else 0,
            "items": [{**dict(zip(keys, x, strict=True)),
                       "decided_at": x[8].isoformat() if x[8] else None} for x in rows],
            "can_decide": principal.has_on_project(P.REVIEW_RESOLVE, t, r.project_id)}


class CaseRef(BaseModel):
    key: str
    field: str


class CasesIn(BaseModel):
    cases: list[CaseRef] = Field(min_length=1, max_length=1000)
    action: Literal["approve", "fixed"]
    note: str = Field(min_length=10, max_length=2000)


@router.post("/parity-runs/{run_id}/cases/decide")
def decide_cases(run_id: uuid.UUID, body: CasesIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Approve a difference (the approver is recorded) or mark it fixed in the target. A parity run passes when no
    difference is open."""
    t, r = _parity(s, principal, run_id)
    if not principal.has_on_project(P.REVIEW_RESOLVE, t, r.project_id):
        raise forbidden("You cannot decide parity differences on this project.")
    with tenant_connection(t, get_vault()) as tc, tc.transaction():
        n = 0
        for c in body.cases:
            cur = tc.execute("UPDATE estate.parity_cases SET status = %s, decided_by = %s, decided_at = now(), "
                             "note = %s WHERE run_id = %s AND case_key = %s AND field = %s AND status = 'open'",
                             ("approved" if body.action == "approve" else "fixed", principal.user.display_name,
                              body.note.strip(), r.id, c.key, c.field))
            n += cur.rowcount
        left = tc.execute("SELECT count(*) FROM estate.parity_cases WHERE run_id = %s AND status = 'open'",
                          (r.id,)).fetchone()
    open_n = int(left[0]) if left else 0
    r.summary = {**r.summary, "open": open_n, "passed": open_n == 0}
    audit.record(s, principal.actor, f"parity.{body.action}", tenant_id=t.id, project_id=r.project_id,
                 target_type="parity_run", target_id=str(r.id),
                 details={"cases": [c.model_dump() for c in body.cases], "note": body.note.strip(), "decided": n})
    return {"decided": n, "open": open_n, "passed": open_n == 0}


# ------------------------------------------------------------------ coexistence (E15.F1.S2)

class ScheduleIn(BaseModel):
    connection_id: uuid.UUID
    owner_user_id: uuid.UUID
    hour_utc: int = Field(ge=0, le=23)
    enabled: bool = True


def _schedule_out(s: Session, sch: CoexistenceSchedule | None) -> dict[str, Any] | None:
    if sch is None:
        return None
    return {"connection_id": str(sch.connection_id), "owner_user_id": str(sch.owner_user_id),
            "owner": _name(s, sch.owner_user_id), "hour_utc": sch.hour_utc, "enabled": sch.enabled,
            "last_run_at": sch.last_run_at.isoformat() if sch.last_run_at else None,
            "next_run_at": sch.next_run_at.isoformat() if sch.next_run_at else None}


@router.put("/projects/{project_id}/coexistence-schedule")
def set_schedule(project_id: uuid.UUID, body: ScheduleIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    c = s.get(SourceConnection, body.connection_id)
    if c is None or c.tenant_id != t.id:
        raise invalid("connection_id", "Choose a source connection of this project's tenant.")
    u = s.get(User, body.owner_user_id)
    if u is None or u.kind != "person" or not u.is_active:
        raise invalid("owner_user_id", "Breaks go to a named person: choose an active person.")
    sch = s.get(CoexistenceSchedule, p.id)
    nxt = coexistence.next_run(body.hour_utc, datetime.now(UTC))
    if sch is None:
        sch = CoexistenceSchedule(project_id=p.id, tenant_id=t.id, connection_id=c.id, enabled=body.enabled,
                                  hour_utc=body.hour_utc, owner_user_id=u.id, next_run_at=nxt,
                                  updated_by=principal.user.id)
        s.add(sch)
    else:
        sch.connection_id, sch.enabled, sch.hour_utc, sch.owner_user_id = c.id, body.enabled, body.hour_utc, u.id
        sch.next_run_at, sch.updated_by = nxt, principal.user.id
    s.flush()
    audit.record(s, principal.actor, "coexistence.schedule_set", tenant_id=t.id, project_id=p.id,
                 target_type="project", target_id=str(p.id),
                 details={"hour_utc": body.hour_utc, "enabled": body.enabled, "owner": str(u.id)})
    return _schedule_out(s, sch) or {}


@router.post("/projects/{project_id}/coexistence-reconcile", status_code=202)
def reconcile_now(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    if s.get(CoexistenceSchedule, p.id) is None:
        raise conflict("No schedule", "Set the coexistence schedule first: it names the owner of the breaks.")
    job = enqueue(s, "coexistence.reconcile", f"Coexistence reconciliation for {p.name}", principal.actor,
                  {"project_id": str(p.id)}, tenant_id=t.id, project_id=p.id)
    return {"job_id": str(job.id)}


@router.get("/projects/{project_id}/coexistence")
def coexistence_dashboard(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    with tenant_connection(t, get_vault()) as tc:
        rules = [{"key": k, **b} for k, b in tc.execute(
            "SELECT key, body FROM estate.plan_items WHERE project_id = %s AND kind = 'coexistence' ORDER BY key",
            (p.id,)).fetchall()]
    open_breaks = [_break_out(s, b) for b in s.scalars(select(ReconBreak).where(
        ReconBreak.project_id == p.id, ReconBreak.origin == "coexistence", ReconBreak.status == "open")
        .order_by(ReconBreak.created_at.desc()))]
    return {"rules": rules, "schedule": _schedule_out(s, s.get(CoexistenceSchedule, p.id)),
            "open_breaks": open_breaks, "can_manage": principal.has_on_project(P.STAGE_MANAGE, t, p.id),
            "can_close": principal.has_on_project(P.REVIEW_RESOLVE, t, p.id)}
