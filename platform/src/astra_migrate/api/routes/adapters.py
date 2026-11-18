"""Adapters: contract, adapter packs, curated traps, source connections and their runs (E05.F1, E05.F2)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters.contract import (
    CONTRACT_VERSION,
    SourceAdapterContent,
    Trap,
    parse_source,
    parse_target,
)
from astra_migrate.adapters.jobs import AdapterError, adapter_pack
from astra_migrate.api.errors import Problem, conflict, forbidden, invalid, not_found
from astra_migrate.connector_secrets import REF_RE
from astra_migrate.db.control import get_session
from astra_migrate.db.models import AdapterRun, ConnectorSecret, CuratedTrap, Pack, SourceConnection, Tenant
from astra_migrate.jobs.runner import enqueue
from astra_migrate.packs.registry import manifest_of
from astra_migrate.security.principal import CurrentPrincipal, Principal, tenant_for
from astra_migrate.security.rbac import P
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

router = APIRouter(tags=["adapters"])
DB = Annotated[Session, Depends(get_session)]

OPERATIONS = [
    {"name": "connect", "description": "Check the connection: engine, version, and that the account is read-only."},
    {"name": "read_metadata", "description": "Inventory every declared object type with owner, last change and "
                                             "dependencies, plus a coverage report."},
    {"name": "read_code", "description": "Read the source text of code objects."},
    {"name": "extract", "description": "Extract entity data in full or as deltas, documents with their entity "
                                       "links, and counts for reconciliation."},
    {"name": "list_traps", "description": "Evaluate known traps (from the pack and from curators) on an estate."},
    {"name": "load", "description": "Target only: load through the vendor's APIs or approved tools. "
                                    "Database writes cannot be expressed."},
    {"name": "report_limits", "description": "Report the product's constraints, each with a source and a date."},
]


def _any_role(principal: Principal) -> None:
    if not principal.grants:
        raise forbidden()


# ------------------------------------------------------------------ contract and adapter packs

@router.get("/adapters/contract")
def contract(principal: CurrentPrincipal) -> dict[str, Any]:
    _any_role(principal)
    return {"version": CONTRACT_VERSION, "operations": OPERATIONS,
            "documentation": "docs/adapter-contract.md",
            "source_schema": SourceAdapterContent.model_json_schema(),
            "read_only_layers": [
                "Every adapter query is checked at registration and before it runs: one SELECT or WITH statement, "
                "no data-changing, DDL, permission, execution or external-access keyword.",
                "The connection check refuses an account that can write.",
                "Every adapter session runs in a transaction that is always rolled back."]}


class AdapterOut(BaseModel):
    ref: str
    name: str
    version: str
    type: str
    status: str
    title: str
    product: str
    product_versions: list[str]
    engines: list[str]
    object_types: list[str]
    entities: int
    traps: int
    curated_traps: int
    golden_datasets: list[str]
    constraints: int
    validated: bool
    contract_valid: bool = True
    contract_problem: str | None = None


def _adapter_out(s: Session, p: Pack) -> AdapterOut:
    m = manifest_of(p)
    try:
        (parse_source if p.type == "source_adapter" else parse_target)(m.content)
    except ValidationError as e:
        return AdapterOut(ref=m.ref, name=p.name, version=p.version, type=p.type, status=p.status, title=p.title,
                          product="", product_versions=[], engines=[], object_types=[], entities=0, traps=0,
                          curated_traps=0, golden_datasets=[], constraints=0, validated=False, contract_valid=False,
                          contract_problem=f"Registered before the adapter contract, or does not match it: "
                                           f"{e.error_count()} problem(s)")
    curated = len(list(s.scalars(select(CuratedTrap.id).where(CuratedTrap.adapter_name == p.name,
                                                               CuratedTrap.active))))
    if p.type == "source_adapter":
        c = parse_source(m.content)
        return AdapterOut(ref=m.ref, name=p.name, version=p.version, type=p.type, status=p.status, title=p.title,
                          product=c.product.name, product_versions=c.product.versions,
                          engines=[e.engine for e in c.engines], object_types=[o.key for o in c.object_types],
                          entities=len(c.entities), traps=len(c.traps), curated_traps=curated,
                          golden_datasets=[g.name for g in c.golden_datasets], constraints=0,
                          validated=c.validated_against_real_estate)
    t = parse_target(m.content)
    return AdapterOut(ref=m.ref, name=p.name, version=p.version, type=p.type, status=p.status, title=p.title,
                      product=t.product.name, product_versions=t.product.versions, engines=[], object_types=[],
                      entities=len(t.load.endpoints), traps=0, curated_traps=0, golden_datasets=[],
                      constraints=len(t.constraints), validated=t.validated_against_real_target)


@router.get("/adapters", response_model=list[AdapterOut])
def list_adapters(principal: CurrentPrincipal, s: DB, include_drafts: bool = True) -> list[AdapterOut]:
    _any_role(principal)
    stmt = select(Pack).where(Pack.type.in_(("source_adapter", "target_adapter")))
    if not include_drafts:
        stmt = stmt.where(Pack.status != "draft")
    return [_adapter_out(s, p) for p in s.scalars(stmt.order_by(Pack.name, Pack.version_sort.desc()))]


@router.get("/adapters/{name}/{version}/constraints")
def constraints(name: str, version: str, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    _any_role(principal)
    p = s.scalar(select(Pack).where(Pack.name == name, Pack.version == version))
    if p is None or p.type != "target_adapter":
        raise not_found("Target adapter")
    t = parse_target(manifest_of(p).content)
    return {"adapter": f"{name}@{version}", "validated": t.validated_against_real_target,
            "load": t.load.model_dump(mode="json"),
            "constraints": [{**c.model_dump(mode="json"), "rule_id": f"TGT-{c.id}"} for c in t.constraints]}


# ------------------------------------------------------------------ traps (E05.F2.S4)

class TrapOut(BaseModel):
    id: str
    origin: str
    active: bool
    title: str
    description: str
    severity: str
    stream: str
    advice: str
    detect: dict[str, Any]
    sources: list[dict[str, Any]]
    added_by: str | None = None
    reason: str | None = None


@router.get("/adapters/{name}/traps", response_model=list[TrapOut])
def list_traps(name: str, principal: CurrentPrincipal, s: DB, version: str | None = None) -> list[TrapOut]:
    _any_role(principal)
    stmt = select(Pack).where(Pack.name == name, Pack.type == "source_adapter")
    if version:
        stmt = stmt.where(Pack.version == version)
    p = s.scalars(stmt.order_by(Pack.version_sort.desc())).first()
    if p is None:
        raise not_found("Source adapter")
    out = [TrapOut(id=t.id, origin="pack", active=True, **t.model_dump(mode="json", exclude={"id"}))
           for t in parse_source(manifest_of(p).content).traps]
    from astra_migrate.db.models import User

    for ct in s.scalars(select(CuratedTrap).where(CuratedTrap.adapter_name == name).order_by(CuratedTrap.created_at)):
        u = s.get(User, ct.created_by)
        d = dict(ct.definition)
        out.append(TrapOut(id=ct.trap_id, origin="curated", active=ct.active, added_by=u.display_name if u else None,
                           reason=ct.reason, **{k: v for k, v in d.items() if k != "id"}))
    return out


class TrapIn(BaseModel):
    trap: dict[str, Any]
    reason: str = Field(min_length=10, max_length=2000)


@router.post("/adapters/{name}/traps", response_model=TrapOut, status_code=201)
def add_trap(name: str, body: TrapIn, principal: CurrentPrincipal, s: DB) -> TrapOut:
    """Add a trap that applies to every version of the adapter. Its queries pass the read-only check."""
    if not principal.has_platform(P.TRAP_CURATE):
        raise forbidden()
    if s.scalar(select(Pack.id).where(Pack.name == name, Pack.type == "source_adapter")) is None:
        raise not_found("Source adapter")
    try:
        trap = Trap.model_validate(body.trap)
    except ValidationError as e:
        raise Problem(422, "validation", "Some fields need attention", "The trap does not match the contract.",
                      errors=[{"field": "trap." + ".".join(str(x) for x in err["loc"]),
                               "message": err["msg"].removeprefix("Value error, ")} for err in e.errors()]) from e
    ct = CuratedTrap(adapter_name=name, trap_id=trap.id, definition=trap.model_dump(mode="json"), active=True,
                     reason=body.reason.strip(), created_by=principal.user.id)
    s.add(ct)
    try:
        s.flush()
    except IntegrityError as e:
        raise invalid("trap.id", "A curated trap with this id already exists for this adapter.") from e
    audit.record(s, principal.actor, "adapter.trap_added", target_type="curated_trap", target_id=str(ct.id),
                 details={"adapter": name, "trap": trap.id, "severity": trap.severity, "reason": ct.reason})
    return TrapOut(id=trap.id, origin="curated", active=True, added_by=principal.user.display_name, reason=ct.reason,
                   **trap.model_dump(mode="json", exclude={"id"}))


class TrapActiveIn(BaseModel):
    active: bool
    reason: str = Field(min_length=10, max_length=2000)


@router.put("/adapters/{name}/traps/{trap_id}/active", status_code=204, response_class=Response, response_model=None)
def set_trap_active(name: str, trap_id: str, body: TrapActiveIn, principal: CurrentPrincipal, s: DB) -> Response:
    if not principal.has_platform(P.TRAP_CURATE):
        raise forbidden()
    ct = s.scalar(select(CuratedTrap).where(CuratedTrap.adapter_name == name, CuratedTrap.trap_id == trap_id))
    if ct is None:
        raise not_found("Curated trap")
    ct.active = body.active
    audit.record(s, principal.actor, "adapter.trap_" + ("enabled" if body.active else "disabled"),
                 target_type="curated_trap", target_id=str(ct.id), details={"adapter": name, "trap": trap_id,
                                                                             "reason": body.reason.strip()})
    return Response(status_code=204)


# ------------------------------------------------------------------ source connections (E05.F2.S1)

class ConnectionIn(BaseModel):
    name: str = Field(min_length=3, max_length=100, pattern=r"^[a-z][a-z0-9-]*$")
    adapter: str = Field(description="Published source adapter, name@version")
    engine: Literal["sqlserver", "sqlanywhere"]
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    database: str = Field(min_length=1, max_length=128)
    username: str = Field(min_length=1, max_length=128)
    password_ref: str = Field(description="A connector secret reference: secret://name")
    encrypt: bool = True
    project_id: uuid.UUID | None = None


class ConnectionOut(BaseModel):
    id: uuid.UUID
    tenant_id: uuid.UUID
    project_id: uuid.UUID | None
    name: str
    adapter: str
    engine: str
    host: str
    port: int
    database: str
    username: str
    password_ref: str
    encrypt: bool
    last_check: dict[str, Any] | None
    last_checked_at: datetime | None
    created_at: datetime
    can_manage: bool


def _conn_out(c: SourceConnection, principal: Principal, t: Tenant) -> ConnectionOut:
    return ConnectionOut(id=c.id, tenant_id=c.tenant_id, project_id=c.project_id, name=c.name, adapter=c.adapter,
                         engine=c.engine, host=c.host, port=c.port, database=c.database, username=c.username,
                         password_ref=c.password_ref, encrypt=c.encrypt, last_check=c.last_check,
                         last_checked_at=c.last_checked_at, created_at=c.created_at,
                         can_manage=principal.has_on_tenant(P.SOURCE_MANAGE, t))


@router.get("/tenants/{tenant_id}/source-connections", response_model=list[ConnectionOut])
def list_connections(tenant_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[ConnectionOut]:
    t = tenant_for(s, principal, tenant_id, P.TENANT_READ)
    return [_conn_out(c, principal, t) for c in s.scalars(
        select(SourceConnection).where(SourceConnection.tenant_id == t.id).order_by(SourceConnection.name))]


@router.post("/tenants/{tenant_id}/source-connections", response_model=ConnectionOut, status_code=201)
def create_connection(tenant_id: uuid.UUID, body: ConnectionIn, principal: CurrentPrincipal, s: DB) -> ConnectionOut:
    t = tenant_for(s, principal, tenant_id, P.SOURCE_MANAGE)
    try:
        p = adapter_pack(s, body.adapter)
    except (AdapterError, ValueError) as e:
        raise invalid("adapter", str(e)) from e
    content = parse_source(manifest_of(p).content)
    if body.engine not in {e.engine for e in content.engines}:
        raise invalid("engine", f"{body.adapter} supports: {', '.join(e.engine for e in content.engines)}")
    m = REF_RE.match(body.password_ref)
    if not m:
        raise invalid("password_ref", "Use a connector secret reference, like secret://source-db-password")
    if s.scalar(select(ConnectorSecret).where(ConnectorSecret.tenant_id == t.id, ConnectorSecret.name == m.group(1))
                ) is None:
        raise invalid("password_ref", f"No secret named '{m.group(1)}' in this tenant. Add it under Secrets first.")
    c = SourceConnection(tenant_id=t.id, project_id=body.project_id, name=body.name, adapter=body.adapter,
                         engine=body.engine, host=body.host.strip(), port=body.port, database=body.database.strip(),
                         username=body.username.strip(), password_ref=body.password_ref, encrypt=body.encrypt,
                         created_by=principal.user.id)
    s.add(c)
    try:
        s.flush()
    except IntegrityError as e:
        raise invalid("name", "A connection with this name already exists in this tenant.") from e
    audit.record(s, principal.actor, "adapter.connection_created", tenant_id=t.id, target_type="source_connection",
                 target_id=str(c.id), details={"name": c.name, "adapter": c.adapter, "engine": c.engine,
                                               "host": c.host, "database": c.database, "password_ref": c.password_ref})
    return _conn_out(c, principal, t)


def _conn(s: Session, principal: Principal, connection_id: uuid.UUID, perm: P) -> tuple[SourceConnection, Tenant]:
    c = s.get(SourceConnection, connection_id)
    if c is None:
        raise not_found("Connection")
    t = tenant_for(s, principal, c.tenant_id, perm)
    return c, t


@router.delete("/source-connections/{connection_id}", status_code=204, response_class=Response, response_model=None)
def delete_connection(connection_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> Response:
    c, t = _conn(s, principal, connection_id, P.SOURCE_MANAGE)
    audit.record(s, principal.actor, "adapter.connection_deleted", tenant_id=t.id, target_type="source_connection",
                 target_id=str(c.id), details={"name": c.name})
    s.delete(c)
    return Response(status_code=204)


class RunOut(BaseModel):
    id: uuid.UUID
    connection_id: uuid.UUID
    kind: str
    mode: str | None
    adapter: str
    status: str
    status_detail: str | None
    summary: dict[str, Any]
    job_id: uuid.UUID | None
    requested_by: str
    created_at: datetime
    finished_at: datetime | None


def _run_out(r: AdapterRun) -> RunOut:
    return RunOut(id=r.id, connection_id=r.connection_id, kind=r.kind, mode=r.mode, adapter=r.adapter, status=r.status,
                  status_detail=r.status_detail, summary=r.summary, job_id=r.job_id,
                  requested_by=str(r.requested_by.get("name", "")), created_at=r.created_at, finished_at=r.finished_at)


class StartRunIn(BaseModel):
    kind: Literal["check", "harvest", "extract"]
    mode: Literal["full", "delta"] | None = None


@router.post("/source-connections/{connection_id}/runs", response_model=RunOut, status_code=202)
def start_run(connection_id: uuid.UUID, body: StartRunIn, principal: CurrentPrincipal, s: DB) -> RunOut:
    c, t = _conn(s, principal, connection_id, P.SOURCE_MANAGE)
    busy = s.scalar(select(AdapterRun).where(AdapterRun.connection_id == c.id,
                                             AdapterRun.status.in_(("queued", "running"))))
    if busy is not None:
        raise conflict("This connection already has a run in progress", f"Wait for the {busy.kind} run to finish.")
    if body.kind != "check":
        ok = s.scalar(select(AdapterRun).where(AdapterRun.connection_id == c.id, AdapterRun.kind == "check",
                                               AdapterRun.status == "succeeded"))
        if ok is None:
            raise conflict("Check the connection first", "Discovery and extraction start only after a connection "
                                                         "check has proved the account is read-only.")
    mode = (body.mode or "full") if body.kind == "extract" else None
    run = AdapterRun(tenant_id=t.id, connection_id=c.id, kind=body.kind, mode=mode, adapter=c.adapter,
                     status="queued", summary={}, requested_by={"type": principal.actor.type, "id": principal.actor.id,
                                                                "name": principal.actor.name})
    s.add(run)
    s.flush()
    title = {"check": "Check connection", "harvest": "Read metadata and traps", "extract": f"Extract ({mode})"}
    job = enqueue(s, "adapter.run", f"{title[body.kind]}: {c.name}", principal.actor, {"run_id": str(run.id)},
                  tenant_id=t.id, project_id=c.project_id)
    run.job_id = job.id
    audit.record(s, principal.actor, f"adapter.{body.kind}_requested", tenant_id=t.id, target_type="adapter_run",
                 target_id=str(run.id), details={"connection": c.name, "mode": mode})
    return _run_out(run)


@router.get("/source-connections/{connection_id}/runs", response_model=list[RunOut])
def list_runs(connection_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
              limit: Annotated[int, Query(ge=1, le=200)] = 50) -> list[RunOut]:
    c, _ = _conn(s, principal, connection_id, P.TENANT_READ)
    return [_run_out(r) for r in s.scalars(select(AdapterRun).where(AdapterRun.connection_id == c.id)
                                           .order_by(AdapterRun.created_at.desc()).limit(limit))]


def _run(s: Session, principal: Principal, run_id: uuid.UUID) -> tuple[AdapterRun, Tenant]:
    r = s.get(AdapterRun, run_id)
    if r is None:
        raise not_found("Run")
    t = tenant_for(s, principal, r.tenant_id, P.TENANT_READ)
    return r, t


@router.get("/adapter-runs/{run_id}")
def run_detail(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """The run with its results from the tenant database: coverage and traps for a harvest; counts and
    document links for an extract."""
    r, t = _run(s, principal, run_id)
    out: dict[str, Any] = {"run": _run_out(r).model_dump(mode="json")}
    if r.status not in ("succeeded", "failed") or r.kind == "check":
        return out
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        if r.kind == "harvest":
            out["coverage"] = [dict(zip(("object_type", "label", "required", "status", "count", "error",
                                         "dependencies", "code_missing"), row, strict=True)) for row in tc.execute(
                "SELECT object_type, label, required, status, object_count, error, dependencies, code_missing "
                "FROM estate.coverage WHERE run_id = %s ORDER BY object_type", (r.id,)).fetchall()]
            out["traps"] = [dict(zip(("trap_id", "origin", "title", "severity", "stream", "advice", "hits"), row,
                                     strict=True)) for row in tc.execute(
                "SELECT trap_id, origin, title, severity, stream, advice, hits FROM estate.trap_findings "
                "WHERE run_id = %s ORDER BY severity, trap_id", (r.id,)).fetchall()]
        else:
            out["counts"] = [dict(zip(("entity", "mode", "source_count", "extracted", "watermark"), row, strict=True))
                             for row in tc.execute(
                "SELECT entity, mode, source_count, extracted, watermark FROM estate.extract_counts WHERE run_id = %s "
                "ORDER BY entity", (r.id,)).fetchall()]
            out["documents"] = [dict(zip(("doc_key", "name", "link_type", "link_entity", "link_key", "link_resolved",
                                          "size_bytes", "sha256"), row, strict=True)) for row in tc.execute(
                "SELECT doc_key, name, link_type, link_entity, link_key, link_resolved, size_bytes, sha256 "
                "FROM estate.documents WHERE run_id = %s ORDER BY link_resolved, doc_key LIMIT 500",
                (r.id,)).fetchall()]
    return out


@router.get("/adapter-runs/{run_id}/objects")
def run_objects(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB, object_type: str | None = None,
                q: str | None = None, offset: Annotated[int, Query(ge=0)] = 0,
                limit: Annotated[int, Query(ge=1, le=500)] = 100) -> dict[str, Any]:
    r, t = _run(s, principal, run_id)
    if r.kind != "harvest":
        raise invalid("run_id", "Objects belong to metadata harvest runs.")
    where, params = ["run_id = %s"], [r.id]
    if object_type:
        where.append("object_type = %s")
        params.append(object_type)  # type: ignore[arg-type]
    if q:
        where.append("(name ILIKE %s OR schema_name ILIKE %s)")
        params += [f"%{q}%", f"%{q}%"]  # type: ignore[list-item]
    clause = " AND ".join(where)
    with tenant_connection(t, get_vault()) as tc:
        total = tc.execute(f"SELECT count(*) FROM estate.metadata_objects WHERE {clause}", params).fetchone()
        rows = tc.execute(
            "SELECT object_type, schema_name, name, owner, modified_at, definition IS NOT NULL, definition_sha256, "
            f"depends_on, detail FROM estate.metadata_objects WHERE {clause} "
            "ORDER BY object_type, schema_name, name OFFSET %s LIMIT %s", [*params, offset, limit]).fetchall()
    keys = ("object_type", "schema", "name", "owner", "modified_at", "has_code", "definition_sha256", "depends_on",
            "detail")
    return {"total": total[0] if total else 0, "offset": offset,
            "items": [dict(zip(keys, row, strict=True)) for row in rows]}


@router.get("/adapter-runs/{run_id}/objects/{object_type}/{name}")
def run_object(run_id: uuid.UUID, object_type: str, name: str, principal: CurrentPrincipal, s: DB,
               schema: str = "") -> dict[str, Any]:
    """One object with its source code (read_code)."""
    r, t = _run(s, principal, run_id)
    with tenant_connection(t, get_vault()) as tc:
        row = tc.execute("SELECT object_type, schema_name, name, owner, modified_at, definition, definition_sha256, "
                         "depends_on, detail FROM estate.metadata_objects WHERE run_id = %s AND object_type = %s AND "
                         "schema_name = %s AND name = %s", (r.id, object_type, schema, name)).fetchone()
    if row is None:
        raise not_found("Object")
    return dict(zip(("object_type", "schema", "name", "owner", "modified_at", "definition", "definition_sha256",
                     "depends_on", "detail"), row, strict=True))
