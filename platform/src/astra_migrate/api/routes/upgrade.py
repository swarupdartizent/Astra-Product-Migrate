"""Version delta, migration pattern advice, code conversion with recorded tests, and the hosting checklist
(E09, E10)."""

from __future__ import annotations

import csv
import io
import json
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit, checklist
from astra_migrate.api.errors import conflict, forbidden, invalid, not_found
from astra_migrate.conversion.jobs import supported
from astra_migrate.db.control import get_session
from astra_migrate.db.models import (
    AdapterRun,
    ChecklistItem,
    ConversionRun,
    DeltaRun,
    ProjectBaseline,
    SourceConnection,
    TargetBaseline,
    Tenant,
    User,
)
from astra_migrate.delta.engine import GROUPS, DeltaResult, advise_pattern
from astra_migrate.delta.jobs import latest_pattern
from astra_migrate.jobs.runner import actor_dict, enqueue
from astra_migrate.packs.schema import parse_ref
from astra_migrate.security.principal import CurrentPrincipal, Principal, project_for
from astra_migrate.security.rbac import P
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

router = APIRouter(tags=["upgrade"])
DB = Annotated[Session, Depends(get_session)]
ORIGINS = ("standard", "customized_standard", "customer_specific", "unknown")


def _user(s: Session, uid: uuid.UUID | None) -> str | None:
    u = s.get(User, uid) if uid else None
    return u.display_name if u else None


def _source_ready(s: Session, t: Tenant, project_id: uuid.UUID, connection_id: uuid.UUID
                  ) -> tuple[SourceConnection, TargetBaseline]:
    c = s.get(SourceConnection, connection_id)
    if c is None or c.tenant_id != t.id:
        raise invalid("connection_id", "Choose a source connection of this project's tenant.")
    if s.scalar(select(AdapterRun.id).where(AdapterRun.connection_id == c.id, AdapterRun.kind == "check",
                                            AdapterRun.status == "succeeded")) is None:
        raise conflict("Check the connection first", "This starts only after a connection check has proved the "
                                                      "account is read-only.")
    pin = s.get(ProjectBaseline, project_id)
    b = s.get(TargetBaseline, pin.baseline_id) if pin else None
    if b is None:
        raise conflict("Pin a target baseline first", "The project has no target baseline to compare with.")
    return c, b


# ------------------------------------------------------------------ version delta (E09.F1)

class DeltaIn(BaseModel):
    connection_id: uuid.UUID
    standard_baseline_id: uuid.UUID | None = Field(
        default=None, description="The source product's standard baseline for the customer's version, to tell "
                                  "standard objects from customized and customer-specific ones")


class DeltaOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    connection_id: uuid.UUID
    connection_name: str | None
    baseline: str
    standard_baseline: str | None
    status: str
    status_detail: str | None
    counts: dict[str, Any]
    origin_counts: dict[str, Any]
    not_in_scope: int
    new_in_target: int
    input_digest: str | None
    result_digest: str | None
    advice: dict[str, Any]
    job_id: uuid.UUID | None
    requested_by: str
    created_at: datetime
    finished_at: datetime | None


def _baseline_label(s: Session, bid: uuid.UUID | None) -> str | None:
    b = s.get(TargetBaseline, bid) if bid else None
    return f"{b.adapter_name} / {b.name} ({b.product_version})" if b else None


def _delta_out(s: Session, r: DeltaRun) -> DeltaOut:
    c = s.get(SourceConnection, r.connection_id)
    return DeltaOut(id=r.id, project_id=r.project_id, connection_id=r.connection_id,
                    connection_name=c.name if c else None, baseline=_baseline_label(s, r.baseline_id) or "",
                    standard_baseline=_baseline_label(s, r.standard_baseline_id), status=r.status,
                    status_detail=r.status_detail, counts=r.counts, origin_counts=r.origin_counts,
                    not_in_scope=r.not_in_scope, new_in_target=r.new_in_target, input_digest=r.input_digest,
                    result_digest=r.result_digest, advice=r.advice, job_id=r.job_id,
                    requested_by=str(r.requested_by.get("name", "")), created_at=r.created_at,
                    finished_at=r.finished_at)


