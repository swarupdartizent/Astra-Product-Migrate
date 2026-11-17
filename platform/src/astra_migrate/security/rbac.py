"""Roles, permissions and scope resolution (E01.F2.S2).

A role is granted at a scope: platform, programme, partner, tenant or project. A grant applies to
everything inside its scope: a programme grant covers all tenants in the programme, a partner grant
covers only the tenants assigned to that partner. Partners never see each other's tenants (IB-04).

Later increments add permissions to this table; the scope model does not change.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from enum import StrEnum


class P(StrEnum):
    """Permissions. Values are stable API strings used by the web app for navigation."""

    TENANT_READ = "tenant:read"
    TENANT_CREATE = "tenant:create"
    TENANT_DELETE = "tenant:delete"
    TENANT_POLICY = "tenant:update_policy"
    TENANT_REGION_MIGRATE = "tenant:region_migrate"
    ACCESS_READ = "access:read"
    ACCESS_MANAGE = "access:manage"
    SECRETS_READ = "secrets:read"
    SECRETS_MANAGE = "secrets:manage"
    AUDIT_READ = "audit:read"
    AUDIT_EXPORT = "audit:export"
    AUDIT_VERIFY = "audit:verify"
    OBSERVABILITY_READ = "observability:read"
    PROGRAMME_MANAGE = "programme:manage"


@dataclass(frozen=True)
class RoleDef:
    key: str
    label: str
    description: str
    permissions: frozenset[P]
    allowed_scopes: frozenset[str] = field(default_factory=lambda: frozenset(
        {"platform", "programme", "partner", "tenant", "project"}))


ALL_SCOPES = frozenset({"platform", "programme", "partner", "tenant", "project"})


def _r(key: str, label: str, desc: str, perms: set[P], scopes: set[str] | None = None) -> RoleDef:
    return RoleDef(key, label, desc, frozenset(perms), frozenset(scopes) if scopes else ALL_SCOPES)


ROLES: dict[str, RoleDef] = {r.key: r for r in [
    _r("platform_admin", "Platform administrator", "Runs the platform: tenants, access, secrets and audit.",
       set(P), {"platform"}),
    _r("platform_engineer", "Platform engineer", "Builds and operates the platform; reads traces and cost.",
       {P.TENANT_READ, P.OBSERVABILITY_READ, P.AUDIT_READ}, {"platform"}),
    _r("pack_developer", "Pack developer", "Builds adapters and packs.", {P.TENANT_READ}, {"platform"}),
    _r("ontology_curator", "Ontology and pack curator", "Maintains the ontology, domain packs and shared skills.",
       {P.TENANT_READ}, {"platform"}),
    _r("compliance_curator", "Compliance curator", "Maintains compliance packs and control rules.",
       {P.TENANT_READ, P.AUDIT_READ}, {"platform", "programme"}),
    _r("auditor", "Auditor", "Checks evidence, the audit log and the proof pack.",
       {P.TENANT_READ, P.AUDIT_READ, P.AUDIT_EXPORT, P.AUDIT_VERIFY, P.ACCESS_READ}),
    _r("programme_owner", "Programme owner", "Owns an installed-base programme at the product company.",
       {P.TENANT_READ, P.TENANT_CREATE, P.ACCESS_READ, P.ACCESS_MANAGE, P.AUDIT_READ, P.PROGRAMME_MANAGE,
        P.OBSERVABILITY_READ}, {"platform", "programme"}),
    _r("partner_delivery_lead", "Partner delivery lead", "Leads one partner's migrations within a programme.",
       {P.TENANT_READ, P.ACCESS_READ, P.ACCESS_MANAGE, P.AUDIT_READ, P.SECRETS_READ},
       {"programme", "partner"}),
    _r("migration_lead", "Migration lead", "Runs a customer migration from set-up to sign-off.",
       {P.TENANT_READ, P.ACCESS_READ, P.SECRETS_READ, P.SECRETS_MANAGE, P.AUDIT_READ, P.OBSERVABILITY_READ}),
    _r("data_sme", "Data subject expert", "Reviews data, mappings, code lists and data quality.",
       {P.TENANT_READ}),
    _r("solution_architect", "Solution architect", "Owns target design, customizations, integrations and gaps.",
       {P.TENANT_READ, P.SECRETS_READ}),
    _r("customer_data_owner", "Customer data owner", "Makes business data decisions and signs off reconciliation.",
       {P.TENANT_READ, P.AUDIT_READ}, {"tenant", "project"}),
    _r("customer_it_security_lead", "Customer IT security lead", "Owns the customer's security set-up.",
       {P.TENANT_READ, P.TENANT_POLICY, P.ACCESS_READ, P.AUDIT_READ, P.AUDIT_EXPORT, P.SECRETS_READ,
        P.SECRETS_MANAGE}, {"tenant"}),
    _r("customer_operations_manager", "Operations manager (customer)", "Owns Digital Workers in production.",
       {P.TENANT_READ}, {"tenant", "project"}),
    _r("sales_engineer", "Sales engineer", "Runs pre-sales estimates and fleet scans.",
       {P.TENANT_READ}, {"platform", "programme", "partner"}),
    _r("commercial_manager", "Commercial manager", "Prices work and tracks milestone billing.",
       {P.TENANT_READ}, {"platform", "programme", "partner"}),
    _r("reviewer", "Reviewer", "Approves, rejects or changes proposals in the review workbench.",
       {P.TENANT_READ}),
    _r("test_engineer", "Test engineer", "Owns tests, parity checks and golden datasets.",
       {P.TENANT_READ}),
]}

ADMIN_ROLE = "platform_admin"


@dataclass(frozen=True)
class Grant:
    role: str
    scope_type: str
    scope_id: uuid.UUID | None


@dataclass(frozen=True)
class TenantScope:
    """What a tenant sits inside, used to decide whether a grant covers it."""

    tenant_id: uuid.UUID
    programme_id: uuid.UUID | None
    partner_id: uuid.UUID | None


def grant_covers_tenant(g: Grant, t: TenantScope) -> bool:
    match g.scope_type:
        case "platform":
            return True
        case "programme":
            return t.programme_id is not None and g.scope_id == t.programme_id
        case "partner":
            return t.partner_id is not None and g.scope_id == t.partner_id
        case "tenant":
            return g.scope_id == t.tenant_id
        case _:
            return False  # project grants are resolved through the project's tenant (I2)


def permissions_for(grants: list[Grant]) -> set[P]:
    out: set[P] = set()
    for g in grants:
        rd = ROLES.get(g.role)
        if rd:
            out |= rd.permissions
    return out


def has_platform_permission(grants: list[Grant], perm: P) -> bool:
    return any(g.scope_type == "platform" and perm in ROLES[g.role].permissions for g in grants if g.role in ROLES)


def has_tenant_permission(grants: list[Grant], perm: P, t: TenantScope) -> bool:
    return any(perm in ROLES[g.role].permissions and grant_covers_tenant(g, t) for g in grants if g.role in ROLES)


def can_grant(granter: list[Grant], role: str, scope_type: str, scope_id: uuid.UUID | None,
              scope_tenant: TenantScope | None, scope_programme_of_partner: uuid.UUID | None) -> bool:
    """A person may grant a role only inside a scope they manage access for, and never platform_admin
    unless they are platform_admin themselves."""
    if role == ADMIN_ROLE:
        return has_platform_permission(granter, P.ACCESS_MANAGE) and any(g.role == ADMIN_ROLE for g in granter)
    if has_platform_permission(granter, P.ACCESS_MANAGE):
        return True
    for g in granter:
        if g.role not in ROLES or P.ACCESS_MANAGE not in ROLES[g.role].permissions:
            continue
        if scope_type == "platform":
            continue
        if g.scope_type == scope_type and g.scope_id == scope_id:
            return True
        if g.scope_type == "programme" and scope_type == "partner" and scope_programme_of_partner == g.scope_id:
            return True
        if scope_tenant is not None and scope_type == "tenant" and grant_covers_tenant(g, scope_tenant):
            return True
    return False
