"""The signed-in person behind a request, and the checks every endpoint uses.

- Users are provisioned just in time from their token. A person invited by email (role granted
  before first sign-in) is linked on first sign-in only if the identity provider verified the email.
- Tenant-scoped access also enforces the tenant's policy: multi-factor sign-in and session timeout.
- Every denied attempt on a tenant is written to the audit log.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.api.errors import Problem, forbidden, not_found
from astra_migrate.config import get_settings
from astra_migrate.db.control import get_session, session_scope
from astra_migrate.db.models import Project, RoleAssignment, Tenant, User
from astra_migrate.security.oidc import Claims, OidcValidator, TokenError
from astra_migrate.security.rbac import (
    ADMIN_ROLE,
    Grant,
    P,
    TenantScope,
    can_read_tenant,
    has_platform_permission,
    has_project_permission,
    has_tenant_permission,
    permissions_for,
    roles_on_project,
)


@lru_cache(maxsize=1)
def get_validator() -> OidcValidator:
    s = get_settings()
    return OidcValidator(s.issuers, s.oidc_audience)


@dataclass
class Principal:
    user: User
    claims: Claims
    grants: list[Grant]

    @property
    def actor(self) -> audit.Actor:
        return audit.Actor("user", str(self.user.id), self.user.display_name)

    @property
    def mfa(self) -> bool:
        return bool(set(self.claims.amr) & get_settings().mfa_amr_values)

    def permissions(self) -> set[P]:
        return permissions_for(self.grants)

    def has_platform(self, perm: P) -> bool:
        return has_platform_permission(self.grants, perm)

    def has_on_tenant(self, perm: P, t: Tenant) -> bool:
        if perm == P.TENANT_READ:
            return can_read_tenant(self.grants, scope_of(t))
        return has_tenant_permission(self.grants, perm, scope_of(t))

    def has_on_project(self, perm: P, t: Tenant, project_id: uuid.UUID) -> bool:
        return has_project_permission(self.grants, perm, scope_of(t), project_id)

    def roles_on_project(self, t: Tenant, project_id: uuid.UUID) -> set[str]:
        return roles_on_project(self.grants, scope_of(t), project_id)


def scope_of(t: Tenant) -> TenantScope:
    return TenantScope(t.id, t.programme_id, t.partner_id)


def _bearer(request: Request) -> str:
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("bearer "):
        raise Problem(401, "unauthenticated", "Sign-in required", headers={"WWW-Authenticate": "Bearer"})
    return h[7:].strip()


def _provision(session: Session, c: Claims) -> User:
    user = session.scalar(select(User).where(User.issuer == c.issuer, User.subject == c.subject))
    now = datetime.now(UTC)
    if user is None:
        if not c.email:
            raise Problem(403, "no-email", "Your identity provider did not send an email address",
                          "Ask your administrator to release the email claim to this application.")
        invited = session.scalar(select(User).where(User.email == c.email))
        if invited is not None:
            if invited.issuer is not None:
                raise Problem(403, "identity-conflict", "This email is linked to a different sign-in",
                              "Ask a platform administrator to review your account.")
            if not c.email_verified:
                raise Problem(403, "email-unverified", "Your email address is not verified",
                              "Verify your email with your identity provider, then sign in again.")
            invited.issuer, invited.subject = c.issuer, c.subject
            user = invited
            audit.record(session, audit.Actor("user", str(user.id), user.display_name), "identity.linked",
                         target_type="user", target_id=str(user.id), details={"issuer": c.issuer})
        else:
            user = User(email=c.email, display_name=c.name or c.email, issuer=c.issuer, subject=c.subject)
            session.add(user)
            session.flush()
            audit.record(session, audit.Actor("user", str(user.id), user.display_name), "identity.provisioned",
                         target_type="user", target_id=str(user.id), details={"issuer": c.issuer})
    if not user.is_active:
        raise Problem(403, "account-disabled", "Your account is disabled")
    if c.name and user.display_name != c.name:
        user.display_name = c.name
    user.last_seen_at = now

    # Bootstrap: configured administrator emails always hold platform_admin (verified email only).
    if c.email and c.email_verified and c.email in get_settings().bootstrap_admins:
        exists = session.scalar(select(RoleAssignment).where(
            RoleAssignment.user_id == user.id, RoleAssignment.role == ADMIN_ROLE,
            RoleAssignment.scope_type == "platform"))
        if exists is None:
            session.add(RoleAssignment(user_id=user.id, role=ADMIN_ROLE, scope_type="platform", scope_id=None))
            audit.record(session, audit.Actor.system("bootstrap"), "access.role_granted", target_type="user",
                         target_id=str(user.id), details={"role": ADMIN_ROLE, "scope_type": "platform",
                                                          "reason": "configured bootstrap administrator"})
    session.flush()
    return user


def load_grants(session: Session, user_id: uuid.UUID) -> list[Grant]:
    rows = session.execute(select(RoleAssignment, Project.tenant_id)
                           .outerjoin(Project, (RoleAssignment.scope_type == "project")
                                      & (Project.id == RoleAssignment.scope_id))
                           .where(RoleAssignment.user_id == user_id)).all()
    return [Grant(r.role, r.scope_type, r.scope_id, tid) for r, tid in rows]


def current_principal(request: Request, session: Annotated[Session, Depends(get_session)]) -> Principal:
    token = _bearer(request)
    try:
        claims = get_validator().validate(token)
    except TokenError as e:
        raise Problem(401, "invalid-token", "Your sign-in is not valid", e.reason,
                      headers={"WWW-Authenticate": 'Bearer error="invalid_token"'}) from e
    user = _provision(session, claims)
    principal = Principal(user, claims, load_grants(session, user.id))
    request.state.principal = principal
    return principal


CurrentPrincipal = Annotated[Principal, Depends(current_principal)]


def require_platform(principal: Principal, perm: P) -> None:
    if not principal.has_platform(perm):
        raise forbidden()


def enforce_tenant_policy(principal: Principal, t: Tenant) -> None:
    """Tenant policy applies to everyone acting on the tenant, administrators included."""
    if t.mfa_required and not principal.mfa:
        raise Problem(403, "mfa-required", "Multi-factor sign-in required",
                      f"The tenant '{t.name}' requires multi-factor sign-in. Sign in again with your second factor.")
    started = principal.claims.auth_time or principal.claims.issued_at
    if time.time() - started > t.session_timeout_minutes * 60:
        raise Problem(401, "session-expired", "Your session has expired for this tenant",
                      f"The tenant '{t.name}' allows sessions of {t.session_timeout_minutes} minutes. Sign in again.",
                      headers={"WWW-Authenticate": 'Bearer error="invalid_token"'})


def tenant_for(session: Session, principal: Principal, tenant_id: uuid.UUID, perm: P) -> Tenant:
    """Load a tenant the principal may act on. Tenants outside the principal's scope are reported
    as not found, so their existence is not disclosed."""
    t = session.get(Tenant, tenant_id)
    if t is None or t.status == "deleted":
        raise not_found("Tenant")
    if not principal.has_on_tenant(P.TENANT_READ, t):
        raise not_found("Tenant")
    if not principal.has_on_tenant(perm, t):
        with session_scope() as s:
            audit.record(s, principal.actor, "access.denied", outcome="denied", tenant_id=t.id,
                         target_type="tenant", target_id=str(t.id), details={"permission": perm.value})
        raise forbidden()
    enforce_tenant_policy(principal, t)
    return t


def project_for(session: Session, principal: Principal, project_id: uuid.UUID, perm: P | None
                ) -> tuple[Tenant, Project]:
    """Load a project the principal may act on (perm None = read). Applies the tenant's policy."""
    p = session.get(Project, project_id)
    t = session.get(Tenant, p.tenant_id) if p else None
    if p is None or t is None or t.status == "deleted":
        raise not_found("Project")
    readable = principal.has_on_tenant(P.TENANT_READ, t) and (
        principal.has_on_project(P.TENANT_READ, t, p.id) or any(
            g.scope_type == "project" and g.scope_id == p.id for g in principal.grants))
    if not readable:
        raise not_found("Project")
    if perm is not None and not principal.has_on_project(perm, t, p.id):
        with session_scope() as s:
            audit.record(s, principal.actor, "access.denied", outcome="denied", tenant_id=t.id, project_id=p.id,
                         target_type="project", target_id=str(p.id), details={"permission": perm.value})
        raise forbidden()
    enforce_tenant_policy(principal, t)
    return t, p
