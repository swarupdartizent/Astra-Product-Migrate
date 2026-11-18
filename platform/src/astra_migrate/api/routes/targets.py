"""Target baselines, project baseline pins, target connections and loads (E05.F3); golden runs (E22.F1.S1)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

import yaml
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters.contract import parse_source
from astra_migrate.adapters.target import TargetError, store_baseline, target_pack
from astra_migrate.api.errors import Problem, conflict, forbidden, invalid, not_found
from astra_migrate.connector_secrets import REF_RE
from astra_migrate.db.control import get_session
from astra_migrate.db.models import (
    ConnectorSecret,
    GoldenRun,
    LoadCall,
    Pack,
    PackFile,
    ProjectBaseline,
    TargetBaseline,
    TargetConnection,
    User,
)
from astra_migrate.jobs.runner import enqueue
from astra_migrate.packs.registry import manifest_of
from astra_migrate.packs.schema import parse_ref
from astra_migrate.security.principal import CurrentPrincipal, Principal, project_for, tenant_for
from astra_migrate.security.rbac import P

router = APIRouter(tags=["targets"])
DB = Annotated[Session, Depends(get_session)]


def _any_role(principal: Principal) -> None:
    if not principal.grants:
        raise forbidden()


# ------------------------------------------------------------------ baselines (E05.F3.S1)

class BaselineOut(BaseModel):
    id: uuid.UUID
    adapter_name: str
    name: str
    product_version: str
    provided_by: str
    provided_on: datetime
    digest: str
    object_count: int
    objects_by_type: dict[str, int]
    synthetic: bool
    created_by: str | None
    created_at: datetime
    pinned_projects: int


def _baseline_out(s: Session, b: TargetBaseline) -> BaselineOut:
    by_type: dict[str, int] = {}
    for o in b.content.get("objects", []):
        by_type[o["type"]] = by_type.get(o["type"], 0) + 1
    u = s.get(User, b.created_by)
    pins = len(list(s.scalars(select(ProjectBaseline.project_id).where(ProjectBaseline.baseline_id == b.id))))
    return BaselineOut(id=b.id, adapter_name=b.adapter_name, name=b.name, product_version=b.product_version,
                       provided_by=b.provided_by, provided_on=b.provided_on, digest=b.digest,
                       object_count=b.object_count, objects_by_type=by_type, synthetic=b.synthetic,
                       created_by=u.display_name if u else None, created_at=b.created_at, pinned_projects=pins)


@router.get("/target-baselines", response_model=list[BaselineOut])
def list_baselines(principal: CurrentPrincipal, s: DB, adapter: str | None = None) -> list[BaselineOut]:
    _any_role(principal)
    stmt = select(TargetBaseline).order_by(TargetBaseline.adapter_name, TargetBaseline.created_at.desc())
    if adapter:
        stmt = stmt.where(TargetBaseline.adapter_name == adapter)
    return [_baseline_out(s, b) for b in s.scalars(stmt)]


class BaselineIn(BaseModel):
    adapter_name: str = Field(min_length=3, max_length=64)
    name: str = Field(min_length=2, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9 ._-]*$")
    baseline_yaml: str = Field(min_length=10, max_length=20_000_000,
                               description="Baseline metadata in astra.baseline/v1 format (YAML or JSON)")
    synthetic: bool = Field(description="True when this is not the vendor's real baseline")


@router.post("/target-baselines", response_model=BaselineOut, status_code=201)
def create_baseline(body: BaselineIn, principal: CurrentPrincipal, s: DB) -> BaselineOut:
    if not principal.has_platform(P.BASELINE_MANAGE):
        raise forbidden()
    # Target baselines are what projects pin; source adapters may also have standard baselines, which the
    # version delta uses to tell standard objects from customized and customer-specific ones (E09.F1.S2).
    if s.scalar(select(Pack.id).where(Pack.name == body.adapter_name,
                                      Pack.type.in_(("target_adapter", "source_adapter")))) is None:
        raise invalid("adapter_name", "No target or source adapter pack with this name is registered.")
    try:
        raw = yaml.safe_load(body.baseline_yaml)
        b = store_baseline(s, body.adapter_name, body.name.strip(), raw, principal.user.id, principal.actor,
                           body.synthetic)
    except yaml.YAMLError as e:
        raise invalid("baseline_yaml", f"Not valid YAML or JSON: {str(e)[:200]}") from e
    except ValidationError as e:
        raise Problem(422, "validation", "Some fields need attention", "The baseline does not match astra.baseline/v1.",
                      errors=[{"field": "baseline_yaml." + ".".join(str(x) for x in err["loc"]),
                               "message": err["msg"]} for err in e.errors()[:20]]) from e
    except TargetError as e:
        raise invalid("name", str(e)) from e
    return _baseline_out(s, b)


@router.get("/target-baselines/{baseline_id}")
def get_baseline(baseline_id: uuid.UUID, principal: CurrentPrincipal, s: DB, object_type: str | None = None,
                 offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=1000)] = 200
                 ) -> dict[str, Any]:
    _any_role(principal)
    b = s.get(TargetBaseline, baseline_id)
    if b is None:
        raise not_found("Baseline")
    objs = [o for o in b.content.get("objects", []) if not object_type or o["type"] == object_type]
    return {"baseline": _baseline_out(s, b).model_dump(mode="json"), "total": len(objs),
            "objects": objs[offset:offset + limit]}


class PinBaselineIn(BaseModel):
    baseline_id: uuid.UUID
    reason: str = Field(min_length=5, max_length=1000)


@router.get("/projects/{project_id}/baseline")
def project_baseline(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    _, p = project_for(s, principal, project_id, None)
    pin = s.get(ProjectBaseline, p.id)
    if pin is None:
        return {"pinned": None}
    b = s.get(TargetBaseline, pin.baseline_id)
    u = s.get(User, pin.pinned_by)
    return {"pinned": _baseline_out(s, b).model_dump(mode="json") if b else None, "reason": pin.reason,
            "pinned_by": u.display_name if u else None, "pinned_at": pin.pinned_at}


@router.put("/projects/{project_id}/baseline")
def pin_baseline(project_id: uuid.UUID, body: PinBaselineIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Pin the project to one baseline version; the version delta engine compares against it."""
    t, p = project_for(s, principal, project_id, P.BLUEPRINT_EDIT)
    b = s.get(TargetBaseline, body.baseline_id)
    if b is None:
        raise invalid("baseline_id", "Unknown baseline")
    if s.scalar(select(Pack.id).where(Pack.name == b.adapter_name, Pack.type == "target_adapter")) is None:
        raise invalid("baseline_id", "Projects pin a target product's baseline; this one belongs to a source adapter.")
    pin = s.get(ProjectBaseline, p.id)
    before = str(pin.baseline_id) if pin else None
    if pin is None:
        s.add(ProjectBaseline(project_id=p.id, baseline_id=b.id, reason=body.reason.strip(),
                              pinned_by=principal.user.id))
    else:
        pin.baseline_id, pin.reason, pin.pinned_by = b.id, body.reason.strip(), principal.user.id
    s.flush()
    audit.record(s, principal.actor, "target.baseline_pinned", tenant_id=t.id, project_id=p.id,
                 target_type="project", target_id=str(p.id),
                 details={"from": before, "to": str(b.id), "baseline": f"{b.adapter_name}/{b.name}",
                          "reason": body.reason.strip()})
    return project_baseline(project_id, principal, s)


