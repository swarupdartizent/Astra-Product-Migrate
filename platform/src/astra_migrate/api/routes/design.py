"""Design and build (E12): design runs, the design register and decisions, form parity, integration end-to-end tests,
security profile access, and versioned build artifacts that run only once their tests pass and a person approves."""

from __future__ import annotations

import base64
import binascii
import hashlib
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters.target import TargetClient, TargetError, target_pack
from astra_migrate.api.errors import Problem, conflict, forbidden, invalid, not_found
from astra_migrate.connector_secrets import SecretError, read_for_connector
from astra_migrate.db.control import get_session
from astra_migrate.db.models import AdapterRun, BuildArtifact, DesignRun, SourceConnection, TargetConnection, Tenant
from astra_migrate.design import jobs as design_jobs
from astra_migrate.design import parity, register, service
from astra_migrate.design.service import DesignError
from astra_migrate.security.principal import CurrentPrincipal, Principal, project_for
from astra_migrate.security.rbac import P
from astra_migrate.vault import get_vault

router = APIRouter(tags=["design"])
DB = Annotated[Session, Depends(get_session)]
Stream = Literal["mapping", "configuration", "form", "code", "integration", "report", "page", "security"]
MAX_PDF = parity.MAX_BYTES


def _who(principal: Principal) -> dict[str, str]:
    return {"by": principal.user.display_name, "by_id": str(principal.user.id), "at": datetime.now(UTC).isoformat()}


def _problem(e: DesignError) -> Problem:
    if e.status == 422:
        return invalid(e.field or "body", str(e))
    if e.status == 403:
        return forbidden(str(e))
    if e.status == 404:
        return not_found(str(e))
    return conflict("The design item cannot be changed this way", str(e))


def _run_out(r: DesignRun) -> dict[str, Any]:
    return {"id": str(r.id), "project_id": str(r.project_id), "connection_id": str(r.connection_id),
            "status": r.status, "status_detail": r.status_detail, "summary": r.summary,
            "job_id": str(r.job_id) if r.job_id else None, "requested_by": r.requested_by.get("name"),
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None}


# ------------------------------------------------------------------ runs and overview

class DesignRunIn(BaseModel):
    connection_id: uuid.UUID


