"""Agent runs and agent test suites, executed on the durable job runner."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from opentelemetry import trace
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.agents import registry
from astra_migrate.agents.guardrails import ScreeningResult
from astra_migrate.agents.manifest import AgentManifest, ModelCase, ScreeningCase, ToolPolicyCase
from astra_migrate.agents.runtime import RunOutcome, Untrusted, run_loop
from astra_migrate.agents.tools import ToolEnv
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import (
    Agent,
    AgentRun,
    AgentTestRun,
    AgentVersion,
    Job,
    Project,
    ProjectAgentPin,
    ReviewItem,
    Tenant,
)
from astra_migrate.gateway.service import CallContext
from astra_migrate.jobs.runner import JobContext, JobFailed, actor_dict, enqueue, handler, on_cancel
from astra_migrate.observability import tracer
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

log = logging.getLogger(__name__)


def agent_actor(session: Session, agent_name: str, version: str) -> audit.Actor:
    a = session.get(Agent, agent_name)
    if a is None:
        raise registry.AgentError(f"Agent {agent_name} is not registered.")
    return audit.Actor("agent", str(a.identity_user_id), f"{a.title} {version}")


# ------------------------------------------------------------------ tenant-side content

def write_content(t: Tenant, run_id: uuid.UUID, objective: str | None = None, output: str | None = None) -> None:
    with tenant_connection(t, get_vault()) as conn:
        migrate_tenant_schema(conn)
        with conn.transaction():
            if objective is not None:
                conn.execute("INSERT INTO estate.agent_run_content(run_id, objective) VALUES (%s, %s) "
                             "ON CONFLICT (run_id) DO NOTHING", (run_id, objective))
            if output is not None:
                conn.execute("UPDATE estate.agent_run_content SET output = %s, updated_at = now() WHERE run_id = %s",
                             (output, run_id))


class TranscriptWriter:
    def __init__(self, t: Tenant, run_id: uuid.UUID) -> None:
        self.t, self.run_id, self.seq = t, run_id, 0

    def __call__(self, kind: str, payload: dict[str, Any]) -> None:
        self.seq += 1
        try:
            with tenant_connection(self.t, get_vault()) as conn, conn.transaction():
                conn.execute("INSERT INTO estate.agent_run_events(run_id, seq, kind, payload) VALUES (%s, %s, %s, %s)",
                             (self.run_id, self.seq, kind, json.dumps(payload, default=str)))
        except Exception:
            log.exception("could not write transcript event for run %s", self.run_id)


def read_content(t: Tenant, run_id: uuid.UUID) -> dict[str, Any]:
    with tenant_connection(t, get_vault()) as conn:
        migrate_tenant_schema(conn)
        row = conn.execute("SELECT objective, output FROM estate.agent_run_content WHERE run_id = %s",
                           (run_id,)).fetchone()
        events = conn.execute("SELECT seq, kind, payload, created_at FROM estate.agent_run_events WHERE run_id = %s "
                              "ORDER BY seq", (run_id,)).fetchall()
    return {"objective": row[0] if row else None, "output": row[1] if row else None,
            "events": [{"seq": e[0], "kind": e[1], "payload": e[2], "created_at": e[3]} for e in events]}


def record_flag(t: Tenant, project_id: uuid.UUID, run_id: uuid.UUID | None, actor: audit.Actor, u: Untrusted,
                res: ScreeningResult) -> uuid.UUID:
    """Keep the flagged text in the tenant database and put a review item (without the text) in the queue."""
    flag_id = uuid.uuid4()
    findings = [{"rule": f.rule, "label": f.label, "severity": f.severity, "encoded": f.encoded} for f in res.findings]
    with tenant_connection(t, get_vault()) as conn:
        migrate_tenant_schema(conn)
        with conn.transaction():
            conn.execute("INSERT INTO estate.screening_flags(id, source, excerpt, sha256, findings) "
                         "VALUES (%s, %s, %s, %s, %s)",
                         (flag_id, u.source, u.text[:4000], hashlib.sha256(u.text.encode()).hexdigest(),
                          json.dumps(findings)))
    with session_scope() as s:
        item = ReviewItem(tenant_id=t.id, project_id=project_id, kind="screening_flag",
                          title=f"Instruction-like text in {u.source}"[:300],
                          question="Legacy text was flagged as possibly trying to instruct an agent. Confirm whether "
                                   "it is ordinary business text or a manipulation attempt.",
                          options=["Ordinary business text", "Manipulation attempt"], owner_role="data_sme",
                          context={"flag_id": str(flag_id), "source": u.source, "severity": res.severity,
                                   "rules": [f["rule"] for f in findings]},
                          requested_by=actor_dict(actor), agent_run_id=run_id)
        s.add(item)
        s.flush()
        audit.record(s, actor, "guardrail.screening_flagged", tenant_id=t.id, project_id=project_id,
                     target_type="review_item", target_id=str(item.id),
                     details={"source": u.source, "rules": [f["rule"] for f in findings]})
    return flag_id


# ------------------------------------------------------------------ starting runs

def start_run(session: Session, project: Project, agent_name: str, objective: str, requested_by: audit.Actor,
              parent_run_id: uuid.UUID | None = None) -> AgentRun:
    pin = session.get(ProjectAgentPin, (project.id, agent_name))
    if pin is None:
        raise registry.AgentError(f"The agent '{agent_name}' is not pinned on this project. Pin a released "
                                  "version first.", [("agent", "Not pinned on this project")])
    v = session.scalar(select(AgentVersion).where(AgentVersion.agent_name == agent_name,
                                                  AgentVersion.version == pin.version))
    if v is None or v.status != "released":
        raise registry.AgentError(f"The pinned version {pin.version} of '{agent_name}' is not released.")
    t = session.get(Tenant, project.tenant_id)
    if t is None or t.status != "active":
        raise registry.AgentError("The tenant is not active.")
    span_ctx = trace.get_current_span().get_span_context()
    run = AgentRun(tenant_id=t.id, project_id=project.id, agent_name=agent_name, agent_version=pin.version,
                   parent_run_id=parent_run_id, status="queued", requested_by=actor_dict(requested_by),
                   trace_id=format(span_ctx.trace_id, "032x") if span_ctx.is_valid else None)
    session.add(run)
    session.flush()
    write_content(t, run.id, objective=objective)
    job = enqueue(session, "agent.run", f"{agent_name} {pin.version} on {project.name}", requested_by,
                  {"run_id": str(run.id)}, tenant_id=t.id, project_id=project.id)
    run.job_id = job.id
    audit.record(session, requested_by, "agent.run_requested", tenant_id=t.id, project_id=project.id,
                 target_type="agent_run", target_id=str(run.id),
                 details={"agent": agent_name, "version": pin.version,
                          "parent_run": str(parent_run_id) if parent_run_id else None})
    return run


@on_cancel("agent.run")
def _cancel_run(s: Session, job: Job) -> None:
    run = s.get(AgentRun, uuid.UUID(job.payload["run_id"]))
    if run is not None and run.status == "queued":
        run.status, run.finished_at, run.status_detail = "cancelled", datetime.now(UTC), "Cancelled before it started."


def _depth(s: Session, run: AgentRun) -> int:
    d, parent = 0, run.parent_run_id
    while parent is not None and d < 10:
        p = s.get(AgentRun, parent)
        parent = p.parent_run_id if p else None
        d += 1
    return d


@handler("agent.run")
def run_agent(ctx: JobContext) -> dict[str, Any]:
    run_id = uuid.UUID(ctx.payload["run_id"])
    with session_scope() as s:
        run = s.get(AgentRun, run_id)
        if run is None:
            raise JobFailed("The agent run no longer exists.")
        if run.status != "queued":
            raise JobFailed(f"The agent run is {run.status}.")
        v = s.scalar(select(AgentVersion).where(AgentVersion.agent_name == run.agent_name,
                                                AgentVersion.version == run.agent_version))
        t, p = s.get(Tenant, run.tenant_id), s.get(Project, run.project_id)
        if v is None or t is None or p is None:
            raise JobFailed("The agent version, tenant or project no longer exists.")
        blocked = f"Version {v.version} is {v.status}." if v.status != "released" else None
        if t.status != "active":
            blocked = f"The tenant is {t.status}."
        if blocked:
            run.status, run.status_detail, run.finished_at = "blocked", blocked, datetime.now(UTC)
    if blocked:
        raise JobFailed(blocked)
    with session_scope() as s:
        found = s.get(AgentRun, run_id)
        assert found is not None
        run = found
        v = s.scalar(select(AgentVersion).where(AgentVersion.agent_name == run.agent_name,
                                                AgentVersion.version == run.agent_version))
        t, p = s.get(Tenant, run.tenant_id), s.get(Project, run.project_id)
        assert v is not None and t is not None and p is not None
        manifest = registry.manifest_of(v)
        actor = agent_actor(s, run.agent_name, run.agent_version)
        depth = _depth(s, run)
        run.status, run.started_at = "running", datetime.now(UTC)
        tenant, project = t, p
    content = read_content(tenant, run_id)
    sink = TranscriptWriter(tenant, run_id)
    sink.seq = len(content["events"])

    def start_child(s: Session, agent: str, objective: str) -> uuid.UUID:
        proj = s.get(Project, project.id)
        assert proj is not None
        return start_run(s, proj, agent, objective, actor, parent_run_id=run_id).id

    env = ToolEnv(tenant_id=tenant.id, project_id=project.id, run_id=run_id, agent_name=manifest.name,
                  agent_version=manifest.version, actor=actor, delegation_depth=depth,
                  max_delegation_depth=manifest.guardrails.max_delegation_depth, start_child=start_child)
    call_ctx = CallContext(agent_name=manifest.name, agent_version=manifest.version, agent_run_id=run_id,
                           tenant_id=tenant.id, project_id=project.id, region_code=tenant.region_code)
    with tracer().start_as_current_span(f"agent {manifest.name}", attributes={
            "astra.category": "agent", "astra.agent": manifest.name, "astra.agent_version": manifest.version,
            "astra.tenant_id": str(tenant.id), "astra.project_id": str(project.id), "astra.run_id": str(run_id)}):
        ctx.progress(10, f"{manifest.title} is working")
        def on_flag(u: Untrusted, r: ScreeningResult) -> None:
            record_flag(tenant, project.id, run_id, actor, u, r)

        outcome = run_loop(manifest, env, content["objective"] or "", [], call_ctx, sink, on_flag=on_flag)
    write_content(tenant, run_id, output=outcome.final_text)
    with session_scope() as s:
        r = s.get(AgentRun, run_id)
        assert r is not None
        r.status, r.status_detail, r.finished_at = outcome.status, outcome.detail, datetime.now(UTC)
        r.model_calls, r.tool_calls, r.denied_tool_calls = outcome.model_calls, len(outcome.tool_calls), outcome.denied
        r.input_tokens, r.output_tokens, r.cost_usd = outcome.input_tokens, outcome.output_tokens, outcome.cost_usd
        audit.record(s, actor, "agent.run_finished", outcome="success" if outcome.status == "succeeded" else "failure",
                     tenant_id=tenant.id, project_id=project.id, target_type="agent_run", target_id=str(run_id),
                     details={"status": outcome.status, "detail": outcome.detail, "tools": outcome.attempted,
                              "denied": outcome.denied, "models": outcome.served_models,
                              "cost_usd": round(outcome.cost_usd, 6)})
    if outcome.status != "succeeded":
        raise JobFailed(outcome.detail or f"The run {outcome.status}.")
    return {"run_id": str(run_id), "status": outcome.status, "model_calls": outcome.model_calls,
            "cost_usd": outcome.cost_usd}


# ------------------------------------------------------------------ test suites

def start_tests(session: Session, v: AgentVersion, user_id: uuid.UUID, actor: audit.Actor) -> AgentTestRun:
    running = session.scalar(select(func.count()).select_from(AgentTestRun).where(
        AgentTestRun.agent_version_id == v.id, AgentTestRun.status.in_(("queued", "running"))))
    if running:
        raise registry.AgentError("A test run for this version is already queued or running.")
    tr = AgentTestRun(agent_version_id=v.id, digest=v.digest, status="queued", started_by=user_id)
    session.add(tr)
    session.flush()
    job = enqueue(session, "agent.test", f"Test suite for {v.agent_name} {v.version}", actor,
                  {"test_run_id": str(tr.id)})
    tr.job_id = job.id
    audit.record(session, actor, "agent.tests_started", target_type="agent_version", target_id=str(v.id),
                 details={"agent": v.agent_name, "version": v.version, "test_run": str(tr.id)})
    return tr


def evaluate_model_case(m: AgentManifest, case: ModelCase, outcome: RunOutcome) -> tuple[str, list[str]]:
    problems: list[str] = []
    if outcome.status == "blocked":
        return "blocked", [outcome.detail or "Blocked."]
    if outcome.status != "succeeded":
        problems.append(f"The run {outcome.status}: {outcome.detail}")
    for name in case.expect.must_call:
        if name not in outcome.called:
            problems.append(f"Expected a call to '{name}'.")
    for name in case.expect.must_not_call:
        if name in outcome.attempted:
            problems.append(f"Called '{name}', which this case forbids.")
    if outcome.denied:
        problems.append(f"Attempted {outcome.denied} tool call(s) outside its registered list.")
    text = outcome.final_text.lower()
    for phrase in case.expect.must_mention:
        if phrase.lower() not in text:
            problems.append(f"The answer does not mention '{phrase}'.")
    for phrase in case.expect.must_not_mention:
        if phrase.lower() in text:
            problems.append(f"The answer mentions '{phrase}', which this case forbids.")
    return ("failed" if problems else "passed"), problems


@handler("agent.test")
def run_tests(ctx: JobContext) -> dict[str, Any]:
    tr_id = uuid.UUID(ctx.payload["test_run_id"])
    with session_scope() as s:
        tr = s.get(AgentTestRun, tr_id)
        if tr is None:
            raise JobFailed("The test run no longer exists.")
        v = s.get(AgentVersion, tr.agent_version_id)
        assert v is not None
        changed = v.digest != tr.digest
        if changed:
            tr.status, tr.finished_at = "error", datetime.now(UTC)
            tr.summary = {"note": "The manifest changed before the suite ran."}
    if changed:
        raise JobFailed("The manifest changed before the suite ran. Run the suite again.")
    with session_scope() as s:
        tr = s.get(AgentTestRun, tr_id)
        v = s.get(AgentVersion, tr.agent_version_id)  # type: ignore[union-attr]
        assert tr is not None and v is not None
        manifest = registry.manifest_of(v)
        tr.status = "running"
        agent_name, version = v.agent_name, v.version
        actor = agent_actor(s, agent_name, version)
    results: list[dict[str, Any]] = []
    cost = 0.0
    total = len(manifest.tests)
    for i, case in enumerate(manifest.tests):
        ctx.progress(int(100 * i / max(1, total)), f"Case {i + 1} of {total}: {case.name}")
        if isinstance(case, ToolPolicyCase | ScreeningCase):
            results.append(registry.evaluate_case_static(manifest, case))
            continue
        env = ToolEnv(tenant_id=uuid.UUID(int=0), project_id=uuid.UUID(int=0), run_id=tr_id, agent_name=agent_name,
                      agent_version=version, actor=actor, delegation_depth=0,
                      max_delegation_depth=manifest.guardrails.max_delegation_depth, dry_run=True,
                      fixtures=case.tool_fixtures)
        with tracer().start_as_current_span(f"agent-test {agent_name}", attributes={
                "astra.category": "agent", "astra.agent": agent_name, "astra.agent_version": version,
                "astra.test_run_id": str(tr_id)}):
            try:
                outcome = run_loop(manifest, env, case.objective,
                                   [Untrusted(u.source, u.text) for u in case.untrusted_inputs],
                                   CallContext(agent_name=agent_name, agent_version=version, test_run_id=tr_id),
                                   lambda _k, _p: None)
            except Exception as e:
                log.exception("test case %s crashed", case.name)
                results.append({"name": case.name, "kind": case.kind, "status": "failed",
                                "detail": f"The case crashed: {type(e).__name__}"})
                continue
        cost += outcome.cost_usd
        status, problems = evaluate_model_case(manifest, case, outcome)
        results.append({"name": case.name, "kind": case.kind, "status": status,
                        "detail": "; ".join(problems) if problems else "All expectations met.",
                        "tools_called": outcome.attempted, "models": outcome.served_models,
                        "screening": [{"source": u.source, "flagged": r.flagged,
                                       "rules": [f.rule for f in r.findings]} for u, r in outcome.screening],
                        "answer": outcome.final_text[:2000], "cost_usd": round(outcome.cost_usd, 6)})
    counts = {k: sum(1 for r in results if r["status"] == k) for k in ("passed", "failed", "blocked")}
    final = "failed" if counts["failed"] else ("blocked" if counts["blocked"] else "passed")
    with session_scope() as s:
        tr2 = s.get(AgentTestRun, tr_id)
        assert tr2 is not None
        tr2.results, tr2.cost_usd = {"cases": results}, round(cost, 6)
        tr2.summary = {"total": total, **counts}
        tr2.status, tr2.finished_at = final, datetime.now(UTC)
        audit.record(s, ctx.actor, "agent.tests_finished", outcome="success" if final == "passed" else "failure",
                     target_type="agent_test_run", target_id=str(tr_id),
                     details={"agent": agent_name, "version": version, "status": final, **counts})
    return {"status": final, **counts, "cost_usd": cost}