@router.post("/projects/{project_id}/delta-runs", response_model=DeltaOut, status_code=202)
def start_delta(project_id: uuid.UUID, body: DeltaIn, principal: CurrentPrincipal, s: DB) -> DeltaOut:
    """Compare the source estate with the project's pinned target baseline."""
    t, p = project_for(s, principal, project_id, None)
    if not principal.has_on_tenant(P.SOURCE_MANAGE, t):
        raise forbidden("You need permission to read this tenant's sources.")
    c, b = _source_ready(s, t, p.id, body.connection_id)
    if body.standard_baseline_id:
        std = s.get(TargetBaseline, body.standard_baseline_id)
        if std is None or std.adapter_name != parse_ref(c.adapter)[0]:
            raise invalid("standard_baseline_id", "Choose a baseline registered for the source adapter "
                                                  f"{parse_ref(c.adapter)[0]}.")
    if s.scalar(select(DeltaRun.id).where(DeltaRun.project_id == p.id,
                                          DeltaRun.status.in_(("queued", "running")))) is not None:
        raise conflict("A version delta is already running for this project")
    run = DeltaRun(tenant_id=t.id, project_id=p.id, connection_id=c.id, baseline_id=b.id,
                   standard_baseline_id=body.standard_baseline_id, status="queued", counts={}, origin_counts={},
                   not_in_scope=0, new_in_target=0, advice={}, requested_by=actor_dict(principal.actor))
    s.add(run)
    s.flush()
    job = enqueue(s, "delta.run", f"Version delta of {c.name} for {p.name}", principal.actor,
                  {"run_id": str(run.id)}, tenant_id=t.id, project_id=p.id)
    run.job_id = job.id
    audit.record(s, principal.actor, "delta.run_requested", tenant_id=t.id, project_id=p.id, target_type="delta_run",
                 target_id=str(run.id), details={"connection": c.name, "baseline": b.name,
                                                 "standard_baseline": str(body.standard_baseline_id or "")})
    return _delta_out(s, run)