@router.post("/projects/{project_id}/design-runs", status_code=201)
def start_design(project_id: uuid.UUID, body: DesignRunIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    if not principal.has_on_tenant(P.SOURCE_MANAGE, t):
        raise forbidden("You need permission to read this tenant's sources.")
    c = s.get(SourceConnection, body.connection_id)
    if c is None or c.tenant_id != t.id:
        raise invalid("connection_id", "Choose a source connection of this project's tenant.")
    if s.scalar(select(AdapterRun.id).where(AdapterRun.connection_id == c.id, AdapterRun.kind == "check",
                                            AdapterRun.status == "succeeded")) is None:
        raise conflict("Check the connection first", "Design reads the source only after a connection check has "
                                                     "proved the account is read-only.")
    b, _ = design_jobs.target_of(s, p.id)
    if b is None:
        raise conflict("Pin a target baseline first", "Design proposes targets from the pinned target baseline.")
    if s.scalar(select(DesignRun.id).where(DesignRun.project_id == p.id,
                                           DesignRun.status.in_(("queued", "running")))) is not None:
        raise conflict("A design run is already running for this project")
    return _run_out(design_jobs.start_design(s, t, p, c, principal.actor))


@router.get("/projects/{project_id}/design-runs")
def list_design_runs(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    _, p = project_for(s, principal, project_id, None)
    return [_run_out(r) for r in s.scalars(select(DesignRun).where(DesignRun.project_id == p.id)
                                           .order_by(DesignRun.created_at.desc()).limit(50))]


@router.get("/design-runs/{run_id}")
def get_design_run(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    r = s.get(DesignRun, run_id)
    if r is None:
        raise not_found("Design run")
    project_for(s, principal, r.project_id, None)
    return _run_out(r)


@router.get("/projects/{project_id}/design")
def overview(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    latest = s.scalars(select(DesignRun).where(DesignRun.project_id == p.id)
                       .order_by(DesignRun.created_at.desc())).first()
    _, tgt = design_jobs.target_of(s, p.id)
    d = tgt.design if tgt else None
    with register.connect(t) as tc:
        counts = register.counts(tc, p.id)
    arts = list(s.scalars(select(BuildArtifact).where(BuildArtifact.project_id == p.id,
                                                      BuildArtifact.status != "superseded")))
    return {
        "latest_run": _run_out(latest) if latest else None, "counts": counts,
        "target_design": d.model_dump(mode="json", by_alias=True) if d else None,
        "target_design_missing": None if d else ("The pinned target's adapter has no design section, so streams "
                                                 "that need it are blocked." if tgt else "No target is pinned."),
        "build": {st: sum(1 for a in arts if a.status == st) for st in ("generated", "tests_failed", "tests_passed",
                                                                         "approved")},
        "can_run": principal.has_on_project(P.STAGE_MANAGE, t, p.id) and principal.has_on_tenant(P.SOURCE_MANAGE, t),
        "can_build": principal.has_on_project(P.STAGE_MANAGE, t, p.id),
        "can_decide": {st: service.can_decide(principal, t, p.id, st)[0] for st in register.STREAMS}}


# ------------------------------------------------------------------ register

def _summary(it: dict[str, Any]) -> dict[str, Any]:
    keep = ("stream", "key", "status", "source", "target", "proposed_target", "confidence", "flags", "evidence",
            "decision", "review_item_id", "approvals", "parity", "missing", "key_columns", "desktop", "updated_at")
    return {k: it.get(k) for k in keep}


@router.get("/projects/{project_id}/design/items")
def list_items(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB, stream: Stream | None = None,
               status: str | None = None, q: Annotated[str | None, Query(max_length=200)] = None,
               offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 100
               ) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    with register.connect(t) as tc:
        rows = register.items(tc, p.id, stream, status)
    if q:
        rows = [r for r in rows if q.lower() in r["key"]]
    if stream == "mapping":
        rows.sort(key=lambda r: (r["status"] != "in_review", r.get("confidence") or 0, r["key"]))
    return {"items": [_summary(r) for r in rows[offset:offset + limit]], "total": len(rows)}


@router.get("/projects/{project_id}/design/item")
def get_item(project_id: uuid.UUID, stream: Stream, key: str, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    with register.connect(t) as tc:
        it = register.get(tc, p.id, stream, key)
        files = tc.execute("SELECT role, name, sha256, length(content), uploaded_by, uploaded_at FROM "
                           "estate.design_files WHERE project_id = %s AND item_key = %s",
                           (p.id, key)).fetchall() if stream == "form" else []
    if it is None:
        raise not_found("Design item")
    ok, why = service.can_decide(principal, t, p.id, stream)
    return {**it, "readiness": service.readiness(it), "can_decide": ok, "cannot_decide_reason": why or None,
            "files": [{"role": f[0], "name": f[1], "sha256": f[2], "bytes": f[3], "uploaded_by": f[4],
                       "uploaded_at": f[5].isoformat() if f[5] else None} for f in files]}


class DecisionIn(BaseModel):
    stream: Stream
    keys: list[str] = Field(min_length=1, max_length=500)
    action: Literal["approve", "reject", "change"]
    reason: str = Field(default="", max_length=2000)
    target: str | None = Field(default=None, description="change (mappings): schema.table.column in the baseline")
    no_target: bool = Field(default=False, description="approve (mappings): the column is not migrated")


@router.post("/projects/{project_id}/design/decisions")
def decide(project_id: uuid.UUID, body: DecisionIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    b, _ = design_jobs.target_of(s, p.id)
    try:
        with register.connect(t) as tc:
            return service.decide(s, tc, principal, t, p.id, body.stream, body.keys, body.action, body.reason,
                                  _who(principal), b.content if b else {}, body.target, body.no_target)
    except DesignError as e:
        raise _problem(e) from e


class SecurityIn(BaseModel):
    key: str
    entries: dict[str, str] = Field(description="new object -> none | view | edit | full")


@router.put("/projects/{project_id}/design/security")
def set_security(project_id: uuid.UUID, body: SecurityIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    ok, why = service.can_decide(principal, t, p.id, "security")
    if not ok:
        raise forbidden(why)
    try:
        with register.connect(t) as tc, tc.transaction():
            out = service.set_security(tc, p.id, body.key, body.entries, principal.user.display_name)
    except DesignError as e:
        raise _problem(e) from e
    service.audit_record(s, principal, t, p.id, "design.security_set", {"profile": body.key,
                                                                         "entries": body.entries})
    return out


class KeyIn(BaseModel):
    key: str
    columns: list[str] = Field(min_length=1, max_length=16)


@router.put("/projects/{project_id}/design/code-key")
def set_code_key(project_id: uuid.UUID, body: KeyIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    ok, why = service.can_decide(principal, t, p.id, "code")
    if not ok:
        raise forbidden(why)
    try:
        with register.connect(t) as tc, tc.transaction():
            out = service.set_key(tc, p.id, body.key, body.columns, principal.user.display_name)
    except DesignError as e:
        raise _problem(e) from e
    service.audit_record(s, principal, t, p.id, "design.table_key_set", {"table": body.key, "key": body.columns})
    return out


# ------------------------------------------------------------------ integration end-to-end tests (E12.F3.S1)

class Step(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: str = Field(max_length=500)
    body: Any = None
    expect_status: int = Field(ge=100, le=599)
    expect_keys: list[str] = Field(default_factory=list, max_length=50)


class TestIn(BaseModel):
    key: str
    steps: list[Step] = Field(min_length=1, max_length=20)


@router.put("/projects/{project_id}/design/integration-test")
def set_integration_test(project_id: uuid.UUID, body: TestIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    ok, why = service.can_decide(principal, t, p.id, "integration")
    if not ok:
        raise forbidden(why)
    try:
        with register.connect(t) as tc, tc.transaction():
            out = service.set_test(tc, p.id, body.key, [st.model_dump() for st in body.steps],
                                   principal.user.display_name)
    except DesignError as e:
        raise _problem(e) from e
    service.audit_record(s, principal, t, p.id, "design.integration_test_set", {"interface": body.key,
                                                                                 "steps": len(body.steps)})
    return out


class TestRunIn(BaseModel):
    key: str
    target_connection_id: uuid.UUID


@router.post("/projects/{project_id}/design/integration-test-runs")
def run_integration_test(project_id: uuid.UUID, body: TestRunIn, principal: CurrentPrincipal, s: DB
                         ) -> dict[str, Any]:
    """Run the interface's end-to-end test against a target connection (a sandbox), step by step. Every call is
    logged with the target's other calls."""
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    conn = s.get(TargetConnection, body.target_connection_id)
    if conn is None or conn.tenant_id != t.id:
        raise invalid("target_connection_id", "Choose a target connection of this project's tenant.")
    with register.connect(t) as tc:
        it = register.get(tc, p.id, "integration", body.key)
    if it is None:
        raise not_found("Interface")
    if not it.get("tests"):
        raise conflict("No test is defined", "Define the interface's end-to-end test first.")
    _p, content = target_pack(s, conn.adapter)
    try:
        secret = read_for_connector(s, get_vault(), t, conn.client_secret_ref, f"target:{conn.name}")
    except SecretError as e:
        raise conflict("The target connection's secret cannot be read", str(e)) from e
    client = TargetClient(conn, content, secret)
    results = []
    blocked = None
    for st in it["tests"]:
        try:
            status, parsed, err = client.call(st["method"], st["path"], st.get("body"), label=f"test:{body.key}"[:100])
        except TargetError as e:
            blocked = str(e)
            break
        problems = []
        if err:
            problems.append(err)
        elif status != st["expect_status"]:
            problems.append(f"expected HTTP {st['expect_status']}, got {status}")
        missing = [k for k in st.get("expect_keys") or [] if not (isinstance(parsed, dict) and k in parsed)]
        if missing and not err:
            problems.append(f"missing in the response: {', '.join(missing)}")
        results.append({"step": st["name"], "status": status, "passed": not problems, "problems": problems})
    run = {"at": datetime.now(UTC).isoformat(), "by": principal.user.display_name, "connection": conn.name,
           "blocked": blocked, "passed": blocked is None and bool(results) and all(r["passed"] for r in results),
           "steps": results}
    with register.connect(t) as tc, tc.transaction():
        runs = [*(register.get(tc, p.id, "integration", body.key) or {}).get("test_runs", [])[-9:], run]
        register.update(tc, p.id, "integration", body.key, None, {"test_runs": runs, "last_test": run},
                        principal.user.display_name)
    service.audit_record(s, principal, t, p.id, "design.integration_test_run",
                         {"interface": body.key, "passed": run["passed"], "blocked": blocked,
                          "connection": conn.name})
    return run


# ------------------------------------------------------------------ form parity (E12.F2.S2)

class FormFileIn(BaseModel):
    key: str
    role: Literal["converted", "golden"]
    name: str = Field(min_length=1, max_length=200)
    content_base64: str


@router.put("/projects/{project_id}/design/form-files")
def put_form_file(project_id: uuid.UUID, body: FormFileIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    ok, why = service.can_decide(principal, t, p.id, "form")
    if not ok:
        raise forbidden(why)
    if len(body.content_base64) > MAX_PDF * 4 // 3 + 8:
        raise invalid("content_base64", "The file is larger than 20 MB.")
    try:
        data = base64.b64decode(body.content_base64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise invalid("content_base64", "The file is not valid base64.") from e
    try:
        parity.read(data)
    except parity.ParityError as e:
        raise invalid("content_base64", str(e)) from e
    sha = hashlib.sha256(data).hexdigest()
    with register.connect(t) as tc, tc.transaction():
        it = register.get(tc, p.id, "form", body.key)
        if it is None:
            raise not_found("Form")
        if it["status"] in register.DECIDED:
            raise conflict("The form is decided", f"The form is {it['status']}.")
        tc.execute("INSERT INTO estate.design_files(project_id, item_key, role, name, content, sha256, uploaded_by) "
                   "VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (project_id, item_key, role) DO UPDATE SET "
                   "name = excluded.name, content = excluded.content, sha256 = excluded.sha256, "
                   "uploaded_by = excluded.uploaded_by, uploaded_at = now()",
                   (p.id, body.key, body.role, body.name, data, sha, principal.user.display_name))
        out = register.update(tc, p.id, "form", body.key, None, {"parity": None}, principal.user.display_name)
    service.audit_record(s, principal, t, p.id, "design.form_file_uploaded",
                         {"form": body.key, "role": body.role, "sha256": sha, "bytes": len(data)})
    return out


class ParityIn(BaseModel):
    key: str


@router.post("/projects/{project_id}/design/form-parity")
def form_parity(project_id: uuid.UUID, body: ParityIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    with register.connect(t) as tc:
        files = {r[0]: (r[1], r[2]) for r in tc.execute(
            "SELECT role, content, sha256 FROM estate.design_files WHERE project_id = %s AND item_key = %s",
            (p.id, body.key)).fetchall()}
        if {"converted", "golden"} - set(files):
            raise conflict("Both files are needed", "Upload the converted form and its approved golden copy.")
        try:
            res = parity.compare(bytes(files["converted"][0]), bytes(files["golden"][0]))
        except parity.ParityError as e:
            raise invalid("files", str(e)) from e
        res = {**res, "converted_sha256": files["converted"][1], "golden_sha256": files["golden"][1],
               "at": datetime.now(UTC).isoformat(), "by": principal.user.display_name}
        with tc.transaction():
            out = register.update(tc, p.id, "form", body.key, None, {"parity": res}, principal.user.display_name)
    service.audit_record(s, principal, t, p.id, "design.form_parity", {"form": body.key, "passed": res["passed"],
                                                                        "differences": res["differences"][:10]})
    return out


# ------------------------------------------------------------------ build artifacts (E12.F4.S1, E12.F2.S3)

def _art_out(a: BuildArtifact) -> dict[str, Any]:
    return {"id": str(a.id), "kind": a.kind, "name": a.name, "version": a.version, "digest": a.digest,
            "status": a.status, "test_summary": a.test_summary, "runnable": a.status == "approved",
            "approved_by": str(a.approved_by) if a.approved_by else None, "approval_note": a.approval_note,
            "approved_at": a.approved_at.isoformat() if a.approved_at else None,
            "created_by": a.created_by.get("name"), "created_at": a.created_at.isoformat() if a.created_at else None}


@router.post("/projects/{project_id}/build", status_code=202)
def start_build(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Generate code from the register's decisions and test it on the workbench. Unchanged code keeps its version."""
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    job = design_jobs.start_build(s, t, p, principal.actor)
    return {"job_id": str(job.id)}


@router.get("/projects/{project_id}/build-artifacts")
def list_artifacts(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
                   kind: Literal["transformation", "code_object"] | None = None,
                   all_versions: bool = False) -> list[dict[str, Any]]:
    _, p = project_for(s, principal, project_id, None)
    stmt = select(BuildArtifact).where(BuildArtifact.project_id == p.id)
    if kind:
        stmt = stmt.where(BuildArtifact.kind == kind)
    if not all_versions:
        stmt = stmt.where(BuildArtifact.status != "superseded")
    return [_art_out(a) for a in s.scalars(stmt.order_by(BuildArtifact.kind, BuildArtifact.name,
                                                         BuildArtifact.version.desc()))]


def _artifact(s: Session, principal: Principal, artifact_id: uuid.UUID, lock: bool = False
              ) -> tuple[Tenant, BuildArtifact]:
    a = s.get(BuildArtifact, artifact_id, with_for_update=lock)
    if a is None:
        raise not_found("Build artifact")
    t, _ = project_for(s, principal, a.project_id, None)
    return t, a


@router.get("/build-artifacts/{artifact_id}")
def get_artifact(artifact_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, a = _artifact(s, principal, artifact_id)
    with register.connect(t) as tc:
        row = tc.execute("SELECT code, tests, results, inputs FROM estate.build_code WHERE artifact_id = %s",
                         (a.id,)).fetchone()
    can, why = service.can_decide(principal, t, a.project_id, "code")
    return {**_art_out(a), "code": row[0] if row else None, "tests": row[1] if row else [],
            "results": row[2] if row else [], "inputs": row[3] if row else {},
            "can_approve": can and a.status == "tests_passed",
            "cannot_approve_reason": None if can and a.status == "tests_passed" else
            (why or f"The artifact is {a.status.replace('_', ' ')}; only a version whose tests passed is approved.")}


class ApproveIn(BaseModel):
    note: str = Field(min_length=10, max_length=2000)


@router.post("/build-artifacts/{artifact_id}/approve")
def approve_artifact(artifact_id: uuid.UUID, body: ApproveIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Approve exactly this version, whose tests passed. Only approved code may run; the previous approved version of
    the same artifact is superseded."""
    t, a = _artifact(s, principal, artifact_id, lock=True)
    ok, why = service.can_decide(principal, t, a.project_id, "code")
    if not ok:
        raise forbidden(why)
    if str(a.created_by.get("id")) == str(principal.user.id):
        raise forbidden("You generated this version, so someone else approves it.")
    if a.status != "tests_passed":
        raise conflict("Only tested code is approved", f"This version is {a.status.replace('_', ' ')}.")
    for old in s.scalars(select(BuildArtifact).where(BuildArtifact.project_id == a.project_id,
                                                     BuildArtifact.kind == a.kind, BuildArtifact.name == a.name,
                                                     BuildArtifact.status == "approved")):
        old.status = "superseded"
    a.status, a.approved_by, a.approved_at, a.approval_note = ("approved", principal.user.id, datetime.now(UTC),
                                                               body.note.strip())
    s.flush()
    audit.record(s, principal.actor, "build.artifact_approved", tenant_id=t.id, project_id=a.project_id,
                 target_type="build_artifact", target_id=str(a.id),
                 details={"name": a.name, "kind": a.kind, "version": a.version, "digest": a.digest,
                          "note": a.approval_note})
    return _art_out(a)
