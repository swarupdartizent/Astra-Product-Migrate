"""Health, the signed-in user, roles and regions."""

from __future__ import annotations

import socket
import uuid
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from astra_migrate.config import get_settings
from astra_migrate.db.control import get_session, session_scope
from astra_migrate.db.models import Partner, Programme, Tenant
from astra_migrate.security.principal import CurrentPrincipal
from astra_migrate.security.rbac import ROLES, P
from astra_migrate.tenancy.regions import load_regions
from astra_migrate.vault import get_vault

router = APIRouter()


class Check(BaseModel):
    name: str
    status: Literal["ok", "fail"]
    detail: str | None = None


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    checks: list[Check]


@router.get("/health", response_model=Health, tags=["platform"])
def health() -> Health:
    checks: list[Check] = []
    try:
        with session_scope() as s:
            s.execute(text("select 1"))
        checks.append(Check(name="control_db", status="ok"))
    except Exception as e:
        checks.append(Check(name="control_db", status="fail", detail=type(e).__name__))
    try:
        ok = get_vault().health()
        checks.append(Check(name="vault", status="ok" if ok else "fail", detail=None if ok else "sealed or standby"))
    except Exception as e:
        checks.append(Check(name="vault", status="fail", detail=type(e).__name__))
    for iss in get_settings().issuers:
        try:
            r = httpx.get(f"{iss}/.well-known/openid-configuration", timeout=3)
            checks.append(Check(name="identity_provider", status="ok" if r.status_code == 200 else "fail",
                                detail=None if r.status_code == 200 else f"HTTP {r.status_code}"))
        except httpx.HTTPError as e:
            checks.append(Check(name="identity_provider", status="fail", detail=type(e).__name__))
    for code, region in load_regions().items():
        try:
            with socket.create_connection((region.tenant_db.host, region.tenant_db.port), timeout=2):
                checks.append(Check(name=f"region:{code}", status="ok"))
        except OSError as e:
            checks.append(Check(name=f"region:{code}", status="fail", detail=type(e).__name__))
    status: Literal["ok", "degraded"] = "ok" if all(c.status == "ok" for c in checks) else "degraded"
    return Health(status=status, version=get_settings().version, checks=checks)


class RoleOut(BaseModel):
    role: str
    role_label: str
    scope_type: str
    scope_id: uuid.UUID | None
    scope_name: str | None


class Me(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    mfa: bool
    roles: list[RoleOut]
    permissions: list[str]


def scope_name(session: Session, scope_type: str, scope_id: uuid.UUID | None) -> str | None:
    model = {"programme": Programme, "partner": Partner, "tenant": Tenant}.get(scope_type)
    if scope_id is None or model is None:
        return "Whole platform" if scope_type == "platform" else None
    obj = session.get(model, scope_id)
    return getattr(obj, "name", None) if obj else None


@router.get("/me", response_model=Me, tags=["identity"])
def me(principal: CurrentPrincipal, session: Annotated[Session, Depends(get_session)]) -> Me:
    roles = [RoleOut(role=g.role, role_label=ROLES[g.role].label if g.role in ROLES else g.role,
                     scope_type=g.scope_type, scope_id=g.scope_id,
                     scope_name=scope_name(session, g.scope_type, g.scope_id)) for g in principal.grants]
    return Me(id=principal.user.id, email=principal.user.email, display_name=principal.user.display_name,
              mfa=principal.mfa, roles=roles, permissions=sorted(p.value for p in principal.permissions()))


class RoleDefOut(BaseModel):
    key: str
    label: str
    description: str
    permissions: list[str]
    allowed_scopes: list[str]


@router.get("/roles", response_model=list[RoleDefOut], tags=["identity"])
def roles(_: CurrentPrincipal) -> list[RoleDefOut]:
    order = ["platform", "programme", "partner", "tenant", "project"]
    return [RoleDefOut(key=r.key, label=r.label, description=r.description,
                       permissions=sorted(p.value for p in r.permissions),
                       allowed_scopes=[s for s in order if s in r.allowed_scopes]) for r in ROLES.values()]


class RegionOut(BaseModel):
    code: str
    name: str
    jurisdiction: str
    model_endpoints: dict[str, bool]


@router.get("/regions", response_model=list[RegionOut], tags=["tenancy"])
def regions(_: CurrentPrincipal) -> list[RegionOut]:
    return [RegionOut(code=r.code, name=r.name, jurisdiction=r.jurisdiction,
                      model_endpoints={k: v.region_pinned for k, v in r.model_endpoints.items()})
            for r in load_regions().values()]


def visible_tenant_ids(session: Session, principal: CurrentPrincipal, perm: P) -> list[uuid.UUID] | None:
    """None when the principal holds the permission platform-wide, otherwise the tenants it covers."""
    if principal.has_platform(perm):
        return None
    tenants = session.scalars(select(Tenant).where(Tenant.status != "deleted"))
    return [t.id for t in tenants if principal.has_on_tenant(perm, t)]
