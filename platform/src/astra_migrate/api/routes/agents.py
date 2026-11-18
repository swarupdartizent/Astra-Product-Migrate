"""Agent registry, test suites, release and governance records (E02.F1.S1, E02.F3.S1); guardrail lab."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

import yaml
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate.agents import registry
from astra_migrate.agents.guardrails import reveal_hidden, screen, wrap_untrusted
from astra_migrate.agents.jobs import start_tests
from astra_migrate.agents.manifest import manifest_json_schema
from astra_migrate.agents.tools import CATALOGUE, FORBIDDEN_EFFECTS
from astra_migrate.api.errors import Problem, conflict, forbidden, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import Agent, AgentTestRun, AgentVersion, ModelAlias, User
from astra_migrate.gateway import service as gateway
from astra_migrate.security.principal import CurrentPrincipal, Principal
from astra_migrate.security.rbac import P

router = APIRouter(tags=["agents"])
DB = Annotated[Session, Depends(get_session)]


def _require_any_role(principal: Principal) -> None:
    if not principal.grants:
        raise forbidden("You need a role on the platform to see the agent registry.")


def _require_manage(principal: Principal) -> None:
    if not principal.has_platform(P.AGENT_MANAGE):
        raise forbidden()


def _agent_problem(e: registry.AgentError) -> Problem:
    if e.issues:
        return Problem(422, "validation", "Some fields need attention", str(e),
                       errors=[{"field": f, "message": m} for f, m in e.issues])
    return conflict(str(e))


# ------------------------------------------------------------------ catalogue of tools and schema

class ToolOut(BaseModel):
    name: str
    description: str
    effect: str
    input_schema: dict[str, Any]


class ToolCatalogueOut(BaseModel):
    tools: list[ToolOut]
    forbidden_effects: list[str]


@router.get("/agents/tools", response_model=ToolCatalogueOut)
def tools(principal: CurrentPrincipal) -> ToolCatalogueOut:
    _require_any_role(principal)
    return ToolCatalogueOut(tools=[ToolOut(name=t.name, description=t.description, effect=t.effect.value,
                                           input_schema=t.input_schema()) for t in CATALOGUE.values()],
                            forbidden_effects=sorted(FORBIDDEN_EFFECTS))


@router.get("/agents/schema")
def schema(principal: CurrentPrincipal) -> dict[str, Any]:
    _require_any_role(principal)
    return manifest_json_schema()


# ------------------------------------------------------------------ registry

class VersionSummary(BaseModel):
    id: uuid.UUID
    version: str
    status: str
    risk_rating: str
    created_at: datetime
    released_at: datetime | None
    latest_test_status: str | None


class AgentOut(BaseModel):
    name: str
    title: str
    team: str
    purpose: str
    identity_user_id: uuid.UUID
    versions: list[VersionSummary]
    latest_released: str | None


def _versions(s: Session, name: str) -> list[AgentVersion]:
    return list(s.scalars(select(AgentVersion).where(AgentVersion.agent_name == name)
                          .order_by(AgentVersion.version_sort.desc())))


def _summary(s: Session, v: AgentVersion) -> VersionSummary:
    tr = registry.latest_test_run(s, v.id)
    return VersionSummary(id=v.id, version=v.version, status=v.status,
                          risk_rating=v.manifest.get("governance", {}).get("risk_rating", ""), created_at=v.created_at,
                          released_at=v.released_at, latest_test_status=tr.status if tr else None)


def _agent_out(s: Session, a: Agent) -> AgentOut:
    vs = _versions(s, a.name)
    released = [v.version for v in vs if v.status == "released"]
    return AgentOut(name=a.name, title=a.title, team=a.team, purpose=vs[0].manifest.get("purpose", "") if vs else "",
                    identity_user_id=a.identity_user_id, versions=[_summary(s, v) for v in vs],
                    latest_released=released[0] if released else None)


@router.get("/agents", response_model=list[AgentOut])
def list_agents(principal: CurrentPrincipal, s: DB) -> list[AgentOut]:
    _require_any_role(principal)
    return [_agent_out(s, a) for a in s.scalars(select(Agent).order_by(Agent.team, Agent.name))]


class CatalogItem(BaseModel):
    file: str
    name: str
    version: str
    title: str
    registered_status: str | None


@router.get("/agents/catalog", response_model=list[CatalogItem])
def catalog(principal: CurrentPrincipal, s: DB) -> list[CatalogItem]:
    """Agents shipped with the platform, and whether each is registered."""
    _require_any_role(principal)
    out: list[CatalogItem] = []
    for fname, text in registry.catalog_files():
        raw = yaml.safe_load(text)
        v = s.scalar(select(AgentVersion).where(AgentVersion.agent_name == raw["name"],
                                                AgentVersion.version == str(raw["version"])))
        out.append(CatalogItem(file=fname, name=raw["name"], version=str(raw["version"]), title=raw["title"],
                               registered_status=v.status if v else None))
    return out


@router.post("/agents/catalog/import", response_model=list[AgentOut])
def import_catalog(principal: CurrentPrincipal, s: DB) -> list[AgentOut]:
    """Register the platform's built-in agents as drafts. Each still needs its suite to pass before release."""
    _require_manage(principal)
    names = []
    for _fname, text in registry.catalog_files():
        try:
            v = registry.register(s, text, principal.user, principal.actor)
        except registry.AgentError as e:
            raise _agent_problem(e) from e
        names.append(v.agent_name)
    return [_agent_out(s, a) for a in s.scalars(select(Agent).where(Agent.name.in_(names)))]