# ------------------------------------------------------------------ target connections and loads (E05.F3.S2)

class TargetConnIn(BaseModel):
    name: str = Field(min_length=3, max_length=100, pattern=r"^[a-z][a-z0-9-]*$")
    adapter: str
    base_url: str = Field(pattern=r"^https?://[^\s]+$", max_length=500)
    client_id: str = Field(min_length=1, max_length=200)
    client_secret_ref: str


class TargetConnOut(BaseModel):
    id: uuid.UUID
    tenant_id: uuid.UUID
    name: str
    adapter: str
    base_url: str
    client_id: str
    client_secret_ref: str
    created_at: datetime


def _tc_out(c: TargetConnection) -> TargetConnOut:
    return TargetConnOut(id=c.id, tenant_id=c.tenant_id, name=c.name, adapter=c.adapter, base_url=c.base_url,
                         client_id=c.client_id, client_secret_ref=c.client_secret_ref, created_at=c.created_at)


@router.get("/tenants/{tenant_id}/target-connections", response_model=list[TargetConnOut])
def list_target_connections(tenant_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[TargetConnOut]:
    t = tenant_for(s, principal, tenant_id, P.TENANT_READ)
    return [_tc_out(c) for c in s.scalars(select(TargetConnection).where(TargetConnection.tenant_id == t.id))]


@router.post("/tenants/{tenant_id}/target-connections", response_model=TargetConnOut, status_code=201)
def create_target_connection(tenant_id: uuid.UUID, body: TargetConnIn, principal: CurrentPrincipal, s: DB
                             ) -> TargetConnOut:
    t = tenant_for(s, principal, tenant_id, P.TARGET_LOAD)
    try:
        target_pack(s, body.adapter)
    except (TargetError, ValueError) as e:
        raise invalid("adapter", str(e)) from e
    m = REF_RE.match(body.client_secret_ref)
    if not m or s.scalar(select(ConnectorSecret).where(ConnectorSecret.tenant_id == t.id,
                                                       ConnectorSecret.name == m.group(1))) is None:
        raise invalid("client_secret_ref", "Use the reference of a secret in this tenant, like secret://target-client")
    if body.base_url.startswith("http://") and not body.base_url.startswith(("http://127.0.0.1", "http://localhost")):
        raise invalid("base_url", "Target endpoints must use HTTPS.")
    c = TargetConnection(tenant_id=t.id, name=body.name, adapter=body.adapter, base_url=body.base_url.rstrip("/"),
                         client_id=body.client_id, client_secret_ref=body.client_secret_ref,
                         created_by=principal.user.id)
    s.add(c)
    try:
        s.flush()
    except IntegrityError as e:
        raise invalid("name", "A target connection with this name already exists.") from e
    audit.record(s, principal.actor, "target.connection_created", tenant_id=t.id, target_type="target_connection",
                 target_id=str(c.id), details={"name": c.name, "adapter": c.adapter, "base_url": c.base_url})
    return _tc_out(c)


class LoadIn(BaseModel):
    entity: str = Field(min_length=2, max_length=64)
    records: list[dict[str, Any]] = Field(min_length=1, max_length=10_000)
    reason: str = Field(min_length=10, max_length=1000)


@router.post("/target-connections/{connection_id}/loads", status_code=202)
def start_load(connection_id: uuid.UUID, body: LoadIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    c = s.get(TargetConnection, connection_id)
    if c is None:
        raise not_found("Target connection")
    t = tenant_for(s, principal, c.tenant_id, P.TARGET_LOAD)
    _p, content = target_pack(s, c.adapter)
    if body.entity not in {e.entity for e in content.load.endpoints}:
        loads = ", ".join(e.entity for e in content.load.endpoints) or "nothing"
        raise invalid("entity", f"The adapter loads: {loads}")
    job = enqueue(s, "target.load", f"Load {len(body.records)} {body.entity} record(s) to {c.name}", principal.actor,
                  {"connection_id": str(c.id), "entity": body.entity, "records": body.records}, tenant_id=t.id)
    audit.record(s, principal.actor, "target.load_requested", tenant_id=t.id, target_type="target_connection",
                 target_id=str(c.id), details={"entity": body.entity, "records": len(body.records),
                                               "reason": body.reason.strip()})
    return {"job_id": str(job.id)}


@router.get("/target-connections/{connection_id}/calls")
def load_calls(connection_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
               limit: Annotated[int, Query(ge=1, le=1000)] = 200) -> list[dict[str, Any]]:
    c = s.get(TargetConnection, connection_id)
    if c is None:
        raise not_found("Target connection")
    tenant_for(s, principal, c.tenant_id, P.TENANT_READ)
    cols = ("id", "created_at", "entity", "method", "path", "status_code", "outcome", "records", "waited_ms",
            "latency_ms", "rate_limit_remaining", "error", "trace_id")
    return [{k: getattr(x, k) for k in cols} for x in s.scalars(
        select(LoadCall).where(LoadCall.connection_id == c.id).order_by(LoadCall.created_at.desc()).limit(limit))]


# ------------------------------------------------------------------ golden datasets (E22.F1.S1)

@router.get("/golden-datasets")
def golden_datasets(principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    _any_role(principal)
    out = []
    for p in s.scalars(select(Pack).where(Pack.type == "source_adapter").order_by(Pack.name, Pack.version_sort.desc())):
        try:
            datasets = parse_source(manifest_of(p).content).golden_datasets
        except ValidationError:
            continue  # registered before the adapter contract
        for g in datasets:
            last = s.scalars(select(GoldenRun).where(GoldenRun.dataset == f"{p.name}@{p.version}:{g.name}")
                             .order_by(GoldenRun.started_at.desc())).first()
            out.append({"dataset": f"{p.name}@{p.version}:{g.name}", "adapter": f"{p.name}@{p.version}",
                        "adapter_status": p.status, "name": g.name, "engine": g.engine, "description": g.description,
                        "last_run": {"id": str(last.id), "status": last.status, "started_at": last.started_at}
                        if last else None})
    return out


class GoldenRunIn(BaseModel):
    dataset: str = Field(pattern=r"^[a-z][a-z0-9-]*@\d+\.\d+\.\d+:[a-z][a-z0-9-]*$")
    packs: list[str] = Field(default_factory=list, description="Domain packs whose rules and concepts are checked")
    keep: bool = Field(default=False, description="Keep the estate afterwards as a demonstration source")


class GoldenRunOut(BaseModel):
    id: uuid.UUID
    dataset: str
    packs: dict[str, Any]
    status: str
    status_detail: str | None
    scorecard: dict[str, Any] | None
    keep: bool
    job_id: uuid.UUID | None
    started_by: str | None
    started_at: datetime
    finished_at: datetime | None


def _g_out(s: Session, g: GoldenRun) -> GoldenRunOut:
    u = s.get(User, g.started_by)
    return GoldenRunOut(id=g.id, dataset=g.dataset, packs=g.packs, status=g.status, status_detail=g.status_detail,
                        scorecard=g.scorecard, keep=g.keep, job_id=g.job_id, started_by=u.display_name if u else None,
                        started_at=g.started_at, finished_at=g.finished_at)


@router.post("/golden-runs", response_model=GoldenRunOut, status_code=202)
def start_golden(body: GoldenRunIn, principal: CurrentPrincipal, s: DB) -> GoldenRunOut:
    if not principal.has_platform(P.GOLDEN_RUN):
        raise forbidden()
    adapter_ref, name = body.dataset.rsplit(":", 1)
    refs = [adapter_ref, *body.packs]
    digests: dict[str, str] = {}
    for ref in refs:
        try:
            n, v = parse_ref(ref)
        except ValueError as e:
            raise invalid("packs", str(e)) from e
        p = s.scalar(select(Pack).where(Pack.name == n, Pack.version == v))
        if p is None:
            raise invalid("packs" if ref != adapter_ref else "dataset", f"{ref} is not registered.")
        digests[ref] = p.digest
        if ref == adapter_ref and name not in [g.name for g in parse_source(manifest_of(p).content).golden_datasets]:
            raise invalid("dataset", f"{adapter_ref} has no golden dataset '{name}'.")
    running = s.scalar(select(GoldenRun).where(GoldenRun.dataset == body.dataset,
                                               GoldenRun.status.in_(("queued", "running"))))
    if running is not None:
        raise conflict("A run of this dataset is already in progress")
    g = GoldenRun(dataset=body.dataset, packs=digests, status="queued", keep=body.keep, started_by=principal.user.id)
    s.add(g)
    s.flush()
    job = enqueue(s, "golden.run", f"Golden dataset {body.dataset}", principal.actor, {"golden_run_id": str(g.id)})
    g.job_id = job.id
    audit.record(s, principal.actor, "golden.run_requested", target_type="golden_run", target_id=str(g.id),
                 details={"dataset": body.dataset, "packs": digests, "keep": body.keep})
    return _g_out(s, g)


@router.get("/golden-runs", response_model=list[GoldenRunOut])
def list_golden(principal: CurrentPrincipal, s: DB, dataset: str | None = None,
                limit: Annotated[int, Query(ge=1, le=200)] = 50) -> list[GoldenRunOut]:
    _any_role(principal)
    stmt = select(GoldenRun).order_by(GoldenRun.started_at.desc())
    if dataset:
        stmt = stmt.where(GoldenRun.dataset == dataset)
    return [_g_out(s, g) for g in s.scalars(stmt.limit(limit))]


@router.get("/golden-runs/{run_id}", response_model=GoldenRunOut)
def get_golden(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> GoldenRunOut:
    _any_role(principal)
    g = s.get(GoldenRun, run_id)
    if g is None:
        raise not_found("Golden run")
    return _g_out(s, g)


@router.get("/golden-datasets/{adapter}/{version}/{name}/files")
def golden_files(adapter: str, version: str, name: str, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """The dataset's description and expected answers, so reviewers can see what 'correct' means."""
    _any_role(principal)
    p = s.scalar(select(Pack).where(Pack.name == adapter, Pack.version == version))
    if p is None:
        raise not_found("Adapter")
    g = next((d for d in parse_source(manifest_of(p).content).golden_datasets if d.name == name), None)
    if g is None:
        raise not_found("Golden dataset")
    base = g.path.rstrip("/")
    files = {f.path: bytes(f.content) for f in s.scalars(select(PackFile).where(PackFile.pack_id == p.id,
                                                                                PackFile.path.like(f"{base}/%")))}
    desc = yaml.safe_load(files.get(f"{base}/dataset.yaml", b"{}")) or {}
    return {"dataset": desc, "expected": yaml.safe_load(files.get(f"{base}/{desc.get('expected', '')}", b"{}")),
            "files": sorted(files)}
