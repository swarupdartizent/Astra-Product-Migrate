"""Review workbench (E16.F1, E21.F1.S1): the risk-sorted queue with filters, the evidence panel with sample values
and precedents, decisions (approve, reject, change, dismiss), named reviewers and the Review Assistant."""

from __future__ import annotations

import uuid
from collections import Counter
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate.agents import registry as agent_registry
from astra_migrate.agents.jobs import start_run
from astra_migrate.api.errors import Problem, forbidden, not_found
from astra_migrate.api.routes.runtime import ReviewOut, _review_out, review_problem
from astra_migrate.db.control import get_session
from astra_migrate.db.models import AgentRun, Project, ProjectAgentPin, ReviewItem, Tenant, User
from astra_migrate.review import evidence as review_evidence
from astra_migrate.review import service as reviews
from astra_migrate.security.principal import CurrentPrincipal, Principal, project_for
from astra_migrate.security.rbac import ROLES, P

router = APIRouter(tags=["review"])
DB = Annotated[Session, Depends(get_session)]
Status = Literal["open", "resolved", "dismissed", "rejected", "changes_requested", "decided", "all"]


def _item(s: Session, principal: Principal, item_id: uuid.UUID, lock: bool = False) -> tuple[Tenant, ReviewItem]:
    r = s.get(ReviewItem, item_id, with_for_update=lock)
    if r is None:
        raise not_found("Review item")
    t, _ = project_for(s, principal, r.project_id, None)
    return t, r


def _agent_of(r: ReviewItem) -> str | None:
    return str(r.requested_by.get("name")) if r.requested_by.get("type") == "agent" else None


# ------------------------------------------------------------------ queue (E16.F1.S1)

class QueueOut(BaseModel):
    items: list[ReviewOut]
    total: int
    facets: dict[str, dict[str, int]]
    groups: list[dict[str, Any]]
    can_decide_any: bool


@router.get("/projects/{project_id}/review-queue", response_model=QueueOut)
def queue(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB, status: Status = "open",
          stream: str | None = None, segment: str | None = None, agent: str | None = None,
          kind: str | None = None, risk: str | None = None, compliance: str | None = None,
          owner_role: str | None = None, mine: bool = False, pattern_key: str | None = None,
          q: Annotated[str | None, Query(max_length=200)] = None,
          offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=200)] = 50) -> QueueOut:
    """Sorted by priority: risk first, then compliance impact, then low confidence; oldest first within a score.
    Facets count the items matching the status filter, before the other filters, so every filter shows its
    options."""
    t, p = project_for(s, principal, project_id, None)
    stmt = select(ReviewItem).where(ReviewItem.project_id == p.id)
    if status == "decided":
        stmt = stmt.where(ReviewItem.status.in_(reviews.DECIDED))
    elif status != "all":
        stmt = stmt.where(ReviewItem.status == status)
    base = list(s.scalars(stmt.limit(5000)))
    facets: dict[str, Counter[str]] = {k: Counter() for k in ("stream", "segment", "agent", "kind", "risk",
                                                              "compliance", "owner_role")}
    for r in base:
        for k, v in (("stream", r.stream), ("segment", r.segment), ("agent", _agent_of(r)), ("kind", r.kind),
                     ("risk", r.risk), ("compliance", r.compliance), ("owner_role", r.owner_role)):
            if v:
                facets[k][v] += 1
    my_roles = principal.roles_on_project(t, p.id)

    def keep(r: ReviewItem) -> bool:
        if (stream and r.stream != stream) or (segment and r.segment != segment) or (agent and _agent_of(r) != agent):
            return False
        if (kind and r.kind != kind) or (risk and r.risk != risk) or (compliance and r.compliance != compliance):
            return False
        if (owner_role and r.owner_role != owner_role) or (pattern_key and r.pattern_key != pattern_key):
            return False
        if mine and not (r.owner_user_id == principal.user.id
                         or (r.owner_user_id is None and r.owner_role in my_roles)):
            return False
        return not q or q.lower() in f"{r.title} {r.question}".lower()

    rows = [r for r in base if keep(r)]
    rows.sort(key=lambda r: (-reviews.priority(r)[0], r.created_at))
    groups = Counter(r.pattern_key for r in rows if r.pattern_key)
    group_titles = {r.pattern_key: r.title for r in rows if r.pattern_key}
    return QueueOut(items=[_review_out(s, principal, t, r) for r in rows[offset:offset + limit]], total=len(rows),
                    facets={k: dict(v.most_common()) for k, v in facets.items()},
                    groups=[{"pattern_key": k, "count": n, "example_title": group_titles[k]}
                            for k, n in groups.most_common() if n > 1][:50],
                    can_decide_any=principal.has_on_project(P.REVIEW_RESOLVE, t, p.id))


