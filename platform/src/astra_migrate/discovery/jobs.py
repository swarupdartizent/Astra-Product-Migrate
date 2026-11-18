"""Discovery as a background job, activity imports, and storage of results in the tenant database."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters.engines import EngineError, EngineUnavailable, open_session
from astra_migrate.adapters.jobs import adapter_pack, content_of, params_for
from astra_migrate.connector_secrets import SecretError
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import (
    ActivityImport,
    AdapterRun,
    CoverageReport,
    DiscoveryRun,
    Job,
    ProjectBaseline,
    ReviewItem,
    SourceConnection,
    TargetBaseline,
    Tenant,
    User,
)
from astra_migrate.discovery import activity, pipeline
from astra_migrate.discovery.profiler import WEIGHTS
from astra_migrate.jobs.runner import JobContext, JobFailed, actor_dict, handler, on_cancel
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault


def _json(obj: Any) -> str:
    def default(o: Any) -> Any:
        if dataclasses.is_dataclass(o) and not isinstance(o, type):
            return dataclasses.asdict(o)
        if isinstance(o, datetime):
            return o.isoformat()
        return str(o)
    return json.dumps(obj, default=default)


# ------------------------------------------------------------------ activity imports

def import_activity(session: Session, conn: SourceConnection, t: Tenant, user: User, actor: audit.Actor,
                    filename: str, data: bytes) -> ActivityImport:
    events = activity.parse_file(data, filename)
    if not events:
        raise activity.ActivityError("The file has no records.")
    imp = ActivityImport(tenant_id=t.id, connection_id=conn.id, filename=filename[:255],
                         sha256=hashlib.sha256(data).hexdigest(), records=len(events),
                         first_at=min(e.ts for e in events), last_at=max(e.ts for e in events), created_by=user.id)
    session.add(imp)
    session.flush()
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        with tc.transaction(), tc.cursor() as cur:
            cur.executemany(
                "INSERT INTO estate.activity_events(import_id, seq, occurred_at, login, host, program, statement, "
                "reads, writes, executes) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [(imp.id, i, e.ts, e.login, e.host, e.program, e.statement, json.dumps(e.reads), json.dumps(e.writes),
                  json.dumps(e.executes)) for i, e in enumerate(events)])
    audit.record(session, actor, "discovery.activity_imported", tenant_id=t.id, target_type="activity_import",
                 target_id=str(imp.id), details={"connection": conn.name, "records": len(events),
                                                 "sha256": imp.sha256, "from": imp.first_at.isoformat() if imp.first_at
                                                 else None, "to": imp.last_at.isoformat() if imp.last_at else None})
    return imp


def load_events(t: Tenant, import_ids: list[uuid.UUID]) -> list[activity.Event]:
    if not import_ids:
        return []
    out = []
    with tenant_connection(t, get_vault()) as tc:
        for row in tc.execute("SELECT occurred_at, login, host, program, statement, reads, writes, executes "
                              "FROM estate.activity_events WHERE import_id = ANY(%s) ORDER BY occurred_at",
                              (import_ids,)).fetchall():
            ts = row[0].astimezone(UTC).replace(tzinfo=None) if row[0].tzinfo else row[0]
            out.append(activity.Event(ts, row[1], row[2], row[3], row[4], list(row[5]), list(row[6]), list(row[7])))
    return out


# ------------------------------------------------------------------ the job

@on_cancel("discovery.run")
def _cancel(s: Session, job: Job) -> None:
    run = s.get(DiscoveryRun, uuid.UUID(job.payload["run_id"]))
    if run is not None and run.status == "queued":
        run.status, run.finished_at = "cancelled", datetime.now(UTC)


def _fail(run_id: uuid.UUID, status: str, detail: str) -> JobFailed:
    with session_scope() as s:
        r = s.get(DiscoveryRun, run_id)
        if r is not None:
            r.status, r.status_detail, r.finished_at = status, detail, datetime.now(UTC)
    return JobFailed(detail)


@handler("discovery.run")
def run_discovery(ctx: JobContext) -> dict[str, Any]:
    run_id = uuid.UUID(ctx.payload["run_id"])
    with session_scope() as s:
        run = s.get(DiscoveryRun, run_id)
        if run is None:
            raise JobFailed("The discovery run no longer exists.")
        conn, t = s.get(SourceConnection, run.connection_id), s.get(Tenant, run.tenant_id)
        if conn is None or t is None or t.status != "active":
            raise _fail(run_id, "failed", "The connection or tenant is no longer available.")
        check = s.scalars(select(AdapterRun).where(AdapterRun.connection_id == conn.id, AdapterRun.kind == "check",
                                                   AdapterRun.status == "succeeded")
                          .order_by(AdapterRun.created_at.desc())).first()
        if check is None:
            raise _fail(run_id, "blocked", "Discovery needs a passing connection check first.")
        p = adapter_pack(s, conn.adapter)
        content = content_of(p)
        try:
            params = params_for(s, conn, t)
        except SecretError as e:
            raise _fail(run_id, "failed", f"The connection's password reference cannot be read: {e}") from e
        imports = [i.id for i in s.scalars(select(ActivityImport).where(ActivityImport.connection_id == conn.id))]
        pin = s.get(ProjectBaseline, run.project_id)
        baseline = s.get(TargetBaseline, pin.baseline_id) if pin else None
        baseline_tables = {o["name"] for o in (baseline.content.get("objects", []) if baseline else [])
                           if o.get("type") == "table"}
        run.status = "running"
        check_summary, engine, as_of, window = dict(check.summary), conn.engine, run.as_of, run.window_days
        project_id, tenant_obj = run.project_id, t
        s.expunge(t)
    events = load_events(tenant_obj, imports)
    bindings = {e.table.lower(): e.concept for e in content.entities if e.concept}
    try:
        sess = open_session(engine, params)
    except EngineUnavailable as e:
        raise _fail(run_id, "blocked", str(e)) from e
    except EngineError as e:
        raise _fail(run_id, "failed", str(e)) from e
    try:
        d = pipeline.run(sess, content, check_summary, events, as_of.replace(tzinfo=None), window_days=window,
                         bindings=bindings, baseline_tables=baseline_tables, say=ctx.progress)
    except EngineError as e:
        raise _fail(run_id, "failed", str(e)) from e
    finally:
        sess.close()
    ctx.progress(97, "Saving the knowledge graph")
    _store(tenant_obj, run_id, d)
    summary = {"coverage_pct": d.coverage_pct, "nodes": len(d.graph.nodes), "edges": len(d.graph.edges),
               "by_stream": d.graph.by_stream(), "estate_score": d.profile.estate_score, "rules": len(d.rules),
               "interfaces": len(d.interfaces), "unused": len(d.usage.unused), "evidence_days": d.usage.evidence_days,
               "configuration_items": len(d.config.items),
               "documents": d.documents.total_count if d.documents else None,
               "document_bytes": d.documents.total_bytes if d.documents else None}
    with session_scope() as s:
        r = s.get(DiscoveryRun, run_id)
        assert r is not None
        r.phases = {k: dataclasses.asdict(v) for k, v in d.phases.items()}
        r.summary, r.status, r.finished_at = summary, "succeeded", datetime.now(UTC)
        for old in s.scalars(select(CoverageReport).where(CoverageReport.project_id == project_id,
                                                          CoverageReport.status == "draft")):
            old.status = "superseded"
        rep = CoverageReport(tenant_id=r.tenant_id, project_id=project_id, discovery_run_id=run_id,
                             coverage_pct=d.coverage_pct, streams=d.streams,
                             gaps=[dataclasses.asdict(g) for g in d.gaps], waivers=[], status="draft")
        s.add(rep)
        if d.usage.unused:
            s.add(ReviewItem(
                tenant_id=r.tenant_id, project_id=project_id, kind="proposal",
                title=f"Retirement review: {len(d.usage.unused)} element(s) with no use in {window} days",
                question="Discovery found legacy elements with no direct or indirect use in the activity window. "
                         "Decide whether they can be retired instead of migrated.",
                options=["Retire the unused elements", "Migrate them anyway", "Review element by element"],
                owner_role="solution_architect",
                context={"discovery_run_id": str(run_id), "unused": len(d.usage.unused),
                         "evidence_days": d.usage.evidence_days},
                requested_by=actor_dict(audit.Actor.system("discovery")), status="open"))
        s.flush()
        audit.record(s, ctx.actor, "discovery.run_finished", tenant_id=r.tenant_id, project_id=project_id,
                     target_type="discovery_run", target_id=str(run_id),
                     details={"coverage_pct": d.coverage_pct, "coverage_report": str(rep.id),
                              "phases": {k: v.status for k, v in d.phases.items()}})
    return summary


def _store(t: Tenant, run_id: uuid.UUID, d: pipeline.Discovery) -> None:
    sections = {
        "profile": {"estate_score": d.profile.estate_score, "weights": WEIGHTS, "tables": d.profile.tables},
        "usage": {"window_start": d.usage.window_start, "window_end": d.usage.window_end,
                  "evidence_days": d.usage.evidence_days, "note": d.usage.note, "unused": d.usage.unused,
                  "elements": list(d.usage.elements.values())},
        "rules": d.rules, "interfaces": d.interfaces,
        "configuration": {"items": d.config.items, "problems": d.config.problems, "diff": d.config_diff},
        "documents": dataclasses.asdict(d.documents) if d.documents else None,
        "dictionary": {"columns": len(d.dictionary.columns), "relations": d.dictionary.relations,
                       "code_lists": d.dictionary.code_lists, "problems": d.dictionary.problems},
        "gaps": d.gaps,
    }
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        with tc.transaction(), tc.cursor() as cur:
            cur.executemany(
                "INSERT INTO estate.kg_nodes(run_id, node_id, kind, stream, element, usage, concept, target, props) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [(run_id, n.id, n.kind, n.stream, n.element, _json(n.usage), n.concept, n.target, _json(n.props))
                 for n in d.graph.nodes.values()])
            cur.executemany("INSERT INTO estate.kg_edges(run_id, src, dst, kind, props) VALUES (%s,%s,%s,%s,%s)",
                            [(run_id, e.src, e.dst, e.kind, _json(e.props)) for e in d.graph.edges])
            cur.executemany("INSERT INTO estate.discovery_results(run_id, section, payload) VALUES (%s,%s,%s)",
                            [(run_id, k, _json(v)) for k, v in sections.items()])
