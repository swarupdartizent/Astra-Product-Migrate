"""Agent registry (E02.F1.S1) and governance records (E02.F3.S1).

- Every agent has its own identity (a users row of kind 'agent').
- Versions are registered as drafts, tested by their own suite, and released only when the latest
  suite run against the exact manifest passed. Released versions never change.
- Projects are pinned to versions; runs use the pinned version only.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import resources
from typing import Any

import yaml
from packaging.version import Version
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.agents.manifest import AgentManifest, ModelCase, ScreeningCase, ToolPolicyCase
from astra_migrate.agents.tools import CATALOGUE, tool_issues
from astra_migrate.db.models import (
    Agent,
    AgentRun,
    AgentTestRun,
    AgentVersion,
    ModelAlias,
    ModelCall,
    Project,
    ProjectAgentPin,
    User,
)


class AgentError(ValueError):
    def __init__(self, message: str, issues: list[tuple[str, str]] | None = None) -> None:
        super().__init__(message)
        self.issues = issues or []


@dataclass(frozen=True)
class Issue:
    field: str
    message: str


def digest_of(manifest: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()


def parse(text: str) -> AgentManifest:
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise AgentError("The manifest is not valid YAML.", [("manifest", str(e)[:300])]) from e
    if not isinstance(raw, dict):
        raise AgentError("The manifest must be a YAML mapping.", [("manifest", "Expected key: value pairs")])
    try:
        m = AgentManifest.model_validate(raw)
    except ValidationError as e:
        raise AgentError("The manifest has problems.", [
            (".".join(str(x) for x in err["loc"]), err["msg"]) for err in e.errors()]) from e
    issues = semantic_issues(m)
    if issues:
        raise AgentError("The manifest has problems.", issues)
    return m


def semantic_issues(m: AgentManifest) -> list[tuple[str, str]]:
    issues = tool_issues(m.tools, m.data_access)
    for i, case in enumerate(m.tests):
        if isinstance(case, ModelCase):
            for key in ("must_call", "must_not_call"):
                for name in getattr(case.expect, key):
                    if key == "must_call" and name not in m.tools:
                        issues.append((f"tests.{i}.expect.{key}", f"'{name}' is not one of the agent's tools."))
            for name in case.tool_fixtures:
                if name not in m.tools:
                    issues.append((f"tests.{i}.tool_fixtures", f"'{name}' is not one of the agent's tools."))
    if not any(isinstance(c, ToolPolicyCase) and c.expect == "denied" for c in m.tests):
        issues.append(("tests", "The suite must include at least one tool_policy case that expects a denial."))
    return issues


# ------------------------------------------------------------------ identity and registration

def ensure_agent(session: Session, m: AgentManifest) -> Agent:
    a = session.get(Agent, m.name)
    if a is not None:
        a.title, a.team = m.title, m.team
        return a
    ident = User(kind="agent", email=f"{m.name}@agents.astra.invalid", display_name=f"{m.title} (agent)",
                 issuer=None, subject=None, is_active=True)
    session.add(ident)
    session.flush()
    a = Agent(name=m.name, title=m.title, team=m.team, identity_user_id=ident.id)
    session.add(a)
    session.flush()
    return a


def register(session: Session, text: str, user: User, actor: audit.Actor) -> AgentVersion:
    m = parse(text)
    manifest = m.model_dump(mode="json", by_alias=True)
    ensure_agent(session, m)
    existing = session.scalar(select(AgentVersion).where(AgentVersion.agent_name == m.name,
                                                         AgentVersion.version == m.version))
    d = digest_of(manifest)
    if existing is not None:
        if existing.status != "draft":
            raise AgentError(f"{m.name} {m.version} is {existing.status} and cannot change. "
                             "Register a new version.", [("version", "Increase the version number")])
        if existing.digest == d:
            return existing
        existing.manifest, existing.digest = manifest, d
        action = "agent.version_updated"
        v = existing
    else:
        v = AgentVersion(agent_name=m.name, version=m.version, version_sort=list(Version(m.version).release[:3]),
                         manifest=manifest, digest=d, status="draft", created_by=user.id)
        session.add(v)
        action = "agent.version_registered"
    session.flush()
    audit.record(session, actor, action, target_type="agent_version", target_id=str(v.id),
                 details={"agent": m.name, "version": m.version, "digest": d, "tools": m.tools,
                          "risk_rating": m.governance.risk_rating})
    return v


def manifest_of(v: AgentVersion) -> AgentManifest:
    return AgentManifest.model_validate(v.manifest)


def catalog_files() -> list[tuple[str, str]]:
    pkg = resources.files("astra_migrate.agents") / "catalog"
    return sorted((f.name, f.read_text(encoding="utf-8")) for f in pkg.iterdir() if f.name.endswith(".yaml"))


# ------------------------------------------------------------------ testing and release

def latest_test_run(session: Session, version_id: uuid.UUID) -> AgentTestRun | None:
    return session.scalars(select(AgentTestRun).where(AgentTestRun.agent_version_id == version_id)
                           .order_by(AgentTestRun.started_at.desc()).limit(1)).first()


def evaluate_case_static(m: AgentManifest, case: ToolPolicyCase | ScreeningCase) -> dict[str, Any]:
    from astra_migrate.agents.guardrails import screen
    from astra_migrate.agents.runtime import tool_allowed

    if isinstance(case, ToolPolicyCase):
        actual = "allowed" if tool_allowed(m, case.tool) else "denied"
        return {"name": case.name, "kind": case.kind, "status": "passed" if actual == case.expect else "failed",
                "detail": f"Expected {case.expect}; the runtime {actual} '{case.tool}'."}
    res = screen(case.text)
    ok = res.flagged == case.expect_flagged
    return {"name": case.name, "kind": case.kind, "status": "passed" if ok else "failed",
            "detail": f"Expected {'flagged' if case.expect_flagged else 'not flagged'}; got "
                      f"{'flagged' if res.flagged else 'not flagged'}"
                      + (f" ({', '.join(f.rule for f in res.findings)})" if res.findings else "") + "."}


def release(session: Session, v: AgentVersion, user: User, actor: audit.Actor, note: str) -> AgentVersion:
    if v.status != "draft":
        raise AgentError(f"Version {v.version} is {v.status}.")
    run = latest_test_run(session, v.id)
    if run is None:
        raise AgentError("The test suite has not been run for this version. Run it first.")
    if run.digest != v.digest:
        raise AgentError("The manifest changed after the last test run. Run the suite again.")
    if run.status != "passed":
        raise AgentError(f"The latest test run {run.status}. A version is released only when its suite passes.")
    if user.kind != "person":
        raise AgentError("Only people can release agents.")
    v.status, v.released_by, v.released_at = "released", user.id, datetime.now(UTC)
    v.released_test_run_id, v.release_note = run.id, note.strip()
    session.flush()
    audit.record(session, actor, "agent.version_released", target_type="agent_version", target_id=str(v.id),
                 details={"agent": v.agent_name, "version": v.version, "digest": v.digest,
                          "test_run": str(run.id), "note": note.strip()})
    return v


def deprecate(session: Session, v: AgentVersion, actor: audit.Actor, reason: str) -> AgentVersion:
    if v.status != "released":
        raise AgentError(f"Only released versions can be deprecated; this one is {v.status}.")
    v.status = "deprecated"
    audit.record(session, actor, "agent.version_deprecated", target_type="agent_version", target_id=str(v.id),
                 details={"agent": v.agent_name, "version": v.version, "reason": reason.strip()})
    return v


# ------------------------------------------------------------------ pins

def pin(session: Session, project: Project, agent_name: str, version: str, user: User, actor: audit.Actor,
        reason: str) -> ProjectAgentPin:
    v = session.scalar(select(AgentVersion).where(AgentVersion.agent_name == agent_name,
                                                  AgentVersion.version == version))
    if v is None:
        raise AgentError(f"{agent_name} {version} is not registered.", [("version", "Unknown version")])
    if v.status != "released":
        raise AgentError(f"{agent_name} {version} is {v.status}; projects can pin released versions only.",
                         [("version", "Choose a released version")])
    p = session.get(ProjectAgentPin, (project.id, agent_name))
    before = p.version if p else None
    if p is None:
        p = ProjectAgentPin(project_id=project.id, agent_name=agent_name, version=version, reason=reason.strip(),
                            pinned_by=user.id)
        session.add(p)
    else:
        p.version, p.reason, p.pinned_by, p.pinned_at = version, reason.strip(), user.id, datetime.now(UTC)
    session.flush()
    audit.record(session, actor, "agent.pinned", tenant_id=project.tenant_id, project_id=project.id,
                 target_type="project", target_id=str(project.id),
                 details={"agent": agent_name, "from": before, "to": version, "reason": reason.strip()})
    return p


# ------------------------------------------------------------------ governance record

def governance_record(session: Session, v: AgentVersion) -> dict[str, Any]:
    """Everything an auditor needs to explain how this agent version takes part in decisions."""
    m = manifest_of(v)
    runs = list(session.scalars(select(AgentTestRun).where(AgentTestRun.agent_version_id == v.id)
                                .order_by(AgentTestRun.started_at.desc()).limit(20)))
    latest = runs[0] if runs else None
    alias = session.get(ModelAlias, m.model.alias)
    usage = session.execute(select(func.count(), func.sum(ModelCall.cost_usd),
                                   func.array_agg(func.distinct(ModelCall.served_model)))
                            .where(ModelCall.agent_name == v.agent_name, ModelCall.agent_version == v.version)).one()
    projects = session.scalar(select(func.count()).select_from(ProjectAgentPin).where(
        ProjectAgentPin.agent_name == v.agent_name, ProjectAgentPin.version == v.version)) or 0
    run_count = session.scalar(select(func.count()).select_from(AgentRun).where(
        AgentRun.agent_name == v.agent_name, AgentRun.agent_version == v.version)) or 0
    released_by = session.get(User, v.released_by) if v.released_by else None
    return {
        "agent": v.agent_name, "version": v.version, "status": v.status, "digest": v.digest,
        "title": m.title, "team": m.team, "purpose": m.purpose,
        "risk_rating": m.governance.risk_rating, "risk_rationale": m.governance.risk_rationale,
        "intended_use": m.governance.intended_use, "out_of_scope": m.governance.out_of_scope,
        "regulatory_notes": m.governance.regulatory_notes,
        "oversight": m.oversight.model_dump(),
        "data_access": m.data_access,
        "tools": [{"name": n, "effect": CATALOGUE[n].effect.value, "description": CATALOGUE[n].description}
                  for n in m.tools if n in CATALOGUE],
        "guardrails": m.guardrails.model_dump(),
        "hard_rules": [
            "Agents cannot call tools outside their registered list; refused calls are audited.",
            "No platform tool writes to a target system, approves, publishes or releases anything.",
            "An agent identity can never be recorded as an approver or decider (enforced in the database).",
            "Stage gates are checked in deterministic code.",
            "Text from legacy data is passed only as labelled data and is screened for instructions.",
        ],
        "model": {"alias": m.model.alias, "effort": m.model.effort,
                  "currently_resolves_to": ({"provider_id": str(alias.provider_id), "model": alias.model}
                                            if alias else None),
                  "models_that_answered": sorted(x for x in (usage[2] or []) if x)},
        "usage": {"model_calls": usage[0] or 0, "cost_usd": float(usage[1] or 0), "agent_runs": run_count,
                  "projects_pinned": projects},
        "tests": {"cases": len(m.tests),
                  "by_kind": {k: sum(1 for c in m.tests if c.kind == k) for k in ("tool_policy", "screening", "model")},
                  "latest": _test_run_summary(latest, v.digest) if latest else None,
                  "history": [_test_run_summary(r, v.digest) for r in runs]},
        "release": {"released_at": v.released_at, "released_by": released_by.display_name if released_by else None,
                    "test_run_id": str(v.released_test_run_id) if v.released_test_run_id else None,
                    "note": v.release_note},
        "registered_at": v.created_at,
    }


def _test_run_summary(r: AgentTestRun, digest: str) -> dict[str, Any]:
    return {"id": str(r.id), "status": r.status, "started_at": r.started_at, "finished_at": r.finished_at,
            "summary": r.summary, "cost_usd": r.cost_usd, "digest_matches": r.digest == digest}