# ------------------------------------------------------------------ evidence panel (E16.F1.S2, E21.F1.S1)

class AssistantRun(BaseModel):
    run_id: uuid.UUID
    question: str
    by: str
    at: str
    status: str | None
    status_detail: str | None


class WorkbenchOut(BaseModel):
    item: ReviewOut
    why: list[str]
    samples: dict[str, Any] | None
    precedents: dict[str, Any]
    assistant: dict[str, Any]
    assistant_runs: list[AssistantRun]
    reviewers: list[dict[str, Any]]


def _assistant_state(s: Session, principal: Principal, t: Tenant, r: ReviewItem) -> dict[str, Any]:
    pin = s.get(ProjectAgentPin, (r.project_id, reviews.ASSISTANT))
    can_ask = (principal.has_on_project(P.REVIEW_RESOLVE, t, r.project_id)
               or principal.has_on_project(P.AGENT_RUN, t, r.project_id))
    return {"agent": reviews.ASSISTANT, "pinned_version": pin.version if pin else None, "can_ask": can_ask,
            "unavailable_reason": None if pin else "The Review Assistant is not pinned on this project. An agent "
            "manager pins a released version; until then the explanation above comes from the recorded evidence."}


def _reviewers(s: Session, t: Tenant, r: ReviewItem) -> list[dict[str, Any]]:
    out = []
    for uid in reviews.holders(s, t, r.project_id, r.owner_role):
        u = s.get(User, uid)
        if u is None or u.kind != "person" or not u.is_active or str(r.requested_by.get("id")) == str(uid):
            continue
        out.append({"id": str(u.id), "name": u.display_name})
    return sorted(out, key=lambda x: x["name"].lower())


