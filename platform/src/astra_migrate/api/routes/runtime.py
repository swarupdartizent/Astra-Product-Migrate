"""Project-level runtime: agent pins, agent runs, the review queue and stage status (E02.F1.S1, E02.F1.S3)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit, stages
from astra_migrate.agents import registry
from astra_migrate.agents.guardrails import reveal_hidden
from astra_migrate.agents.jobs import read_content, start_run
from astra_migrate.api.errors import Problem, conflict, forbidden, invalid, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import Agent, AgentRun, AgentVersion, ProjectAgentPin, ReviewItem, Tenant, User
from astra_migrate.security.principal import CurrentPrincipal, project_for
from astra_migrate.security.rbac import ROLES, P
from astra_migrate.tenancy.service import tenant_connection
from astra_migrate.vault import get_vault

router = APIRouter(tags=["runtime"])
DB = Annotated[Session, Depends(get_session)]


def _agent_problem(e: registry.AgentError) -> Problem:
    if e.issues:
        return Problem(422, "validation", "Some fields need attention", str(e),
                       errors=[{"field": f, "message": m} for f, m in e.issues])
    return conflict(str(e))


# ------------------------------------------------------------------ pins

class PinOut(BaseModel):
    agent: str
    title: str
    team: str
    pinned_version: str | None
    pinned_status: str | None
    pinned_by: str | None
    pinned_at: datetime | None
    reason: str | None
    released_versions: list[str]
    newer_release: str | None


@router.get("/projects/{project_id}/agents", response_model=list[PinOut])
def project_agents(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[PinOut]:
    _, p = project_for(s, principal, project_id, None)
    out: list[PinOut] = []
    for a in s.scalars(select(Agent).order_by(Agent.team, Agent.name)):
        pin = s.get(ProjectAgentPin, (p.id, a.name))
        released = [v.version for v in s.scalars(select(AgentVersion).where(
            AgentVersion.agent_name == a.name, AgentVersion.status == "released")
            .order_by(AgentVersion.version_sort.desc()))]
        pv = s.scalar(select(AgentVersion).where(AgentVersion.agent_name == a.name,
                                                 AgentVersion.version == pin.version)) if pin else None
        by = s.get(User, pin.pinned_by) if pin else None
        out.append(PinOut(agent=a.name, title=a.title, team=a.team, pinned_version=pin.version if pin else None,
                          pinned_status=pv.status if pv else None, pinned_by=by.display_name if by else None,
                          pinned_at=pin.pinned_at if pin else None, reason=pin.reason if pin else None,
                          released_versions=released,
                          newer_release=released[0] if released and pin and released[0] != pin.version else None))
    return out


class PinIn(BaseModel):
    version: str
    reason: str = Field(min_length=5, max_length=1000)


@router.put("/projects/{project_id}/agents/{agent}", response_model=list[PinOut])
def pin_agent(project_id: uuid.UUID, agent: str, body: PinIn, principal: CurrentPrincipal, s: DB) -> list[PinOut]:
    _, p = project_for(s, principal, project_id, P.AGENT_PIN)
    try:
        registry.pin(s, p, agent, body.version, principal.user, principal.actor, body.reason)
    except registry.AgentError as e:
        raise _agent_problem(e) from e
    return project_agents(project_id, principal, s)


# ------------------------------------------------------------------ runs

class RunOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    agent: str
    agent_version: str
    parent_run_id: uuid.UUID | None
    status: str
    status_detail: str | None
    requested_by: str
    requested_by_type: str
    job_id: uuid.UUID | None
    model_calls: int
    tool_calls: int
    denied_tool_calls: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    trace_id: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class RunDetail(RunOut):
    objective: str | None
    output: str | None
    events: list[dict[str, Any]]


def _run_out(r: AgentRun) -> RunOut:
    return RunOut(id=r.id, project_id=r.project_id, agent=r.agent_name, agent_version=r.agent_version,
                  parent_run_id=r.parent_run_id, status=r.status, status_detail=r.status_detail,
                  requested_by=str(r.requested_by.get("name", "")),
                  requested_by_type=str(r.requested_by.get("type", "")),
                  job_id=r.job_id, model_calls=r.model_calls, tool_calls=r.tool_calls,
                  denied_tool_calls=r.denied_tool_calls, input_tokens=r.input_tokens, output_tokens=r.output_tokens,
                  cost_usd=r.cost_usd, trace_id=r.trace_id, created_at=r.created_at, started_at=r.started_at,
                  finished_at=r.finished_at)


class RunIn(BaseModel):
    agent: str
    objective: str = Field(min_length=10, max_length=8000)


@router.post("/projects/{project_id}/agent-runs", response_model=RunOut, status_code=202)
def start_agent_run(project_id: uuid.UUID, body: RunIn, principal: CurrentPrincipal, s: DB) -> RunOut:
    _, p = project_for(s, principal, project_id, P.AGENT_RUN)
    try:
        run = start_run(s, p, body.agent, body.objective.strip(), principal.actor)
    except registry.AgentError as e:
        raise _agent_problem(e) from e
    return _run_out(run)


@router.get("/projects/{project_id}/agent-runs", response_model=list[RunOut])
def list_runs(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
              limit: Annotated[int, Query(ge=1, le=200)] = 50) -> list[RunOut]:
    _, p = project_for(s, principal, project_id, None)
    return [_run_out(r) for r in s.scalars(select(AgentRun).where(AgentRun.project_id == p.id)
                                           .order_by(AgentRun.created_at.desc()).limit(limit))]


@router.get("/agent-runs/{run_id}", response_model=RunDetail)
def get_run(run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> RunDetail:
    r = s.get(AgentRun, run_id)
    if r is None:
        raise not_found("Agent run")
    t, _ = project_for(s, principal, r.project_id, None)
    content = read_content(t, r.id)
    return RunDetail(**_run_out(r).model_dump(), objective=content["objective"], output=content["output"],
                     events=content["events"])


# ------------------------------------------------------------------ review queue

class ReviewOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    kind: str
    title: str
    question: str
    options: list[str]
    context: dict[str, Any]
    owner_role: str
    owner_role_label: str
    owner_user: str | None
    requested_by: str
    requested_by_type: str
    agent_run_id: uuid.UUID | None
    status: str
    resolution: str | None
    resolution_note: str | None
    resolved_by: str | None
    resolved_at: datetime | None
    created_at: datetime
    can_resolve: bool
    flagged_text: str | None = None


def _review_out(s: Session, principal: Any, t: Tenant, r: ReviewItem, with_text: bool = False) -> ReviewOut:
    owner = s.get(User, r.owner_user_id) if r.owner_user_id else None
    by = s.get(User, r.resolved_by) if r.resolved_by else None
    text = None
    if with_text and r.kind == "screening_flag" and r.context.get("flag_id"):
        with tenant_connection(t, get_vault()) as conn:
            row = conn.execute("SELECT excerpt FROM estate.screening_flags WHERE id = %s",
                               (uuid.UUID(r.context["flag_id"]),)).fetchone()
        text = reveal_hidden(row[0]) if row else None
    return ReviewOut(id=r.id, project_id=r.project_id, kind=r.kind, title=r.title, question=r.question,
                     options=list(r.options), context=r.context, owner_role=r.owner_role,
                     owner_role_label=ROLES[r.owner_role].label if r.owner_role in ROLES else r.owner_role,
                     owner_user=owner.display_name if owner else None,
                     requested_by=str(r.requested_by.get("name", "")),
                     requested_by_type=str(r.requested_by.get("type", "")), agent_run_id=r.agent_run_id,
                     status=r.status, resolution=r.resolution, resolution_note=r.resolution_note,
                     resolved_by=by.display_name if by else None, resolved_at=r.resolved_at,
                     created_at=r.created_at, can_resolve=_can_resolve(principal, t, r)[0], flagged_text=text)


def _can_resolve(principal: Any, t: Tenant, r: ReviewItem) -> tuple[bool, str]:
    if r.status != "open":
        return False, f"The item is {r.status}."
    if not principal.has_on_project(P.REVIEW_RESOLVE, t, r.project_id):
        return False, "You cannot resolve review items on this project."
    if r.owner_user_id is not None and r.owner_user_id == principal.user.id:
        return True, ""
    if r.owner_role in principal.roles_on_project(t, r.project_id):
        return True, ""
    label = ROLES[r.owner_role].label if r.owner_role in ROLES else r.owner_role
    return False, f"This item is owned by the {label} role."


@router.get("/projects/{project_id}/reviews", response_model=list[ReviewOut])
def list_reviews(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
                 status: Literal["open", "resolved", "dismissed", "all"] = "open",
                 limit: Annotated[int, Query(ge=1, le=500)] = 200) -> list[ReviewOut]:
    t, p = project_for(s, principal, project_id, None)
    stmt = select(ReviewItem).where(ReviewItem.project_id == p.id)
    if status != "all":
        stmt = stmt.where(ReviewItem.status == status)
    rows = s.scalars(stmt.order_by(ReviewItem.created_at.desc()).limit(limit))
    return [_review_out(s, principal, t, r) for r in rows]


@router.get("/review-items/{item_id}", response_model=ReviewOut)
def get_review(item_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> ReviewOut:
    r = s.get(ReviewItem, item_id)
    if r is None:
        raise not_found("Review item")
    t, _ = project_for(s, principal, r.project_id, None)
    return _review_out(s, principal, t, r, with_text=True)


class ResolveIn(BaseModel):
    action: Literal["resolve", "dismiss"]
    resolution: str | None = Field(default=None, description="One of the item's options (for resolve)")
    note: str = Field(default="", max_length=4000)


@router.post("/review-items/{item_id}/resolve", response_model=ReviewOut)
def resolve_review(item_id: uuid.UUID, body: ResolveIn, principal: CurrentPrincipal, s: DB) -> ReviewOut:
    r = s.get(ReviewItem, item_id, with_for_update=True)
    if r is None:
        raise not_found("Review item")
    t, _ = project_for(s, principal, r.project_id, None)
    ok, why = _can_resolve(principal, t, r)
    if not ok:
        if r.status != "open":
            raise conflict(why)
        raise forbidden(why)
    if body.action == "resolve":
        if body.resolution not in r.options:
            raise invalid("resolution", "Choose one of the item's options.")
        r.status, r.resolution = "resolved", body.resolution
    else:
        if len(body.note.strip()) < 10:
            raise invalid("note", "Say why the item is dismissed (at least 10 characters).")
        r.status = "dismissed"
    r.resolution_note, r.resolved_by, r.resolved_at = body.note.strip(), principal.user.id, datetime.now(UTC)
    s.flush()
    audit.record(s, principal.actor, f"review.{r.status}", tenant_id=t.id, project_id=r.project_id,
                 target_type="review_item", target_id=str(r.id),
                 details={"kind": r.kind, "title": r.title, "resolution": r.resolution, "note": r.resolution_note,
                          "owner_role": r.owner_role, "requested_by": r.requested_by})
    return _review_out(s, principal, t, r)


# ------------------------------------------------------------------ stages

class StageOut(BaseModel):
    stage: str
    title: str
    status: str
    note: str
    updated_by: str | None
    updated_by_type: str | None
    updated_at: datetime | None


@router.get("/projects/{project_id}/stages", response_model=list[StageOut])
def list_stages(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[StageOut]:
    _, p = project_for(s, principal, project_id, None)
    return [StageOut.model_validate(x) for x in stages.overview(s, p.id)]


class StageIn(BaseModel):
    status: Literal["not_started", "blocked", "in_progress", "done"]
    note: str = Field(default="", max_length=1000)


@router.put("/projects/{project_id}/stages/{stage}", response_model=list[StageOut])
def move_stage(project_id: uuid.UUID, stage: str, body: StageIn, principal: CurrentPrincipal, s: DB
               ) -> list[StageOut]:
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    try:
        res = stages.move(s, t, p, stage, body.status, body.note, principal.actor)
    except stages.StageError as e:
        raise invalid("stage", str(e)) from e
    if not res.allowed:
        s.commit()  # keep the audit record of the refused attempt
        raise Problem(409, "gate-closed", "The stage gate refused this change", " ".join(res.reasons),
                      errors=[{"field": "status", "message": m} for m in res.reasons])
    return list_stages(project_id, principal, s)
