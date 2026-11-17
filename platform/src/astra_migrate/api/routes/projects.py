"""Projects, blueprints, decisions and templates (E03, CF-01..CF-05)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.api.errors import Problem, conflict, forbidden, not_found
from astra_migrate.blueprints import repo
from astra_migrate.blueprints import service as bps
from astra_migrate.blueprints.model import json_schema
from astra_migrate.db.control import get_session
from astra_migrate.db.models import (
    BlueprintApproval,
    BlueprintTemplate,
    BlueprintVersion,
    Decision,
    Project,
    User,
)
from astra_migrate.observability import tag_current
from astra_migrate.security.principal import CurrentPrincipal, project_for, tenant_for
from astra_migrate.security.rbac import P

router = APIRouter(tags=["blueprints"])
DB = Annotated[Session, Depends(get_session)]


def _bp_err(e: bps.BlueprintError) -> Problem:
    return Problem(422, "blueprint-invalid", str(e))


# =========================================================================== projects

class ProjectIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=4000)
    template: str | None = Field(default=None, description="Blueprint template name to copy as version 1")


class VersionSummary(BaseModel):
    number: int
    status: str
    message: str
    author_name: str
    created_at: datetime
    commit_sha: str
    template: str | None


class ProjectOut(BaseModel):
    id: uuid.UUID
    tenant_id: uuid.UUID
    tenant_name: str
    name: str
    description: str
    status: str
    created_at: datetime
    latest_version: VersionSummary | None
    approved_version: int | None
    planning_gate: dict[str, Any]
    permissions: list[str]
    roles: list[str]


def _vsum(s: Session, v: BlueprintVersion) -> VersionSummary:
    author = s.get(User, v.author_id)
    return VersionSummary(number=v.number, status=v.status, message=v.message,
                          author_name=author.display_name if author else "unknown", created_at=v.created_at,
                          commit_sha=v.commit_sha, template=v.template)


def _project_out(s: Session, principal: CurrentPrincipal, p: Project) -> ProjectOut:
    from astra_migrate.db.models import Tenant
    t = s.get(Tenant, p.tenant_id)
    assert t is not None
    latest = bps.latest(s, p.id)
    approved = s.scalar(select(BlueprintVersion.number).where(BlueprintVersion.project_id == p.id,
                                                              BlueprintVersion.status == "approved"))
    perms = sorted(x.value for x in P if principal.has_on_project(x, t, p.id))
    return ProjectOut(id=p.id, tenant_id=t.id, tenant_name=t.name, name=p.name, description=p.description,
                      status=p.status, created_at=p.created_at, latest_version=_vsum(s, latest) if latest else None,
                      approved_version=approved, planning_gate=bps.planning_gate(s, t, p), permissions=perms,
                      roles=sorted(principal.roles_on_project(t, p.id)))


@router.get("/tenants/{tenant_id}/projects", response_model=list[ProjectOut])
def list_projects(tenant_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[ProjectOut]:
    t = tenant_for(s, principal, tenant_id, P.TENANT_READ)
    rows = s.scalars(select(Project).where(Project.tenant_id == t.id).order_by(Project.name))
    return [_project_out(s, principal, p) for p in rows if principal.has_on_project(P.TENANT_READ, t, p.id)]


@router.post("/tenants/{tenant_id}/projects", response_model=ProjectOut, status_code=201)
def create_project(tenant_id: uuid.UUID, body: ProjectIn, principal: CurrentPrincipal, s: DB) -> ProjectOut:
    t = tenant_for(s, principal, tenant_id, P.PROJECT_CREATE)
    if t.status != "active":
        raise conflict(f"The tenant is {t.status}; projects can be created only in active tenants.")
    tpl = None
    if body.template:
        tpl = s.scalar(select(BlueprintTemplate).where(BlueprintTemplate.name == body.template))
        if tpl is None:
            raise Problem(422, "validation", "Unknown template",
                          errors=[{"field": "template", "message": "Unknown template"}])
    p = Project(tenant_id=t.id, name=body.name.strip(), description=body.description.strip(),
                created_by=principal.user.id)
    s.add(p)
    try:
        s.flush()
    except IntegrityError as e:
        raise Problem(422, "validation", "A project with this name already exists in the tenant",
                      errors=[{"field": "name", "message": "A project with this name already exists"}]) from e
    tag_current(tenant_id=str(t.id), project_id=str(p.id))
    audit.record(s, principal.actor, "project.created", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"name": p.name, "template": body.template})
    if tpl is not None:
        try:
            bps.save_version(s, t, p, tpl.yaml_text, f"Created from template '{tpl.name}'", principal.user,
                             principal.actor, template=tpl.name)
        except bps.BlueprintError as e:
            raise _bp_err(e) from e
    return _project_out(s, principal, p)


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> ProjectOut:
    _, p = project_for(s, principal, project_id, None)
    return _project_out(s, principal, p)


# =========================================================================== blueprint versions

class ApprovalOut(BaseModel):
    user_name: str
    role: str
    decision: str
    reason: str
    decided_at: datetime


class VersionDetail(VersionSummary):
    yaml_text: str
    content: dict[str, Any]
    validation: dict[str, Any]
    required_roles: list[str]
    approvals: list[ApprovalOut]
    git_verified: bool
    can_approve_as: list[str]


@router.get("/projects/{project_id}/blueprint/versions", response_model=list[VersionSummary])
def list_versions(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[VersionSummary]:
    _, p = project_for(s, principal, project_id, None)
    rows = s.scalars(select(BlueprintVersion).where(BlueprintVersion.project_id == p.id)
                     .order_by(BlueprintVersion.number.desc()))
    return [_vsum(s, v) for v in rows]


def _version(s: Session, project_id: uuid.UUID, number: int) -> BlueprintVersion:
    v = s.scalar(select(BlueprintVersion).where(BlueprintVersion.project_id == project_id,
                                                BlueprintVersion.number == number))
    if v is None:
        raise not_found("Blueprint version")
    return v


@router.get("/projects/{project_id}/blueprint/versions/{number}", response_model=VersionDetail)
def get_version(project_id: uuid.UUID, number: int, principal: CurrentPrincipal, s: DB) -> VersionDetail:
    t, p = project_for(s, principal, project_id, None)
    v = _version(s, p.id, number)
    val = bps.validate(s, t, p, v.content)
    approvals = []
    for a in s.scalars(select(BlueprintApproval).where(BlueprintApproval.version_id == v.id)
                       .order_by(BlueprintApproval.decided_at)):
        u = s.get(User, a.user_id)
        approvals.append(ApprovalOut(user_name=u.display_name if u else "unknown", role=a.role, decision=a.decision,
                                     reason=a.reason, decided_at=a.decided_at))
    required = (v.content.get("approvals") or {}).get("blueprint") or ["migration_lead", "customer_data_owner"]
    try:
        verified = repo.read_at(t.id, p.id, v.commit_sha) == v.yaml_text
    except Exception:
        verified = False
    given = {a.role for a in approvals if a.decision == "approve"}
    mine = s.scalar(select(BlueprintApproval.id).where(BlueprintApproval.version_id == v.id,
                                                       BlueprintApproval.user_id == principal.user.id)) is not None
    can_as = [] if (mine or v.status != "draft" or not principal.has_on_project(P.BLUEPRINT_APPROVE, t, p.id)) else [
        r for r in required if r in principal.roles_on_project(t, p.id) and r not in given]
    return VersionDetail(**_vsum(s, v).model_dump(), yaml_text=v.yaml_text, content=v.content,
                         validation=val.to_json(), required_roles=list(required), approvals=approvals,
                         git_verified=verified, can_approve_as=can_as)


class BlueprintIn(BaseModel):
    yaml_text: str | None = Field(default=None, max_length=500_000)
    content: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _one(self) -> BlueprintIn:
        if (self.yaml_text is None) == (self.content is None):
            raise ValueError("Send either yaml_text (file) or content (form), not both")
        return self

    def text(self) -> str:
        return self.yaml_text if self.yaml_text is not None else bps.to_yaml(self.content or {})


class SaveIn(BlueprintIn):
    message: str = Field(min_length=5, max_length=2000, description="Why this version is being saved")


@router.post("/projects/{project_id}/blueprint/versions", response_model=VersionDetail, status_code=201)
def save(project_id: uuid.UUID, body: SaveIn, principal: CurrentPrincipal, s: DB) -> VersionDetail:
    t, p = project_for(s, principal, project_id, P.BLUEPRINT_EDIT)
    try:
        v, _ = bps.save_version(s, t, p, body.text(), body.message, principal.user, principal.actor)
    except bps.BlueprintError as e:
        raise _bp_err(e) from e
    s.flush()
    return get_version(project_id, v.number, principal, s)


@router.post("/projects/{project_id}/blueprint/validate")
def validate_draft(project_id: uuid.UUID, body: BlueprintIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Check unsaved text or form content. Nothing is stored."""
    t, p = project_for(s, principal, project_id, None)
    try:
        content = body.content if body.content is not None else bps.parse_yaml(body.yaml_text or "")
    except bps.BlueprintError as e:
        return {"ok": False, "blocking": 1, "warnings": 0, "composition": None, "open_decisions": [],
                "issues": [{"severity": "blocking", "code": "yaml", "path": "(file)", "message": str(e),
                            "fix": "Correct the YAML syntax."}]}
    return bps.validate(s, t, p, content).to_json()