@router.get("/review-items/{item_id}/workbench", response_model=WorkbenchOut)
def workbench(item_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> WorkbenchOut:
    t, r = _item(s, principal, item_id)
    runs = []
    for x in (r.context or {}).get("assistant_runs") or []:
        run = s.get(AgentRun, uuid.UUID(x["run_id"]))
        runs.append(AssistantRun(run_id=x["run_id"], question=x["question"], by=x["by"], at=x["at"],
                                 status=run.status if run else None, status_detail=run.status_detail if run else None))
    return WorkbenchOut(item=_review_out(s, principal, t, r, with_text=True), why=reviews.why(s, r),
                        samples=review_evidence.samples(t, r), precedents=reviews.precedents(s, r),
                        assistant=_assistant_state(s, principal, t, r), assistant_runs=runs,
                        reviewers=_reviewers(s, t, r))


# ------------------------------------------------------------------ decisions (E16.F1.S3)

class DecideIn(BaseModel):
    action: Literal["approve", "reject", "change", "dismiss"]
    option: str | None = Field(default=None, description="One of the item's options (approve)")
    note: str = Field(default="", max_length=4000, description="Required for reject, change and dismiss")
    changed_value: str | None = Field(default=None, max_length=4000,
                                      description="The changed answer (change); required when no agent raised it")


class DecideOut(BaseModel):
    recorded: str
    follow_up_error: str | None
    item: ReviewOut


@router.post("/review-items/{item_id}/decide", response_model=DecideOut)
def decide(item_id: uuid.UUID, body: DecideIn, principal: CurrentPrincipal, s: DB) -> DecideOut:
    t, r = _item(s, principal, item_id, lock=True)
    try:
        res = reviews.decide(s, principal, t, r, body.action, body.option, body.note, body.changed_value)
    except reviews.ReviewError as e:
        raise review_problem(e) from e
    return DecideOut(recorded=res.recorded, follow_up_error=res.follow_up_error, item=_review_out(s, principal, t, r))


# ------------------------------------------------------------------ bulk approval (E16.F1.S5)

class BulkExcluded(BaseModel):
    item: ReviewOut
    reason: str


class BulkPreviewOut(BaseModel):
    pattern_key: str
    eligible: list[ReviewOut]
    excluded: list[BulkExcluded]
    options: list[str] = Field(description="Options every eligible item has")
    first_approver_options: dict[str, str] = Field(
        description="Item id -> the option its first approver chose (two-person items): approve that option")
    can_bulk: bool
    reason: str | None
    max_items: int


@router.get("/projects/{project_id}/review-bulk", response_model=BulkPreviewOut)
def bulk_preview(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
                 pattern_key: Annotated[str, Query(min_length=3, max_length=200)]) -> BulkPreviewOut:
    """What a bulk approval of one evidence pattern would cover for the caller, and what it leaves out and why.
    Compliance-critical items are never included."""
    t, p = project_for(s, principal, project_id, None)
    c = reviews.bulk_candidates(s, principal, t, p.id, pattern_key)
    return BulkPreviewOut(pattern_key=pattern_key, eligible=[_review_out(s, principal, t, r) for r in c["eligible"]],
                          excluded=[BulkExcluded(item=_review_out(s, principal, t, r), reason=why)
                                    for r, why in c["excluded"]],
                          options=c["options"], first_approver_options=c["first_approver_options"],
                          can_bulk=c["can_bulk"], reason=c["reason"], max_items=reviews.BULK_MAX)


class BulkIn(BaseModel):
    pattern_key: str = Field(min_length=3, max_length=200)
    option: str = Field(min_length=1, max_length=4000)
    note: str = Field(min_length=10, max_length=4000, description="The reason, recorded on every item")
    item_ids: list[uuid.UUID] = Field(min_length=reviews.BULK_MIN, max_length=reviews.BULK_MAX,
                                      description="Exactly the items the reviewer saw in the preview")


class BulkOut(BaseModel):
    batch_id: uuid.UUID
    items: int
    approved: int
    approval_recorded: int = Field(description="Two-person items that now wait for a second approver")


@router.post("/projects/{project_id}/review-bulk", response_model=BulkOut)
def bulk_approve(project_id: uuid.UUID, body: BulkIn, principal: CurrentPrincipal, s: DB) -> BulkOut:
    t, p = project_for(s, principal, project_id, None)
    if not principal.has_on_project(P.REVIEW_RESOLVE, t, p.id):
        raise forbidden("You cannot decide review items on this project.")
    try:
        res = reviews.bulk_approve(s, principal, t, p.id, body.pattern_key, body.option, body.note, body.item_ids)
    except reviews.ReviewError as e:
        raise review_problem(e) from e
    return BulkOut(**res)


class ReviewerIn(BaseModel):
    user_id: uuid.UUID | None = Field(description="null removes the named reviewer")


@router.put("/review-items/{item_id}/reviewer", response_model=ReviewOut)
def assign_reviewer(item_id: uuid.UUID, body: ReviewerIn, principal: CurrentPrincipal, s: DB) -> ReviewOut:
    t, r = _item(s, principal, item_id, lock=True)
    if not principal.has_on_project(P.STAGE_MANAGE, t, r.project_id):
        raise forbidden("Only a migration lead names reviewers.")
    try:
        reviews.assign_reviewer(s, principal, t, r, body.user_id)
    except reviews.ReviewError as e:
        raise review_problem(e) from e
    s.flush()
    return _review_out(s, principal, t, r)


# ------------------------------------------------------------------ Review Assistant (E16.F1.S4)

class AskIn(BaseModel):
    question: str = Field(min_length=5, max_length=2000)


@router.post("/review-items/{item_id}/ask", response_model=AssistantRun, status_code=202)
def ask(item_id: uuid.UUID, body: AskIn, principal: CurrentPrincipal, s: DB) -> AssistantRun:
    """Start a Review Assistant run that explains the item. The answer is the run's output; the assistant has no
    tool that decides anything, and the database refuses decisions recorded by an agent."""
    t, r = _item(s, principal, item_id, lock=True)
    state = _assistant_state(s, principal, t, r)
    if not state["can_ask"]:
        raise forbidden("You cannot ask the Review Assistant on this project.")
    if state["unavailable_reason"]:
        raise Problem(409, "assistant-unavailable", "The Review Assistant is not available",
                      state["unavailable_reason"])
    proj = s.get(Project, r.project_id)
    assert proj is not None
    try:
        run = start_run(s, proj, reviews.ASSISTANT, reviews.assistant_objective(r, body.question), principal.actor)
    except agent_registry.AgentError as e:
        raise Problem(409, "assistant-unavailable", "The Review Assistant is not available", str(e)) from e
    reviews.record_assistant_run(r, run.id, body.question, principal.user.display_name)
    s.flush()
    x = r.context["assistant_runs"][-1]
    return AssistantRun(run_id=run.id, question=x["question"], by=x["by"], at=x["at"], status=run.status,
                        status_detail=None)


# ------------------------------------------------------------------ roles for filters

@router.get("/review-roles")
def review_roles(principal: CurrentPrincipal) -> list[dict[str, str]]:
    return [{"key": k, "label": v.label} for k, v in ROLES.items()]
