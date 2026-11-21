"""The tool catalogue: every action an agent can take, and what kind of action it is.

Hard rules (E02.F2.S2), enforced here and in the registry, not in prompts:
- No tool writes to a target system, approves, publishes or releases anything. Those effects do not
  exist in `Effect`, and `FORBIDDEN_EFFECTS` documents them; the registry refuses any manifest that
  names a tool outside this catalogue.
- A tool that reads business data values has effect READ_BUSINESS_DATA. An agent whose manifest says
  `data_access: metadata_only` (the Orchestrator) cannot be given such a tool.
- Tools that change state (request a decision, move a stage, assign a task) go through the same
  deterministic checks people go through (stage gates, review queue ownership).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from astra_migrate import audit, stages
from astra_migrate.blueprints import service as blueprints
from astra_migrate.db.models import (
    Agent,
    AgentRun,
    AgentVersion,
    Project,
    ProjectAgentPin,
    ReviewItem,
    RoleAssignment,
    Tenant,
)
from astra_migrate.planning.estimation import STREAMS
from astra_migrate.review import service as reviews
from astra_migrate.security.rbac import ROLES


class Effect(StrEnum):
    READ_METADATA = "read_metadata"
    READ_BUSINESS_DATA = "read_business_data"
    REQUEST_DECISION = "request_decision"
    UPDATE_STAGE = "update_stage"
    ASSIGN_TASK = "assign_task"


# Effects no tool may ever have. Listed so reviewers can see the rule; nothing implements them.
FORBIDDEN_EFFECTS = frozenset({"write_target", "approve", "publish", "release", "grant_access", "skip_gate"})
MUTATING = frozenset({Effect.REQUEST_DECISION, Effect.UPDATE_STAGE, Effect.ASSIGN_TASK})
DECISION_OWNER_ROLES = ("migration_lead", "customer_data_owner", "data_sme", "solution_architect",
                        "compliance_curator", "customer_it_security_lead", "reviewer", "test_engineer")


class ToolError(Exception):
    """A tool refused or failed; the message goes back to the model as an error result."""


@dataclass
class ToolEnv:
    tenant_id: uuid.UUID
    project_id: uuid.UUID
    run_id: uuid.UUID
    agent_name: str
    agent_version: str
    actor: audit.Actor
    delegation_depth: int
    max_delegation_depth: int
    dry_run: bool = False
    fixtures: dict[str, Any] | None = None
    # Set by the runtime: enqueue a child run (kept out of this module to avoid an import cycle).
    start_child: Callable[[Session, str, str], uuid.UUID] | None = None


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    effect: Effect
    input_model: type[_In]
    handler: Callable[[Session, ToolEnv, Any], dict[str, Any]]

    def input_schema(self) -> dict[str, Any]:
        return clean_schema(self.input_model.model_json_schema())


_KEEP = {"type", "properties", "required", "additionalProperties", "items", "enum", "description", "anyOf"}


def clean_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Inline $refs and keep only keywords every provider's strict tool mode accepts. Length and range
    limits are still enforced: the runtime validates every input with the pydantic model."""
    defs = schema.get("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].split("/")[-1]])
            out = {k: walk(v) for k, v in node.items() if k in _KEEP}
            if out.get("type") == "object":
                out.setdefault("additionalProperties", False)
                out["required"] = sorted(out.get("properties", {}).keys())
            return out
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node

    result: dict[str, Any] = walk(schema)
    return result


# ====================================================================== handlers

def _load(s: Session, env: ToolEnv) -> tuple[Tenant, Project]:
    t, p = s.get(Tenant, env.tenant_id), s.get(Project, env.project_id)
    if t is None or p is None or t.status == "deleted":
        raise ToolError("The project no longer exists.")
    return t, p


class NoInput(_In):
    pass


def get_project_status(s: Session, env: ToolEnv, _: NoInput) -> dict[str, Any]:
    t, p = _load(s, env)
    latest = blueprints.latest(s, p.id)
    gate = blueprints.planning_gate(s, t, p)
    open_reviews = s.execute(select(ReviewItem.kind, func.count()).where(
        ReviewItem.project_id == p.id, ReviewItem.status == "open").group_by(ReviewItem.kind)).all()
    runs = s.scalars(select(AgentRun).where(AgentRun.project_id == p.id)
                     .order_by(AgentRun.created_at.desc()).limit(10))
    return {
        "project": {"name": p.name, "status": p.status, "tenant": t.name, "region": t.region_code},
        "blueprint": {
            "latest_version": latest.number if latest else None,
            "latest_status": latest.status if latest else None,
            "approved_version": gate.get("version") if gate["ready"] else None,
            "planning_gate": {"ready": gate["ready"], "reason": gate["reason"]},
        },
        "stages": [{"stage": x["stage"], "title": x["title"], "status": x["status"], "note": x["note"]}
                   for x in stages.overview(s, p.id)],
        "open_reviews": {k: n for k, n in open_reviews},
        "recent_agent_runs": [{"agent": r.agent_name, "version": r.agent_version, "status": r.status,
                               "created_at": r.created_at.isoformat()} for r in runs],
    }


def list_open_reviews(s: Session, env: ToolEnv, _: NoInput) -> dict[str, Any]:
    _load(s, env)
    rows = s.scalars(select(ReviewItem).where(ReviewItem.project_id == env.project_id, ReviewItem.status == "open")
                     .order_by(ReviewItem.created_at).limit(100))
    now = datetime.now(UTC)
    return {"items": [{"id": str(r.id), "kind": r.kind, "title": r.title, "owner_role": r.owner_role,
                       "age_hours": round((now - r.created_at).total_seconds() / 3600, 1)} for r in rows]}


def list_project_agents(s: Session, env: ToolEnv, _: NoInput) -> dict[str, Any]:
    _load(s, env)
    rows = s.execute(select(ProjectAgentPin, Agent).join(Agent, Agent.name == ProjectAgentPin.agent_name)
                     .where(ProjectAgentPin.project_id == env.project_id).order_by(Agent.name)).all()
    out = []
    for pin, a in rows:
        v = s.scalar(select(AgentVersion).where(AgentVersion.agent_name == a.name,
                                                AgentVersion.version == pin.version))
        out.append({"agent": a.name, "title": a.title, "team": a.team, "version": pin.version,
                    "status": v.status if v else "missing",
                    "purpose": (v.manifest.get("purpose") if v else "") or ""})
    return {"agents": out}


class RequestDecisionIn(_In):
    title: str = Field(min_length=5, max_length=200, description="Short title for the review queue")
    question: str = Field(min_length=10, max_length=2000, description="The question the person must answer")
    options: list[str] = Field(min_length=2, max_length=6, description="The answers the person can choose from")
    owner_role: Literal[DECISION_OWNER_ROLES] = Field(  # type: ignore[valid-type]
        description="The role that owns this decision")
    why_needed: str = Field(min_length=10, max_length=1000, description="Why the decision is needed now")
    risk: Literal["low", "medium", "high", "critical"] = Field(
        default="medium", description="How much harm a wrong answer would do")
    suggested_option: str | None = Field(default=None, max_length=500,
                                         description="The option you would suggest; one of `options`")
    confidence: float | None = Field(default=None, ge=0, le=1,
                                     description="How sure you are of the option you would suggest (0 to 1); give "
                                                 "it with `suggested_option`")
    stream: Literal[STREAMS] | None = Field(  # type: ignore[valid-type]
        default=None, description="The migration stream the decision belongs to")


def _single_holder(s: Session, t: Tenant, project_id: uuid.UUID, role: str) -> uuid.UUID | None:
    ids = set(s.scalars(select(RoleAssignment.user_id).where(
        RoleAssignment.role == role,
        ((RoleAssignment.scope_type == "project") & (RoleAssignment.scope_id == project_id))
        | ((RoleAssignment.scope_type == "tenant") & (RoleAssignment.scope_id == t.id)))))
    return next(iter(ids)) if len(ids) == 1 else None


def request_decision(s: Session, env: ToolEnv, inp: RequestDecisionIn) -> dict[str, Any]:
    t, p = _load(s, env)
    opts = [o.strip() for o in inp.options if o.strip()]
    if len(set(opts)) != len(opts) or len(opts) < 2:
        raise ToolError("Give at least two distinct options.")
    suggested = inp.suggested_option.strip() if inp.suggested_option else None
    if suggested is not None and suggested not in opts:
        raise ToolError("`suggested_option` must be one of `options`.")
    if inp.confidence is not None and suggested is None:
        raise ToolError("A confidence is about the option you suggest: give `suggested_option` too.")
    dup = s.scalar(select(ReviewItem).where(ReviewItem.project_id == p.id, ReviewItem.status == "open",
                                            ReviewItem.kind == "decision", ReviewItem.title == inp.title.strip()))
    if dup is not None:
        return {"review_item_id": str(dup.id), "status": "already_open",
                "note": "An open decision with this title already exists; it was not duplicated."}
    owner = _single_holder(s, t, p.id, inp.owner_role)
    item = reviews.new_item(
        s, tenant_id=t.id, project_id=p.id, kind="decision", title=inp.title.strip(),
        question=inp.question.strip(), options=opts, owner_role=inp.owner_role, owner_user_id=owner,
        context={"why_needed": inp.why_needed.strip(), "agent": env.agent_name, "agent_version": env.agent_version,
                 **({"suggested": suggested} if suggested else {})},
        requested_by={"type": env.actor.type, "id": env.actor.id, "name": env.actor.name},
        agent_run_id=env.run_id, subject_type="decision", stream=inp.stream, risk=inp.risk,
        confidence=inp.confidence,
        pattern=reviews.pattern_key(f"decision:{env.agent_name}:{inp.owner_role}", inp.title),
        evidence=[{"label": "Agent run transcript", "kind": "agent_run", "ref": {"run_id": str(env.run_id)}}])
    s.flush()
    audit.record(s, env.actor, "review.decision_requested", tenant_id=t.id, project_id=p.id,
                 target_type="review_item", target_id=str(item.id),
                 details={"title": item.title, "owner_role": item.owner_role, "run_id": str(env.run_id)})
    return {"review_item_id": str(item.id), "status": "open", "owner_role": item.owner_role,
            "owner_assigned": owner is not None,
            "note": "The decision is in the review queue. A person will answer it; you cannot."}


class UpdateStageIn(_In):
    stage: Literal[tuple(stages.STAGE_KEYS)] = Field(description="The stage to change")  # type: ignore[valid-type]
    status: Literal["not_started", "blocked", "in_progress", "done"]
    note: str = Field(min_length=10, max_length=1000, description="Why the stage is changing")


def update_stage(s: Session, env: ToolEnv, inp: UpdateStageIn) -> dict[str, Any]:
    t, p = _load(s, env)
    res = stages.move(s, t, p, inp.stage, inp.status, inp.note, env.actor)
    if not res.allowed:
        return {"applied": False, "reasons": res.reasons,
                "note": "The stage gate refused this change. Gates are checked in code and cannot be skipped."}
    return {"applied": True, "stage": inp.stage, "status": inp.status}


class AssignTaskIn(_In):
    agent: str = Field(min_length=3, max_length=64, description="Name of a pinned agent on this project")
    objective: str = Field(min_length=20, max_length=4000, description="What the agent should do")


def assign_task(s: Session, env: ToolEnv, inp: AssignTaskIn) -> dict[str, Any]:
    _load(s, env)
    if inp.agent == env.agent_name:
        raise ToolError("An agent cannot assign a task to itself.")
    if env.delegation_depth >= env.max_delegation_depth:
        raise ToolError("Delegation depth limit reached; ask a person instead.")
    pin = s.get(ProjectAgentPin, (env.project_id, inp.agent))
    if pin is None:
        raise ToolError(f"The agent '{inp.agent}' is not pinned on this project.")
    v = s.scalar(select(AgentVersion).where(AgentVersion.agent_name == inp.agent, AgentVersion.version == pin.version))
    if v is None or v.status != "released":
        raise ToolError(f"The pinned version of '{inp.agent}' is not released.")
    children = s.scalar(select(func.count()).select_from(AgentRun).where(AgentRun.parent_run_id == env.run_id)) or 0
    if children >= 5:
        raise ToolError("This run has already assigned the maximum of 5 tasks.")
    if env.start_child is None:
        raise ToolError("Task assignment is not available in this context.")
    child = env.start_child(s, inp.agent, inp.objective)
    return {"run_id": str(child), "agent": inp.agent, "version": pin.version, "status": "queued"}


# ---------------------------------------------------------------------- ontology (E06.F1.S1)

class FindConceptIn(_In):
    phrase: str = Field(min_length=1, max_length=200, description="Word or phrase to look up")


class ConceptIn(_In):
    concept_id: str = Field(min_length=3, max_length=120, description="Concept id, like namespace.name")


def _onto(fn: Callable[..., dict[str, Any]], *args: Any) -> dict[str, Any]:
    from astra_migrate.ontology.service import OntologyError

    try:
        return fn(*args)
    except OntologyError as e:
        raise ToolError(str(e)) from e


def find_concept(s: Session, env: ToolEnv, inp: FindConceptIn) -> dict[str, Any]:
    from astra_migrate.ontology import service

    return _onto(service.find_concept, s, inp.phrase, None, 5)


def get_concept(s: Session, env: ToolEnv, inp: ConceptIn) -> dict[str, Any]:
    from astra_migrate.ontology import service

    return _onto(service.get_concept, s, inp.concept_id)


def get_constraints(s: Session, env: ToolEnv, inp: ConceptIn) -> dict[str, Any]:
    from astra_migrate.ontology import service

    return _onto(service.get_constraints, s, inp.concept_id)


def get_vendor_binding(s: Session, env: ToolEnv, inp: ConceptIn) -> dict[str, Any]:
    from astra_migrate.ontology import service

    return _onto(service.get_vendor_binding, s, inp.concept_id)


def get_precedents(s: Session, env: ToolEnv, inp: ConceptIn) -> dict[str, Any]:
    from astra_migrate.ontology import service

    return _onto(service.get_precedents, s, inp.concept_id)


class ReviewItemIn(_In):
    item_id: uuid.UUID = Field(description="The review item's id")


def _review_item(s: Session, env: ToolEnv, item_id: uuid.UUID) -> ReviewItem:
    _load(s, env)
    r = s.get(ReviewItem, item_id)
    if r is None or r.project_id != env.project_id:
        raise ToolError("No such review item on this project.")
    return r


def get_review_item(s: Session, env: ToolEnv, inp: ReviewItemIn) -> dict[str, Any]:
    return reviews.tool_view(s, _review_item(s, env, inp.item_id))


def get_review_precedents(s: Session, env: ToolEnv, inp: ReviewItemIn) -> dict[str, Any]:
    prec = reviews.precedents(s, _review_item(s, env, inp.item_id))
    # Reviewers' free-text notes are not passed to the model; outcomes and answers are.
    return {"pattern_key": prec["pattern_key"], "outcomes": prec["outcomes"],
            "items": [{k: v for k, v in x.items() if k != "note"} for x in prec["items"]]}


# ====================================================================== catalogue

CATALOGUE: dict[str, ToolSpec] = {t.name: t for t in [
    ToolSpec("get_project_status",
             "Read the project's status metadata: blueprint version and approval state, planning gate, stage "
             "statuses, open review counts and recent agent runs. Contains no business data values.",
             Effect.READ_METADATA, NoInput, get_project_status),
    ToolSpec("list_open_reviews",
             "List open items in the project's review queue (id, kind, title, owner role, age).",
             Effect.READ_METADATA, NoInput, list_open_reviews),
    ToolSpec("list_project_agents",
             "List the agents pinned on this project with their versions and purposes.",
             Effect.READ_METADATA, NoInput, list_project_agents),
    ToolSpec("request_decision",
             "Ask a person for a decision. Creates an item in the review queue owned by the given role. "
             "Use it whenever progress needs a human choice; you cannot make the choice yourself.",
             Effect.REQUEST_DECISION, RequestDecisionIn, request_decision),
    ToolSpec("update_stage",
             "Ask to change a project stage's status. The stage gate is checked in code; if it refuses, the "
             "reasons are returned and nothing changes.",
             Effect.UPDATE_STAGE, UpdateStageIn, update_stage),
    ToolSpec("assign_task",
             "Assign a task to another agent pinned on this project. The task runs as its own agent run.",
             Effect.ASSIGN_TASK, AssignTaskIn, assign_task),
    ToolSpec("find_concept",
             "Find ontology concepts matching a word or phrase. Returns concept ids, labels, definitions and the "
             "ontology version the answer came from.",
             Effect.READ_METADATA, FindConceptIn, find_concept),
    ToolSpec("get_concept",
             "Get one ontology concept with its parents, attributes, relations and code lists.",
             Effect.READ_METADATA, ConceptIn, get_concept),
    ToolSpec("get_constraints",
             "Get the rules that apply to a concept: domain rules and recorded target product constraints.",
             Effect.READ_METADATA, ConceptIn, get_constraints),
    ToolSpec("get_vendor_binding",
             "Get how source adapters bind a concept to product tables and columns.",
             Effect.READ_METADATA, ConceptIn, get_vendor_binding),
    ToolSpec("get_review_item",
             "Read one review item on this project: its question, options, risk, confidence, compliance controls, "
             "the evidence recorded with it and the platform's explanation of why it was raised. No sample values.",
             Effect.READ_METADATA, ReviewItemIn, get_review_item),
    ToolSpec("get_review_precedents",
             "Read earlier decisions in this tenant on items like this one (same pattern), with their source "
             "project and outcome.",
             Effect.READ_METADATA, ReviewItemIn, get_review_precedents),
    ToolSpec("get_precedents",
             "Get earlier mapping decisions people recorded for a concept.",
             Effect.READ_METADATA, ConceptIn, get_precedents),
]}


def check_catalogue() -> None:
    """Invariants checked at import and in tests."""
    for spec in CATALOGUE.values():
        if spec.effect.value in FORBIDDEN_EFFECTS:
            raise RuntimeError(f"tool {spec.name} has a forbidden effect")
    roles_ok = set(DECISION_OWNER_ROLES) <= set(ROLES)
    if not roles_ok:
        raise RuntimeError("decision owner roles must be platform roles")


check_catalogue()


def tool_issues(names: list[str], data_access: str) -> list[tuple[str, str]]:
    """Problems with an agent's tool list, as (field, message)."""
    issues: list[tuple[str, str]] = []
    for i, n in enumerate(names):
        spec = CATALOGUE.get(n)
        if spec is None:
            issues.append((f"tools.{i}", f"'{n}' is not a platform tool. Agents can use only catalogue tools; "
                           "there are no tools that write to a target system, approve or publish."))
            continue
        if data_access == "metadata_only" and spec.effect == Effect.READ_BUSINESS_DATA:
            issues.append((f"tools.{i}", f"'{n}' reads business data, but the agent is limited to metadata."))
    return issues