@router.get("/projects/{project_id}/delta-runs", response_model=list[DeltaOut])
def list_delta(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[DeltaOut]:
    _, p = project_for(s, principal, project_id, None)
    return [_delta_out(s, r) for r in s.scalars(select(DeltaRun).where(DeltaRun.project_id == p.id)
                                                .order_by(DeltaRun.created_at.desc()).limit(50))]


def _delta(s: Session, principal: Principal, run_id: uuid.UUID, done: bool = False) -> tuple[DeltaRun, Tenant]:
    r = s.get(DeltaRun, run_id)
    if r is None:
        raise not_found("Delta run")
    t, _ = project_for(s, principal, r.project_id, None)
    if done and r.status != "succeeded":
        raise conflict(f"The delta run is {r.status}.")
    return r, t


@router.get("/delta-runs/{run_id}", response_model=DeltaOut)
def get_delta(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> DeltaOut:
    r, _ = _delta(s, principal, run_id)
    return _delta_out(s, r)


DIFF_KEYS = ("group", "type", "source", "target", "origin", "details")


@router.get("/delta-runs/{run_id}/differences")
def differences(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB, group: str | None = None,
                origin: str | None = None, type: str | None = None, q: str | None = None,
                offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 100
                ) -> dict[str, Any]:
    r, t = _delta(s, principal, run_id, done=True)
    if group and group not in GROUPS:
        raise invalid("group", f"Use one of: {', '.join(GROUPS)}.")
    where, params = ["run_id = %s"], [r.id]
    for col, val in (("grp", group), ("origin", origin), ("type", type)):
        if val:
            where.append(f"{col} = %s")
            params.append(val)  # type: ignore[arg-type]
    if q:
        where.append("(source ILIKE %s OR COALESCE(target, '') ILIKE %s)")
        params += [f"%{q}%", f"%{q}%"]  # type: ignore[list-item]
    clause = " AND ".join(where)
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        total = tc.execute(f"SELECT count(*) FROM estate.delta_differences WHERE {clause}", params).fetchone()
        rows = tc.execute(f"SELECT grp, type, source, target, origin, details FROM estate.delta_differences "
                          f"WHERE {clause} ORDER BY seq OFFSET %s LIMIT %s", [*params, offset, limit]).fetchall()
    return {"total": total[0] if total else 0, "offset": offset, "groups": list(GROUPS),
            "items": [dict(zip(DIFF_KEYS, row, strict=True)) for row in rows]}


@router.get("/delta-runs/{run_id}/lists")
def delta_lists(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Objects the baseline does not describe (not_in_scope), target objects with no source counterpart
    (new_in_target), and problems reading the source."""
    r, t = _delta(s, principal, run_id, done=True)
    with tenant_connection(t, get_vault()) as tc:
        rows = tc.execute("SELECT section, payload FROM estate.delta_lists WHERE run_id = %s", (r.id,)).fetchall()
    out: dict[str, Any] = {"not_in_scope": [], "new_in_target": [], "problems": []}
    out.update({k: v for k, v in rows})
    return out


@router.get("/delta-runs/{run_id}/export")
def export_delta(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
                 format: Literal["csv", "json"] = "csv") -> Response:
    """Every difference, in a stable order, as CSV or JSON. The result digest identifies the content."""
    r, t = _delta(s, principal, run_id, done=True)
    with tenant_connection(t, get_vault()) as tc:
        rows = tc.execute("SELECT grp, type, source, target, origin, details FROM estate.delta_differences "
                          "WHERE run_id = %s ORDER BY seq", (r.id,)).fetchall()
        lists = dict(tc.execute("SELECT section, payload FROM estate.delta_lists WHERE run_id = %s",
                                (r.id,)).fetchall())
    audit.record(s, principal.actor, "delta.exported", tenant_id=t.id, project_id=r.project_id,
                 target_type="delta_run", target_id=str(r.id), details={"format": format, "rows": len(rows)})
    name = f"version-delta-{r.id}.{format}"
    headers = {"Content-Disposition": f'attachment; filename="{name}"', "X-Result-Digest": r.result_digest or ""}
    if format == "json":
        body = {"run_id": str(r.id), "baseline": _baseline_label(s, r.baseline_id),
                "standard_baseline": _baseline_label(s, r.standard_baseline_id), "input_digest": r.input_digest,
                "result_digest": r.result_digest, "counts": r.counts, "origin_counts": r.origin_counts,
                "differences": [dict(zip(DIFF_KEYS, row, strict=True)) for row in rows],
                "not_in_scope": lists.get("not_in_scope", []), "new_in_target": lists.get("new_in_target", [])}
        return Response(json.dumps(body, indent=2, sort_keys=True), media_type="application/json", headers=headers)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["group", "type", "source", "target", "origin", "details"])
    for row in rows:
        w.writerow([row[0], row[1], row[2], row[3] or "", row[4], json.dumps(row[5], sort_keys=True)])
    for x in lists.get("not_in_scope", []):
        w.writerow(["not_in_scope", x.split(":", 1)[0], x.split(":", 1)[1], "", "", ""])
    for x in lists.get("new_in_target", []):
        w.writerow(["new_in_target", x.split(":", 1)[0], "", x.split(":", 1)[1], "", ""])
    return Response(buf.getvalue(), media_type="text/csv", headers=headers)


@router.get("/projects/{project_id}/pattern-advice")
def pattern_advice(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """The planner's view on the blueprint's migration pattern, from the newest successful version delta
    (E09.F2.S1)."""
    _, p = project_for(s, principal, project_id, None)
    r = s.scalars(select(DeltaRun).where(DeltaRun.project_id == p.id, DeltaRun.status == "succeeded")
                  .order_by(DeltaRun.created_at.desc())).first()
    chosen = latest_pattern(s, p.id)
    delta = None
    if r is not None:
        delta = DeltaResult([], [], [], r.input_digest or "", r.result_digest or "",
                            {g: int(r.counts.get(g, 0)) for g in GROUPS}, r.origin_counts,
                            r.standard_baseline_id is not None)
    return {**advise_pattern(chosen, delta), "delta_run_id": str(r.id) if r else None}


# ------------------------------------------------------------------ conversion (E10.F1)

class ConversionIn(BaseModel):
    connection_id: uuid.UUID
    target_dialect: Literal["sqlserver"] = "sqlserver"


class ConversionOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    connection_id: uuid.UUID
    connection_name: str | None
    baseline: str
    source_dialect: str
    target_dialect: str
    status: str
    status_detail: str | None
    summary: dict[str, Any]
    job_id: uuid.UUID | None
    requested_by: str
    created_at: datetime
    finished_at: datetime | None


def _conv_out(s: Session, r: ConversionRun) -> ConversionOut:
    c = s.get(SourceConnection, r.connection_id)
    return ConversionOut(id=r.id, project_id=r.project_id, connection_id=r.connection_id,
                         connection_name=c.name if c else None, baseline=_baseline_label(s, r.baseline_id) or "",
                         source_dialect=r.source_dialect, target_dialect=r.target_dialect, status=r.status,
                         status_detail=r.status_detail, summary=r.summary, job_id=r.job_id,
                         requested_by=str(r.requested_by.get("name", "")), created_at=r.created_at,
                         finished_at=r.finished_at)


@router.post("/projects/{project_id}/conversion-runs", response_model=ConversionOut, status_code=202)
def start_conversion(project_id: uuid.UUID, body: ConversionIn, principal: CurrentPrincipal, s: DB
                     ) -> ConversionOut:
    """Convert the source's code to the target dialect, compile it on the workbench and run the recorded tests."""
    t, p = project_for(s, principal, project_id, None)
    if not principal.has_on_tenant(P.SOURCE_MANAGE, t):
        raise forbidden("You need permission to read this tenant's sources.")
    c, b = _source_ready(s, t, p.id, body.connection_id)
    if not supported(c.engine, body.target_dialect):
        raise invalid("target_dialect", f"Conversion from {c.engine} to {body.target_dialect} is not supported.")
    if s.scalar(select(ConversionRun.id).where(ConversionRun.project_id == p.id,
                                               ConversionRun.status.in_(("queued", "running")))) is not None:
        raise conflict("A conversion is already running for this project")
    run = ConversionRun(tenant_id=t.id, project_id=p.id, connection_id=c.id, baseline_id=b.id,
                        source_dialect=c.engine, target_dialect=body.target_dialect, status="queued", summary={},
                        requested_by=actor_dict(principal.actor))
    s.add(run)
    s.flush()
    job = enqueue(s, "conversion.run", f"Code conversion of {c.name} for {p.name}", principal.actor,
                  {"run_id": str(run.id)}, tenant_id=t.id, project_id=p.id)
    run.job_id = job.id
    audit.record(s, principal.actor, "conversion.run_requested", tenant_id=t.id, project_id=p.id,
                 target_type="conversion_run", target_id=str(run.id),
                 details={"connection": c.name, "from": c.engine, "to": body.target_dialect})
    return _conv_out(s, run)


@router.get("/projects/{project_id}/conversion-runs", response_model=list[ConversionOut])
def list_conversions(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[ConversionOut]:
    _, p = project_for(s, principal, project_id, None)
    return [_conv_out(s, r) for r in s.scalars(select(ConversionRun).where(ConversionRun.project_id == p.id)
                                               .order_by(ConversionRun.created_at.desc()).limit(50))]


def _conv(s: Session, principal: Principal, run_id: uuid.UUID) -> tuple[ConversionRun, Tenant]:
    r = s.get(ConversionRun, run_id)
    if r is None:
        raise not_found("Conversion run")
    t, _ = project_for(s, principal, r.project_id, None)
    return r, t


@router.get("/conversion-runs/{run_id}", response_model=ConversionOut)
def get_conversion(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> ConversionOut:
    r, _ = _conv(s, principal, run_id)
    return _conv_out(s, r)


CONV_LIST = ("object_type", "name", "status", "rules", "warnings", "review", "compile", "tests")


@router.get("/conversion-runs/{run_id}/objects")
def conversion_objects(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB, status: str | None = None,
                       q: str | None = None, offset: Annotated[int, Query(ge=0)] = 0,
                       limit: Annotated[int, Query(ge=1, le=500)] = 100) -> dict[str, Any]:
    r, t = _conv(s, principal, run_id)
    where, params = ["run_id = %s"], [r.id]
    if status:
        where.append("status = %s")
        params.append(status)  # type: ignore[arg-type]
    if q:
        where.append("name ILIKE %s")
        params.append(f"%{q}%")  # type: ignore[arg-type]
    clause = " AND ".join(where)
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        total = tc.execute(f"SELECT count(*) FROM estate.conversions WHERE {clause}", params).fetchone()
        rows = tc.execute(f"SELECT {', '.join(CONV_LIST)} FROM estate.conversions WHERE {clause} "
                          "ORDER BY object_type, name OFFSET %s LIMIT %s", [*params, offset, limit]).fetchall()
    return {"total": total[0] if total else 0, "offset": offset,
            "items": [dict(zip(CONV_LIST, row, strict=True)) for row in rows]}


@router.get("/conversion-runs/{run_id}/object")
def conversion_object(run_id: uuid.UUID, object_type: str, name: str, principal: CurrentPrincipal, s: DB
                      ) -> dict[str, Any]:
    """One object: its source, the converted code, the rules applied, the compile result and test outcomes."""
    r, t = _conv(s, principal, run_id)
    keys = (*CONV_LIST, "source", "converted")
    with tenant_connection(t, get_vault()) as tc:
        row = tc.execute(f"SELECT {', '.join(keys)} FROM estate.conversions WHERE run_id = %s AND object_type = %s "
                         "AND name = %s", (r.id, object_type, name)).fetchone()
    if row is None:
        raise not_found("Converted object")
    return dict(zip(keys, row, strict=True))


# ------------------------------------------------------------------ recorded test cases (E10.F1.S2)

class Expected(BaseModel):
    value: Any = None
    outputs: dict[str, Any] | None = None
    rows: list[list[Any]] | None = None
    error: str | None = Field(default=None, description="Text the error must contain, when the case must fail")


class TestIn(BaseModel):
    object_name: str = Field(min_length=3, max_length=300, pattern=r"^[^.\s]+\.[^.\s]+$",
                             description="schema.name of the source object")
    name: str = Field(min_length=3, max_length=200)
    inputs: dict[Annotated[str, Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")], Any] = Field(
        default_factory=dict, description="Parameter name (without @) to value, in order")
    outputs: list[Annotated[str, Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")]] = Field(
        default_factory=list, description="OUTPUT parameters to capture")
    setup: dict[str, list[dict[str, Any]]] = Field(default_factory=dict,
                                                   description="schema.table to rows inserted before the call")
    expected: Expected


TEST_KEYS = ("id", "object_name", "name", "body", "created_by", "created_at")


def _test_perm(principal: Principal, t: Tenant, project_id: uuid.UUID) -> None:
    if not (principal.has_on_project(P.SOURCE_MANAGE, t, project_id)
            or principal.has_on_project(P.GOLDEN_RUN, t, project_id)):
        raise forbidden("You need to be a test engineer or manage sources on this project.")


@router.get("/projects/{project_id}/conversion-tests")
def list_tests(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    t, p = project_for(s, principal, project_id, None)
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        rows = tc.execute(f"SELECT {', '.join(TEST_KEYS)} FROM estate.conversion_tests WHERE project_id = %s "
                          "ORDER BY object_name, name", (p.id,)).fetchall()
    return [dict(zip(TEST_KEYS, r, strict=True)) for r in rows]


@router.post("/projects/{project_id}/conversion-tests", status_code=201)
def add_test(project_id: uuid.UUID, body: TestIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Record an input/output case for a source object; every conversion run replays it on the workbench."""
    t, p = project_for(s, principal, project_id, None)
    _test_perm(principal, t, p.id)
    tid = uuid.uuid4()
    payload = body.model_dump(exclude={"object_name", "name"}, exclude_none=True)
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        if tc.execute("SELECT 1 FROM estate.conversion_tests WHERE project_id = %s AND object_name = %s AND "
                      "name = %s", (p.id, body.object_name, body.name)).fetchone():
            raise conflict("A test case with this name already exists for this object.")
        with tc.transaction():
            tc.execute("INSERT INTO estate.conversion_tests(id, project_id, object_name, name, body, created_by) "
                       "VALUES (%s,%s,%s,%s,%s,%s)", (tid, p.id, body.object_name, body.name, json.dumps(payload),
                                                      principal.user.display_name))
    audit.record(s, principal.actor, "conversion.test_recorded", tenant_id=t.id, project_id=p.id,
                 target_type="conversion_test", target_id=str(tid),
                 details={"object": body.object_name, "name": body.name})
    return {"id": tid, "object_name": body.object_name, "name": body.name, "body": payload,
            "created_by": principal.user.display_name, "created_at": datetime.now(UTC)}


@router.delete("/projects/{project_id}/conversion-tests/{test_id}", status_code=204)
def delete_test(project_id: uuid.UUID, test_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> Response:
    t, p = project_for(s, principal, project_id, None)
    _test_perm(principal, t, p.id)
    with tenant_connection(t, get_vault()) as tc, tc.transaction():
        row = tc.execute("DELETE FROM estate.conversion_tests WHERE id = %s AND project_id = %s RETURNING object_name, "
                         "name", (test_id, p.id)).fetchone()
    if row is None:
        raise not_found("Test case")
    audit.record(s, principal.actor, "conversion.test_deleted", tenant_id=t.id, project_id=p.id,
                 target_type="conversion_test", target_id=str(test_id), details={"object": row[0], "name": row[1]})
    return Response(status_code=204)


# ------------------------------------------------------------------ hosting checklist (E10.F2.S1)

class ItemOut(BaseModel):
    id: uuid.UUID
    key: str
    category: str
    category_title: str
    title: str
    detail: str
    source: dict[str, Any]
    owner_user_id: uuid.UUID | None
    owner_name: str | None
    owner_role: str
    status: str
    note: str
    updated_by: str | None
    updated_at: datetime | None


def _item_out(s: Session, i: ChecklistItem) -> ItemOut:
    return ItemOut(id=i.id, key=i.key, category=i.category, category_title=checklist.AREA_TITLES.get(i.category,
                   i.category), title=i.title, detail=i.detail, source=i.source, owner_user_id=i.owner_user_id,
                   owner_name=_user(s, i.owner_user_id), owner_role=i.owner_role, status=i.status, note=i.note,
                   updated_by=_user(s, i.updated_by), updated_at=i.updated_at)


@router.get("/projects/{project_id}/checklist")
def get_checklist(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    items = s.scalars(select(ChecklistItem).where(ChecklistItem.project_id == p.id)
                      .order_by(ChecklistItem.category, ChecklistItem.key)).all()
    proposed, ref = checklist.propose(s, p.id)
    have = {i.key for i in items}
    done = sum(1 for i in items if i.status in ("done", "not_applicable"))
    return {"items": [_item_out(s, i) for i in items], "adapter": ref,
            "missing": [x.key for x in proposed if x.key not in have], "areas": list(checklist.AREAS),
            "complete": bool(items) and done == len(items), "done": done, "total": len(items),
            "can_manage": principal.has_on_project(P.STAGE_MANAGE, t, p.id)}


@router.post("/projects/{project_id}/checklist/sync")
def sync_checklist(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Add the items the target adapter (or the generic areas) call for and the project does not have yet."""
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    added, ref = checklist.sync(s, t.id, p.id)
    audit.record(s, principal.actor, "checklist.synced", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"added": added, "adapter": ref})
    return get_checklist(project_id, principal, s)


class ItemPatch(BaseModel):
    owner_user_id: uuid.UUID | None = None
    status: Literal["open", "in_progress", "done", "not_applicable"] | None = None
    note: str | None = Field(default=None, max_length=4000)


@router.patch("/checklist-items/{item_id}", response_model=ItemOut)
def update_item(item_id: uuid.UUID, body: ItemPatch, principal: CurrentPrincipal, s: DB) -> ItemOut:
    """Assign an owner, or record progress. Project managers change anything; the owner changes status and note."""
    i = s.get(ChecklistItem, item_id, with_for_update=True)
    if i is None:
        raise not_found("Checklist item")
    t, _ = project_for(s, principal, i.project_id, None)
    manager = principal.has_on_project(P.STAGE_MANAGE, t, i.project_id)
    if not manager and i.owner_user_id != principal.user.id:
        raise forbidden("Only the item's owner or someone who manages the project's stages can change it.")
    changes: dict[str, Any] = {}
    if "owner_user_id" in body.model_fields_set:
        if not manager:
            raise forbidden("Only someone who manages the project's stages can assign owners.")
        if body.owner_user_id is not None:
            u = s.get(User, body.owner_user_id)
            if u is None or u.kind != "person" or not u.is_active:
                raise invalid("owner_user_id", "Choose an active person.")
        i.owner_user_id = body.owner_user_id
        changes["owner"] = str(body.owner_user_id) if body.owner_user_id else None
    if body.status is not None and body.status != i.status:
        if body.status in ("done", "not_applicable"):
            if i.owner_user_id is None:
                raise conflict("Assign an owner first", "An item is closed by its owner, so it needs one.")
            if not (body.note or i.note).strip():
                raise invalid("note", "Say how the item was done, or why it does not apply.")
        changes["status"] = {"from": i.status, "to": body.status}
        i.status = body.status
    if body.note is not None:
        i.note = body.note.strip()
        changes["note"] = i.note
    if not changes:
        return _item_out(s, i)
    i.updated_by, i.updated_at = principal.user.id, datetime.now(UTC)
    s.flush()
    audit.record(s, principal.actor, "checklist.item_updated", tenant_id=t.id, project_id=i.project_id,
                 target_type="checklist_item", target_id=str(i.id), details={"key": i.key, **changes})
    return _item_out(s, i)