class ManifestIn(BaseModel):
    manifest_yaml: str = Field(min_length=10, max_length=200_000)


class ValidateOut(BaseModel):
    valid: bool
    errors: list[dict[str, str]]


@router.post("/agents/validate", response_model=ValidateOut)
def validate(body: ManifestIn, principal: CurrentPrincipal) -> ValidateOut:
    _require_any_role(principal)
    try:
        registry.parse(body.manifest_yaml)
    except registry.AgentError as e:
        return ValidateOut(valid=False, errors=[{"field": f, "message": m} for f, m in e.issues]
                           or [{"field": "manifest", "message": str(e)}])
    return ValidateOut(valid=True, errors=[])


class TestRunOut(BaseModel):
    id: uuid.UUID
    agent: str
    version: str
    status: str
    digest_matches: bool
    job_id: uuid.UUID | None
    started_by: str | None
    started_at: datetime
    finished_at: datetime | None
    summary: dict[str, Any]
    results: list[dict[str, Any]]
    cost_usd: float


def _test_run_out(s: Session, tr: AgentTestRun) -> TestRunOut:
    v = s.get(AgentVersion, tr.agent_version_id)
    assert v is not None
    u = s.get(User, tr.started_by)
    return TestRunOut(id=tr.id, agent=v.agent_name, version=v.version, status=tr.status,
                      digest_matches=tr.digest == v.digest, job_id=tr.job_id,
                      started_by=u.display_name if u else None, started_at=tr.started_at, finished_at=tr.finished_at,
                      summary=tr.summary, results=list(tr.results.get("cases", [])), cost_usd=tr.cost_usd)


class VersionDetail(BaseModel):
    id: uuid.UUID
    agent: str
    version: str
    status: str
    digest: str
    manifest: dict[str, Any]
    manifest_yaml: str
    created_by: str | None
    created_at: datetime
    released_by: str | None
    released_at: datetime | None
    release_note: str | None
    latest_test_run: TestRunOut | None
    release_blockers: list[str]
    model_ready: bool
    model_status: str
    permissions: list[str]


def _blockers(s: Session, v: AgentVersion) -> list[str]:
    if v.status != "draft":
        return [f"This version is {v.status}."]
    tr = registry.latest_test_run(s, v.id)
    if tr is None:
        return ["The test suite has not been run."]
    if tr.digest != v.digest:
        return ["The manifest changed after the last test run."]
    if tr.status != "passed":
        return [f"The latest test run {tr.status}."]
    return []


def _model_status(s: Session, alias_name: str) -> tuple[bool, str]:
    try:
        r = gateway.resolve(s, alias_name)
    except gateway.GatewayError as e:
        return False, e.message
    return True, f"'{alias_name}' resolves to {r.model} on {r.provider_name}."


def _version_detail(s: Session, principal: Principal, v: AgentVersion) -> VersionDetail:
    tr = registry.latest_test_run(s, v.id)
    cu, ru = s.get(User, v.created_by), s.get(User, v.released_by) if v.released_by else None
    ready, status = _model_status(s, v.manifest["model"]["alias"])
    perms = [P.AGENT_MANAGE.value] if principal.has_platform(P.AGENT_MANAGE) else []
    return VersionDetail(id=v.id, agent=v.agent_name, version=v.version, status=v.status, digest=v.digest,
                         manifest=v.manifest, manifest_yaml=yaml.safe_dump(v.manifest, sort_keys=False,
                                                                           allow_unicode=True),
                         created_by=cu.display_name if cu else None, created_at=v.created_at,
                         released_by=ru.display_name if ru else None, released_at=v.released_at,
                         release_note=v.release_note, latest_test_run=_test_run_out(s, tr) if tr else None,
                         release_blockers=_blockers(s, v), model_ready=ready, model_status=status, permissions=perms)


def _version(s: Session, name: str, version: str) -> AgentVersion:
    v = s.scalar(select(AgentVersion).where(AgentVersion.agent_name == name, AgentVersion.version == version))
    if v is None:
        raise not_found("Agent version")
    return v


@router.post("/agents/versions", response_model=VersionDetail, status_code=201)
def register_version(body: ManifestIn, principal: CurrentPrincipal, s: DB) -> VersionDetail:
    _require_manage(principal)
    try:
        v = registry.register(s, body.manifest_yaml, principal.user, principal.actor)
    except registry.AgentError as e:
        raise _agent_problem(e) from e
    return _version_detail(s, principal, v)


@router.get("/agents/{name}/versions/{version}", response_model=VersionDetail)
def get_version(name: str, version: str, principal: CurrentPrincipal, s: DB) -> VersionDetail:
    _require_any_role(principal)
    return _version_detail(s, principal, _version(s, name, version))


