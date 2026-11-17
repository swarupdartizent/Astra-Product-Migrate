"""Users and role assignments (E01.F2.S2). Every change is audited."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.api.errors import Problem, conflict, forbidden, not_found
from astra_migrate.api.routes.core import scope_name
from astra_migrate.db.control import get_session
from astra_migrate.db.models import Partner, Programme, RoleAssignment, Tenant, User
from astra_migrate.security.principal import CurrentPrincipal, Principal, scope_of
from astra_migrate.security.rbac import ADMIN_ROLE, ROLES, P, TenantScope, can_grant, grant_covers_tenant

router = APIRouter(tags=["access"])
DB = Annotated[Session, Depends(get_session)]
ScopeType = Literal["platform", "programme", "partner", "tenant", "project"]


class AssignmentOut(BaseModel):
    id: uuid.UUID
    role: str
    role_label: str
    scope_type: str
    scope_id: uuid.UUID | None
    scope_name: str | None
    granted_at: datetime


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    status: Literal["active", "invited", "disabled"]
    last_seen_at: datetime | None
    assignments: list[AssignmentOut]


def _scope_tenant(s: Session, scope_type: str, scope_id: uuid.UUID | None) -> TenantScope | None:
    if scope_type == "tenant" and scope_id:
        t = s.get(Tenant, scope_id)
        return scope_of(t) if t else None
    return None


def _visible_assignment(s: Session, principal: Principal, a: RoleAssignment) -> bool:
    if principal.has_platform(P.ACCESS_READ):
        return True
    readers = [g for g in principal.grants if g.role in ROLES and P.ACCESS_READ in ROLES[g.role].permissions]
    for g in readers:
        if g.scope_type == a.scope_type and g.scope_id == a.scope_id:
            return True
        if a.scope_type == "tenant":
            ts = _scope_tenant(s, "tenant", a.scope_id)
            if ts and grant_covers_tenant(g, ts):
                return True
        if a.scope_type == "partner" and g.scope_type == "programme":
            p = s.get(Partner, a.scope_id) if a.scope_id else None
            if p and p.programme_id == g.scope_id:
                return True
    return False


def _user_out(s: Session, u: User, assignments: list[RoleAssignment]) -> UserOut:
    status: Literal["active", "invited", "disabled"] = (
        "disabled" if not u.is_active else ("invited" if u.issuer is None else "active"))
    return UserOut(id=u.id, email=u.email, display_name=u.display_name, status=status, last_seen_at=u.last_seen_at,
                   assignments=[AssignmentOut(id=a.id, role=a.role, role_label=ROLES[a.role].label if a.role in ROLES
                                              else a.role, scope_type=a.scope_type, scope_id=a.scope_id,
                                              scope_name=scope_name(s, a.scope_type, a.scope_id),
                                              granted_at=a.granted_at) for a in assignments])


def _require_some_access(principal: Principal, perm: P) -> None:
    if not any(g.role in ROLES and perm in ROLES[g.role].permissions for g in principal.grants):
        raise forbidden()


@router.get("/users", response_model=list[UserOut])
def list_users(principal: CurrentPrincipal, s: DB, q: str | None = None) -> list[UserOut]:
    _require_some_access(principal, P.ACCESS_READ)
    stmt = select(User).order_by(User.display_name)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(func.lower(User.email).like(like) | func.lower(User.display_name).like(like))
    out: list[UserOut] = []
    platform_reader = principal.has_platform(P.ACCESS_READ)
    for u in s.scalars(stmt.limit(500)):
        assigns = list(s.scalars(select(RoleAssignment).where(RoleAssignment.user_id == u.id)))
        visible = [a for a in assigns if _visible_assignment(s, principal, a)]
        if platform_reader or visible or u.id == principal.user.id:
            out.append(_user_out(s, u, visible if not platform_reader else assigns))
    return out


class InviteIn(BaseModel):
    email: EmailStr
    display_name: str = Field(min_length=2, max_length=200)


@router.post("/users", response_model=UserOut, status_code=201)
def invite_user(body: InviteIn, principal: CurrentPrincipal, s: DB) -> UserOut:
    """Pre-register a person by email so roles can be granted before their first sign-in."""
    _require_some_access(principal, P.ACCESS_MANAGE)
    email = str(body.email).lower()
    if s.scalar(select(User).where(User.email == email)) is not None:
        raise conflict("A user with this email already exists")
    u = User(email=email, display_name=body.display_name.strip())
    s.add(u)
    s.flush()
    audit.record(s, principal.actor, "access.user_invited", target_type="user", target_id=str(u.id),
                 details={"email": email})
    return _user_out(s, u, [])


class SetActiveIn(BaseModel):
    active: bool
    reason: str = Field(min_length=5, max_length=1000)


@router.put("/users/{user_id}/active", response_model=UserOut)
def set_active(user_id: uuid.UUID, body: SetActiveIn, principal: CurrentPrincipal, s: DB) -> UserOut:
    if not principal.has_platform(P.ACCESS_MANAGE):
        raise forbidden()
    u = s.get(User, user_id)
    if u is None:
        raise not_found("User")
    if u.id == principal.user.id and not body.active:
        raise conflict("You cannot disable your own account")
    u.is_active = body.active
    audit.record(s, principal.actor, "access.user_enabled" if body.active else "access.user_disabled",
                 target_type="user", target_id=str(u.id), details={"reason": body.reason})
    return _user_out(s, u, list(s.scalars(select(RoleAssignment).where(RoleAssignment.user_id == u.id))))


class GrantIn(BaseModel):
    user_id: uuid.UUID
    role: str
    scope_type: ScopeType
    scope_id: uuid.UUID | None = None


@router.post("/role-assignments", response_model=AssignmentOut, status_code=201)
def grant(body: GrantIn, principal: CurrentPrincipal, s: DB) -> AssignmentOut:
    rd = ROLES.get(body.role)
    if rd is None:
        raise Problem(422, "validation", f"Unknown role '{body.role}'")
    if body.scope_type not in rd.allowed_scopes:
        raise Problem(422, "validation", f"{rd.label} can be granted only at: {', '.join(sorted(rd.allowed_scopes))}")
    if (body.scope_type == "platform") != (body.scope_id is None):
        raise Problem(422, "validation", "Platform grants have no scope; every other grant needs one")
    if body.scope_type == "project":
        raise Problem(422, "validation", "Project-level grants become available with projects")
    model = {"programme": Programme, "partner": Partner, "tenant": Tenant}.get(body.scope_type)
    if model is not None and s.get(model, body.scope_id) is None:
        raise Problem(422, "validation", f"Unknown {body.scope_type}")
    if s.get(User, body.user_id) is None:
        raise not_found("User")
    partner_prog = None
    if body.scope_type == "partner":
        partner = s.get(Partner, body.scope_id)
        partner_prog = partner.programme_id if partner else None
    if not can_grant(principal.grants, body.role, body.scope_type, body.scope_id,
                     _scope_tenant(s, body.scope_type, body.scope_id), partner_prog):
        audit.record(s, principal.actor, "access.role_grant_denied", outcome="denied", target_type="user",
                     target_id=str(body.user_id), details=body.model_dump(mode="json"))
        s.commit()
        raise forbidden("You can grant roles only inside the scopes you manage.")
    exists = s.scalar(select(RoleAssignment).where(
        RoleAssignment.user_id == body.user_id, RoleAssignment.role == body.role,
        RoleAssignment.scope_type == body.scope_type,
        RoleAssignment.scope_id.is_(None) if body.scope_id is None else RoleAssignment.scope_id == body.scope_id))
    if exists:
        raise conflict("This person already has this role in this scope")
    a = RoleAssignment(user_id=body.user_id, role=body.role, scope_type=body.scope_type, scope_id=body.scope_id,
                       granted_by=principal.user.id)
    s.add(a)
    s.flush()
    tenant_id = body.scope_id if body.scope_type == "tenant" else None
    audit.record(s, principal.actor, "access.role_granted", tenant_id=tenant_id, target_type="user",
                 target_id=str(body.user_id), details={"role": body.role, "scope_type": body.scope_type,
                                                       "scope_id": str(body.scope_id) if body.scope_id else None})
    s.refresh(a)
    return AssignmentOut(id=a.id, role=a.role, role_label=rd.label, scope_type=a.scope_type, scope_id=a.scope_id,
                         scope_name=scope_name(s, a.scope_type, a.scope_id), granted_at=a.granted_at)


@router.delete("/role-assignments/{assignment_id}", status_code=204, response_class=Response, response_model=None)
def revoke(assignment_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> None:
    a = s.get(RoleAssignment, assignment_id)
    if a is None:
        raise not_found("Role assignment")
    partner_prog = None
    if a.scope_type == "partner" and a.scope_id:
        p = s.get(Partner, a.scope_id)
        partner_prog = p.programme_id if p else None
    if not can_grant(principal.grants, a.role, a.scope_type, a.scope_id, _scope_tenant(s, a.scope_type, a.scope_id),
                     partner_prog):
        raise forbidden("You can remove roles only inside the scopes you manage.")
    if a.role == ADMIN_ROLE:
        admins = s.scalar(select(func.count()).select_from(RoleAssignment).where(RoleAssignment.role == ADMIN_ROLE))
        if (admins or 0) <= 1:
            raise conflict("The last platform administrator cannot be removed")
    details = {"role": a.role, "scope_type": a.scope_type, "scope_id": str(a.scope_id) if a.scope_id else None}
    user_id = a.user_id
    s.delete(a)
    audit.record(s, principal.actor, "access.role_revoked",
                 tenant_id=a.scope_id if a.scope_type == "tenant" else None, target_type="user",
                 target_id=str(user_id), details=details)