class ConvertOut(BaseModel):
    yaml_text: str
    content: dict[str, Any]


@router.post("/blueprints/convert", response_model=ConvertOut)
def convert(body: BlueprintIn, _: CurrentPrincipal) -> ConvertOut:
    """Keep the form and the file in sync: YAML -> content, or content -> canonical YAML."""
    try:
        if body.yaml_text is not None:
            return ConvertOut(yaml_text=body.yaml_text, content=bps.parse_yaml(body.yaml_text))
        text = bps.to_yaml(body.content or {})
        return ConvertOut(yaml_text=text, content=body.content or {})
    except bps.BlueprintError as e:
        raise _bp_err(e) from e


@router.get("/blueprints/schema")
def blueprint_schema(_: CurrentPrincipal) -> dict[str, Any]:
    return json_schema()


@router.get("/projects/{project_id}/blueprint/diff")
def version_diff(project_id: uuid.UUID, from_version: int, to_version: int, principal: CurrentPrincipal,
                 s: DB) -> dict[str, Any]:
    _, p = project_for(s, principal, project_id, None)
    a, b = _version(s, p.id, from_version), _version(s, p.id, to_version)
    return {"from": _vsum(s, a).model_dump(mode="json"), "to": _vsum(s, b).model_dump(mode="json"),
            **bps.diff(a.content, b.content)}