@router.post("/agents/{name}/versions/{version}/tests", response_model=TestRunOut, status_code=202)
def run_suite(name: str, version: str, principal: CurrentPrincipal, s: DB) -> TestRunOut:
    _require_manage(principal)
    v = _version(s, name, version)
    try:
        tr = start_tests(s, v, principal.user.id, principal.actor)
    except registry.AgentError as e:
        raise _agent_problem(e) from e
    return _test_run_out(s, tr)


@router.get("/agents/{name}/versions/{version}/tests", response_model=list[TestRunOut])
def list_suite_runs(name: str, version: str, principal: CurrentPrincipal, s: DB) -> list[TestRunOut]:
    _require_any_role(principal)
    v = _version(s, name, version)
    return [_test_run_out(s, tr) for tr in s.scalars(select(AgentTestRun).where(
        AgentTestRun.agent_version_id == v.id).order_by(AgentTestRun.started_at.desc()).limit(50))]


@router.get("/agent-test-runs/{test_run_id}", response_model=TestRunOut)
def get_suite_run(test_run_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> TestRunOut:
    _require_any_role(principal)
    tr = s.get(AgentTestRun, test_run_id)
    if tr is None:
        raise not_found("Test run")
    return _test_run_out(s, tr)


class ReleaseIn(BaseModel):
    note: str = Field(min_length=10, max_length=2000)


@router.post("/agents/{name}/versions/{version}/release", response_model=VersionDetail)
def release(name: str, version: str, body: ReleaseIn, principal: CurrentPrincipal, s: DB) -> VersionDetail:
    _require_manage(principal)
    v = _version(s, name, version)
    try:
        registry.release(s, v, principal.user, principal.actor, body.note)
    except registry.AgentError as e:
        raise _agent_problem(e) from e
    return _version_detail(s, principal, v)


class DeprecateIn(BaseModel):
    reason: str = Field(min_length=10, max_length=2000)


@router.post("/agents/{name}/versions/{version}/deprecate", response_model=VersionDetail)
def deprecate(name: str, version: str, body: DeprecateIn, principal: CurrentPrincipal, s: DB) -> VersionDetail:
    _require_manage(principal)
    v = _version(s, name, version)
    try:
        registry.deprecate(s, v, principal.actor, body.reason)
    except registry.AgentError as e:
        raise _agent_problem(e) from e
    return _version_detail(s, principal, v)


@router.get("/agents/{name}/versions/{version}/governance")
def governance(name: str, version: str, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    _require_any_role(principal)
    return registry.governance_record(s, _version(s, name, version))


@router.get("/agents/governance")
def governance_all(principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    """One governance record for every registered agent version (for auditors and the proof pack)."""
    _require_any_role(principal)
    return [registry.governance_record(s, v) for v in s.scalars(
        select(AgentVersion).order_by(AgentVersion.agent_name, AgentVersion.version_sort.desc()))]


# ------------------------------------------------------------------ guardrail lab

class ScreenIn(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    source: str = Field(default="lab", max_length=200)


class ScreenOut(BaseModel):
    flagged: bool
    severity: str | None
    hidden_characters: int
    findings: list[dict[str, Any]]
    wrapped: str
    visible_text: str


@router.post("/guardrails/screen", response_model=ScreenOut)
def screen_text(body: ScreenIn, principal: CurrentPrincipal) -> ScreenOut:
    """Show how a piece of legacy text would be screened and wrapped before it reaches an agent.
    Nothing is stored."""
    if not (principal.has_platform(P.AGENT_MANAGE) or principal.has_platform(P.AUDIT_READ)):
        raise forbidden()
    r = screen(body.text)
    return ScreenOut(flagged=r.flagged, severity=r.severity, hidden_characters=r.hidden_characters,
                     findings=[{"rule": f.rule, "label": f.label, "severity": f.severity, "excerpt": f.excerpt,
                                "encoded": f.encoded} for f in r.findings],
                     wrapped=wrap_untrusted(body.text, body.source), visible_text=reveal_hidden(body.text))


class ModelReadiness(BaseModel):
    alias: str
    ready: bool
    detail: str
    agents: list[str]


@router.get("/agents/model-readiness", response_model=list[ModelReadiness])
def model_readiness(principal: CurrentPrincipal, s: DB) -> list[ModelReadiness]:
    """For each alias agents use: can calls be made right now, and if not, why."""
    _require_any_role(principal)
    by_alias: dict[str, list[str]] = {}
    for v in s.scalars(select(AgentVersion).where(AgentVersion.status != "deprecated")):
        by_alias.setdefault(v.manifest["model"]["alias"], []).append(f"{v.agent_name} {v.version}")
    for a in s.scalars(select(ModelAlias)):
        by_alias.setdefault(a.alias, [])
    out = []
    for alias, agents in sorted(by_alias.items()):
        ready, detail = _model_status(s, alias)
        out.append(ModelReadiness(alias=alias, ready=ready, detail=detail, agents=sorted(agents)))
    return out
