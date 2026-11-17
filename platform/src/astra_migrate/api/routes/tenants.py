"""Tenants, programmes and partners (E01.F1.S1, E01.F1.S2)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.api.errors import Problem, conflict, forbidden, invalid, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import Partner, Programme, RegionMigration, Tenant
from astra_migrate.observability import tag_current
from astra_migrate.security.principal import CurrentPrincipal, enforce_tenant_policy, tenant_for
from astra_migrate.security.rbac import P, TenantScope, has_tenant_permission
from astra_migrate.tenancy import service
from astra_migrate.tenancy.regions import UnknownRegion, get_region
from astra_migrate.vault import get_vault

router = APIRouter(tags=["tenancy"])
DB = Annotated[Session, Depends(get_session)]
TenantId = Annotated[uuid.UUID, Path()]


# ---------------------------------------------------------------- programmes and partners

class ProgrammeIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    description: str = Field(default="", max_length=2000)


class PartnerOut(BaseModel):
    id: uuid.UUID
    name: str


class ProgrammeOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    partners: list[PartnerOut]


class PartnerIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)


def _programme_out(s: Session, p: Programme) -> ProgrammeOut:
    partners = s.scalars(select(Partner).where(Partner.programme_id == p.id).order_by(Partner.name))
    return ProgrammeOut(id=p.id, name=p.name, description=p.description,
                        partners=[PartnerOut(id=x.id, name=x.name) for x in partners])


def _can_manage_programme(principal: CurrentPrincipal, programme_id: uuid.UUID | None) -> bool:
    if principal.has_platform(P.PROGRAMME_MANAGE):
        return True
    return programme_id is not None and any(
        g.scope_type == "programme" and g.scope_id == programme_id and g.role == "programme_owner"
        for g in principal.grants)


@router.get("/programmes", response_model=list[ProgrammeOut])
def list_programmes(principal: CurrentPrincipal, s: DB) -> list[ProgrammeOut]:
    rows = list(s.scalars(select(Programme).order_by(Programme.name)))
    if not principal.has_platform(P.TENANT_READ):
        mine = {g.scope_id for g in principal.grants if g.scope_type == "programme"}
        partner_progs = {pp.programme_id for pp in s.scalars(select(Partner).where(
            Partner.id.in_([g.scope_id for g in principal.grants if g.scope_type == "partner"])))}
        rows = [r for r in rows if r.id in mine | partner_progs]
    return [_programme_out(s, r) for r in rows]


@router.post("/programmes", response_model=ProgrammeOut, status_code=201)
def create_programme(body: ProgrammeIn, principal: CurrentPrincipal, s: DB) -> ProgrammeOut:
    if not principal.has_platform(P.PROGRAMME_MANAGE):
        raise forbidden()
    p = Programme(name=body.name.strip(), description=body.description.strip())
    s.add(p)
    try:
        s.flush()
    except IntegrityError as e:
        raise conflict("A programme with this name already exists") from e
    audit.record(s, principal.actor, "programme.created", target_type="programme", target_id=str(p.id),
                 details={"name": p.name})
    return _programme_out(s, p)


@router.post("/programmes/{programme_id}/partners", response_model=PartnerOut, status_code=201)
def add_partner(programme_id: uuid.UUID, body: PartnerIn, principal: CurrentPrincipal, s: DB) -> PartnerOut:
    if s.get(Programme, programme_id) is None:
        raise not_found("Programme")
    if not _can_manage_programme(principal, programme_id):
        raise forbidden()
    p = Partner(programme_id=programme_id, name=body.name.strip())
    s.add(p)
    try:
        s.flush()
    except IntegrityError as e:
        raise conflict("This programme already has a partner with this name") from e
    audit.record(s, principal.actor, "programme.partner_added", target_type="partner", target_id=str(p.id),
                 details={"programme_id": str(programme_id), "name": p.name})
    return PartnerOut(id=p.id, name=p.name)


# ---------------------------------------------------------------- tenants

class TenantIn(BaseModel):
    slug: str = Field(min_length=4, max_length=32, description="Short name: lowercase letters, digits, hyphens")
    name: str = Field(min_length=2, max_length=200)
    region_code: str
    programme_id: uuid.UUID | None = None
    partner_id: uuid.UUID | None = None
    mfa_required: bool = True
    session_timeout_minutes: int = Field(default=480, ge=5, le=1440)


class TenantOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    region_code: str
    region_name: str | None
    programme_id: uuid.UUID | None
    programme_name: str | None
    partner_id: uuid.UUID | None
    partner_name: str | None
    status: str
    status_detail: str | None
    key_name: str
    mfa_required: bool
    session_timeout_minutes: int
    created_at: datetime
    deleted_at: datetime | None
    permissions: list[str]


def tenant_out(s: Session, t: Tenant, principal: CurrentPrincipal) -> TenantOut:
    try:
        region_name: str | None = get_region(t.region_code).name
    except UnknownRegion:
        region_name = None
    prog = s.get(Programme, t.programme_id) if t.programme_id else None
    part = s.get(Partner, t.partner_id) if t.partner_id else None
    perms = sorted(p.value for p in P if principal.has_on_tenant(p, t))
    return TenantOut(id=t.id, slug=t.slug, name=t.name, region_code=t.region_code, region_name=region_name,
                     programme_id=t.programme_id, programme_name=prog.name if prog else None,
                     partner_id=t.partner_id, partner_name=part.name if part else None, status=t.status,
                     status_detail=t.status_detail, key_name=t.key_name, mfa_required=t.mfa_required,
                     session_timeout_minutes=t.session_timeout_minutes, created_at=t.created_at,
                     deleted_at=t.deleted_at, permissions=perms)


@router.get("/tenants", response_model=list[TenantOut])
def list_tenants(principal: CurrentPrincipal, s: DB, include_deleted: bool = False) -> list[TenantOut]:
    stmt = select(Tenant).order_by(Tenant.name)
    if not include_deleted:
        stmt = stmt.where(Tenant.status != "deleted")
    return [tenant_out(s, t, principal) for t in s.scalars(stmt) if principal.has_on_tenant(P.TENANT_READ, t)]


@router.post("/tenants", response_model=TenantOut, status_code=201)
def create_tenant(body: TenantIn, principal: CurrentPrincipal, s: DB) -> TenantOut:
    programme_id = body.programme_id
    if body.partner_id:
        partner = s.get(Partner, body.partner_id)
        if partner is None:
            raise invalid("partner_id", "Unknown partner")
        if programme_id and partner.programme_id != programme_id:
            raise invalid("partner_id", "The partner does not belong to the chosen programme")
        programme_id = partner.programme_id
    if programme_id and s.get(Programme, programme_id) is None:
        raise invalid("programme_id", "Unknown programme")
    scope = TenantScope(uuid.uuid4(), programme_id, body.partner_id)
    if not has_tenant_permission(principal.grants, P.TENANT_CREATE, scope):
        raise forbidden("You can create tenants only in programmes you own.")
    if s.scalar(select(Tenant).where(Tenant.slug == body.slug)) is not None:
        raise invalid("slug", "A tenant with this short name already exists. Short names stay reserved after deletion.")
    try:
        t = service.new_tenant(s, principal.actor, slug=body.slug, name=body.name.strip(),
                               region_code=body.region_code, programme_id=programme_id, partner_id=body.partner_id,
                               mfa_required=body.mfa_required, session_timeout_minutes=body.session_timeout_minutes,
                               created_by=principal.user.id)
    except UnknownRegion as e:
        raise invalid("region_code", str(e)) from e
    except service.TenantError as e:
        raise invalid("slug", str(e)) from e
    s.commit()  # the request is visible while storage is built
    tag_current(tenant_id=str(t.id))
    service.provision(s, t, get_vault(), principal.actor)
    return tenant_out(s, t, principal)


@router.get("/tenants/{tenant_id}", response_model=TenantOut)
def get_tenant(tenant_id: TenantId, principal: CurrentPrincipal, s: DB) -> TenantOut:
    t = tenant_for(s, principal, tenant_id, P.TENANT_READ)
    tag_current(tenant_id=str(t.id))
    return tenant_out(s, t, principal)


class PolicyIn(BaseModel):
    mfa_required: bool
    session_timeout_minutes: int = Field(ge=5, le=1440)
    reason: str = Field(default="", max_length=1000)


@router.put("/tenants/{tenant_id}/policy", response_model=TenantOut)
def update_policy(tenant_id: TenantId, body: PolicyIn, principal: CurrentPrincipal, s: DB) -> TenantOut:
    t = tenant_for(s, principal, tenant_id, P.TENANT_POLICY)
    loosened = (t.mfa_required and not body.mfa_required) or body.session_timeout_minutes > t.session_timeout_minutes
    if loosened and len(body.reason.strip()) < 10:
        raise Problem(422, "reason-required", "A reason is required to weaken the security policy",
                      "Explain why multi-factor sign-in is being turned off or the session timeout lengthened.")
    before = {"mfa_required": t.mfa_required, "session_timeout_minutes": t.session_timeout_minutes}
    t.mfa_required, t.session_timeout_minutes = body.mfa_required, body.session_timeout_minutes
    audit.record(s, principal.actor, "tenant.policy_changed", tenant_id=t.id, target_type="tenant",
                 target_id=str(t.id), details={"before": before, "after": {
                     "mfa_required": t.mfa_required, "session_timeout_minutes": t.session_timeout_minutes},
                     "loosened": loosened, "reason": body.reason.strip()})
    return tenant_out(s, t, principal)


class DeleteIn(BaseModel):
    confirm_slug: str
    reason: str = Field(min_length=10, max_length=1000)


@router.post("/tenants/{tenant_id}/delete", response_model=TenantOut)
def delete_tenant(tenant_id: TenantId, body: DeleteIn, principal: CurrentPrincipal, s: DB) -> TenantOut:
    t = tenant_for(s, principal, tenant_id, P.TENANT_DELETE)
    if body.confirm_slug != t.slug:
        raise Problem(422, "confirmation-mismatch", "Confirmation does not match",
                      f"Type the tenant's short name '{t.slug}' to confirm deletion.")
    try:
        service.delete_tenant(s, t, get_vault(), principal.actor, body.reason.strip())
    except service.TenantError as e:
        raise conflict(str(e)) from e
    return tenant_out(s, t, principal)


class RegionMoveIn(BaseModel):
    to_region: str
    reason: str = Field(min_length=10, max_length=1000)


class RegionMoveOut(BaseModel):
    id: uuid.UUID
    from_region: str
    to_region: str
    reason: str
    status: str
    detail: dict[str, object]
    requested_at: datetime
    completed_at: datetime | None


def _move_out(m: RegionMigration) -> RegionMoveOut:
    return RegionMoveOut(id=m.id, from_region=m.from_region, to_region=m.to_region, reason=m.reason,
                         status=m.status, detail=m.detail, requested_at=m.requested_at, completed_at=m.completed_at)


@router.get("/tenants/{tenant_id}/region-migrations", response_model=list[RegionMoveOut])
def list_moves(tenant_id: TenantId, principal: CurrentPrincipal, s: DB) -> list[RegionMoveOut]:
    t = tenant_for(s, principal, tenant_id, P.TENANT_READ)
    rows = s.scalars(select(RegionMigration).where(RegionMigration.tenant_id == t.id)
                     .order_by(RegionMigration.requested_at.desc()))
    return [_move_out(m) for m in rows]


@router.post("/tenants/{tenant_id}/region-migrations", response_model=RegionMoveOut, status_code=201)
def move_region(tenant_id: TenantId, body: RegionMoveIn, principal: CurrentPrincipal, s: DB) -> RegionMoveOut:
    t = tenant_for(s, principal, tenant_id, P.TENANT_REGION_MIGRATE)
    enforce_tenant_policy(principal, t)
    try:
        get_region(body.to_region)
        m = service.migrate_region(s, t, body.to_region, body.reason.strip(), get_vault(), principal.actor,
                                   principal.user.id)
    except (service.TenantError, UnknownRegion) as e:
        raise invalid("to_region", str(e)) from e
    return _move_out(m)