class ApproveIn(BaseModel):
    approve: bool
    reason: str = Field(default="", max_length=2000)


@router.post("/projects/{project_id}/blueprint/versions/{number}/decision", response_model=VersionDetail)
def approve(project_id: uuid.UUID, number: int, body: ApproveIn, principal: CurrentPrincipal,
            s: DB) -> VersionDetail:
    t, p = project_for(s, principal, project_id, P.BLUEPRINT_APPROVE)
    v = _version(s, p.id, number)
    try:
        bps.approve_or_reject(s, t, p, v, principal.user, principal.roles_on_project(t, p.id), principal.actor,
                              approve=body.approve, reason=body.reason)
    except bps.BlueprintError as e:
        raise _bp_err(e) from e
    s.flush()
    return get_version(project_id, number, principal, s)


@router.get("/projects/{project_id}/planning-gate")
def planning_gate(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    return bps.planning_gate(s, t, p)


# =========================================================================== decisions

class DecisionOut(BaseModel):
    id: uuid.UUID
    kind: Literal["setting_conflict", "loosening"]
    subject: str
    status: Literal["open", "decided", "rejected"]
    context: dict[str, Any]
    chosen_value: Any
    reason: str | None
    requested_by_name: str | None
    decided_by_name: str | None
    decided_at: datetime | None
    created_at: datetime
    can_decide: bool


def _decision_out(s: Session, d: Decision, can: bool) -> DecisionOut:
    req = s.get(User, d.requested_by) if d.requested_by else None
    dec = s.get(User, d.decided_by) if d.decided_by else None
    return DecisionOut(id=d.id, kind=d.kind,
                       subject=d.subject, status=d.status,
                       context=d.context, chosen_value=(d.chosen_value or {}).get("value"), reason=d.reason,
                       requested_by_name=req.display_name if req else None,
                       decided_by_name=dec.display_name if dec else None, decided_at=d.decided_at,
                       created_at=d.created_at, can_decide=can and d.status == "open")


_DECIDE_PERM = {"setting_conflict": P.DECIDE_CONFLICT, "loosening": P.APPROVE_LOOSENING}


@router.get("/projects/{project_id}/decisions", response_model=list[DecisionOut])
def list_decisions(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[DecisionOut]:
    t, p = project_for(s, principal, project_id, None)
    rows = s.scalars(select(Decision).where(Decision.project_id == p.id).order_by(Decision.created_at.desc()))
    return [_decision_out(s, d, principal.has_on_project(_DECIDE_PERM[d.kind], t, p.id)) for d in rows]


class DecideIn(BaseModel):
    reason: str = Field(min_length=10, max_length=2000)
    chosen_value: int | float | bool | str | None = None
    approve: bool = True


@router.post("/decisions/{decision_id}", response_model=DecisionOut)
def decide(decision_id: uuid.UUID, body: DecideIn, principal: CurrentPrincipal, s: DB) -> DecisionOut:
    d = s.get(Decision, decision_id)
    if d is None:
        raise not_found("Decision")
    t, _ = project_for(s, principal, d.project_id, _DECIDE_PERM[d.kind])
    try:
        bps.decide(s, d, principal.actor, principal.user, approve=body.approve, reason=body.reason,
                   chosen_value=body.chosen_value)
    except bps.BlueprintError as e:
        raise _bp_err(e) from e
    return _decision_out(s, d, True)


# =========================================================================== templates

class TemplateIn(BaseModel):
    name: str = Field(min_length=3, max_length=100, pattern=r"^[a-z0-9][a-z0-9-]*$")
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=4000)
    yaml_text: str = Field(min_length=10, max_length=500_000)


class TemplateOut(BaseModel):
    id: uuid.UUID
    name: str
    title: str
    description: str
    yaml_text: str
    created_by: str
    created_at: datetime


def _tpl(t: BlueprintTemplate) -> TemplateOut:
    return TemplateOut(id=t.id, name=t.name, title=t.title, description=t.description, yaml_text=t.yaml_text,
                       created_by=t.created_by, created_at=t.created_at)


@router.get("/blueprint-templates", response_model=list[TemplateOut])
def list_templates(_: CurrentPrincipal, s: DB) -> list[TemplateOut]:
    return [_tpl(t) for t in s.scalars(select(BlueprintTemplate).order_by(BlueprintTemplate.title))]


@router.post("/blueprint-templates", response_model=TemplateOut, status_code=201)
def create_template(body: TemplateIn, principal: CurrentPrincipal, s: DB) -> TemplateOut:
    if not principal.has_platform(P.TEMPLATE_MANAGE):
        raise forbidden()
    try:
        bps.parse_yaml(body.yaml_text)
    except bps.BlueprintError as e:
        raise _bp_err(e) from e
    t = BlueprintTemplate(name=body.name, title=body.title, description=body.description, yaml_text=body.yaml_text,
                          created_by=principal.actor.name)
    s.add(t)
    try:
        s.flush()
    except IntegrityError as e:
        raise conflict("A template with this name already exists") from e
    audit.record(s, principal.actor, "template.created", target_type="blueprint_template", target_id=str(t.id),
                 details={"name": t.name})
    return _tpl(t)
