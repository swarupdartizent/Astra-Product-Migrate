"""Version delta as a background job: snapshot the source through its adapter, compare it with the project's
pinned target baseline (and, when given, the source product's standard baseline), store the differences in
the tenant database and give the planner's view on the blueprint's migration pattern (E09.F1, E09.F2)."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters import source
from astra_migrate.adapters.contract import SourceAdapterContent
from astra_migrate.adapters.engines import EngineError, EngineUnavailable, open_session
from astra_migrate.adapters.engines import Session as EngineSession
from astra_migrate.adapters.jobs import adapter_pack, content_of, params_for
from astra_migrate.connector_secrets import SecretError
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import (
    AdapterRun,
    BlueprintVersion,
    DeltaRun,
    Job,
    SourceConnection,
    TargetBaseline,
    Tenant,
)
from astra_migrate.delta.engine import (
    Obj,
    advise_pattern,
    base_type,
    body_hash,
    code_hash,
    compare,
    objects_from_baseline,
)
from astra_migrate.discovery.dictionary import harvest
from astra_migrate.jobs.runner import JobContext, JobFailed, actor_dict, handler, on_cancel
from astra_migrate.review import service as reviews
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

DEFAULT_SCHEMA = "dbo"


def snapshot(sess: EngineSession, content: SourceAdapterContent) -> tuple[list[Obj], list[str]]:
    """The source estate as delta objects: every inventoried object with its columns (from the data
    dictionary) or the hash of its code. Returns the objects and any problems reading them."""
    meta = source.read_metadata(sess, content)
    problems = [f"{c.label}: {c.error}" for c in meta.coverage if c.status == "failed"]
    d = harvest(sess, content)
    problems += d.problems
    cols: dict[str, list[tuple[str, str]]] = {}
    for c in d.columns:
        cols.setdefault(c.table.lower(), []).append((c.name.lower(), base_type(c.data_type)))
    types = {o.key: o for o in content.object_types}
    out = []
    for m in meta.objects:
        ot = types[m.type]
        schema = m.schema or DEFAULT_SCHEMA
        columns = tuple(sorted(cols.get(f"{schema}.{m.name}".lower(), [])))
        ch = code_hash(m.definition) if ot.code and m.definition else None
        bh = body_hash(m.definition, m.name) if ot.code and m.definition else None
        out.append(Obj(ot.compare_as or ot.key, schema, m.name, columns, ch, bh, ot.customization))
    return out, problems


def latest_pattern(s: Session, project_id: uuid.UUID) -> str | None:
    """The migration pattern of the project's newest approved blueprint, or of its newest draft."""
    rows = s.scalars(select(BlueprintVersion).where(BlueprintVersion.project_id == project_id)
                     .order_by(BlueprintVersion.number.desc())).all()
    for want in ("approved", "draft"):
        for v in rows:
            if v.status == want:
                pattern = (v.content or {}).get("pattern")
                return str(pattern) if pattern else None
    return None


@on_cancel("delta.run")
def _cancel(s: Session, job: Job) -> None:
    run = s.get(DeltaRun, uuid.UUID(job.payload["run_id"]))
    if run is not None and run.status == "queued":
        run.status, run.finished_at = "cancelled", datetime.now(UTC)


def _fail(run_id: uuid.UUID, status: str, detail: str) -> JobFailed:
    with session_scope() as s:
        r = s.get(DeltaRun, run_id)
        if r is not None:
            r.status, r.status_detail, r.finished_at = status, detail, datetime.now(UTC)
    return JobFailed(detail)


@handler("delta.run")
def run_delta(ctx: JobContext) -> dict[str, Any]:
    run_id = uuid.UUID(ctx.payload["run_id"])
    with session_scope() as s:
        run = s.get(DeltaRun, run_id)
        if run is None:
            raise JobFailed("The delta run no longer exists.")
        conn, t = s.get(SourceConnection, run.connection_id), s.get(Tenant, run.tenant_id)
        if conn is None or t is None or t.status != "active":
            raise _fail(run_id, "failed", "The connection or tenant is no longer available.")
        if s.scalar(select(AdapterRun.id).where(AdapterRun.connection_id == conn.id, AdapterRun.kind == "check",
                                                AdapterRun.status == "succeeded")) is None:
            raise _fail(run_id, "blocked", "The version delta needs a passing connection check first.")
        content = content_of(adapter_pack(s, conn.adapter))
        try:
            params = params_for(s, conn, t)
        except SecretError as e:
            raise _fail(run_id, "failed", f"The connection's password reference cannot be read: {e}") from e
        target = s.get(TargetBaseline, run.baseline_id)
        standard = s.get(TargetBaseline, run.standard_baseline_id) if run.standard_baseline_id else None
        assert target is not None
        target_objs = objects_from_baseline(target.content)
        standard_objs = objects_from_baseline(standard.content) if standard else None
        run.status = "running"
        engine, project_id, tenant_obj = conn.engine, run.project_id, t
        s.expunge(t)
    ctx.progress(10, "Reading the source estate through its adapter")
    try:
        sess = open_session(engine, params)
    except EngineUnavailable as e:
        raise _fail(run_id, "blocked", str(e)) from e
    except EngineError as e:
        raise _fail(run_id, "failed", str(e)) from e
    try:
        src, problems = snapshot(sess, content)
    except EngineError as e:
        raise _fail(run_id, "failed", str(e)) from e
    finally:
        sess.close()
    if not src:
        raise _fail(run_id, "failed", "The adapter returned no objects: " + "; ".join(problems or ["no detail"]))
    ctx.progress(60, f"Comparing {len(src)} source objects with {len(target_objs)} baseline objects")
    result = compare(src, target_objs, standard_objs)
    ctx.progress(85, "Saving the differences")
    with tenant_connection(tenant_obj, get_vault()) as tc:
        migrate_tenant_schema(tc)
        with tc.transaction(), tc.cursor() as cur:
            cur.executemany(
                "INSERT INTO estate.delta_differences(run_id, seq, grp, type, source, target, origin, details) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                [(run_id, i, d.group, d.type, d.source, d.target, d.origin, json.dumps(d.details))
                 for i, d in enumerate(result.differences)])
            cur.executemany("INSERT INTO estate.delta_lists(run_id, section, payload) VALUES (%s,%s,%s)",
                            [(run_id, "not_in_scope", json.dumps(result.not_in_scope)),
                             (run_id, "new_in_target", json.dumps(result.new_in_target)),
                             (run_id, "problems", json.dumps(problems))])
    with session_scope() as s:
        r = s.get(DeltaRun, run_id)
        assert r is not None
        pattern = latest_pattern(s, project_id)
        advice = advise_pattern(pattern, result)
        r.counts, r.origin_counts = result.counts, result.origin_counts
        r.not_in_scope, r.new_in_target = len(result.not_in_scope), len(result.new_in_target)
        r.input_digest, r.result_digest, r.advice = result.input_digest, result.result_digest, advice
        r.status, r.finished_at = "succeeded", datetime.now(UTC)
        r.status_detail = "; ".join(problems)[:2000] if problems else None
        if advice["agrees"] is False:
            reviews.new_item(
                s, tenant_id=r.tenant_id, project_id=project_id, kind="proposal",
                title=f"Migration pattern: the version delta suggests {advice['recommended']}",
                question=f"The blueprint says {pattern}. The version delta suggests {advice['recommended']}. "
                         "Keep the blueprint's pattern, or change the blueprint?",
                options=[f"Keep {pattern}", f"Change the blueprint to {advice['recommended']}"],
                owner_role="solution_architect",
                context={"delta_run_id": str(run_id), "advice": advice},
                requested_by=actor_dict(audit.Actor.system("delta")), subject_type="pattern", risk="high",
                pattern=f"delta:pattern:{pattern}->{advice['recommended']}",
                evidence=[{"label": "Version delta run", "kind": "delta_run", "ref": {"run_id": str(run_id)}}])
        audit.record(s, ctx.actor, "delta.run_finished", tenant_id=r.tenant_id, project_id=project_id,
                     target_type="delta_run", target_id=str(run_id),
                     details={"counts": result.counts, "origins": result.origin_counts,
                              "result_digest": result.result_digest, "advice": advice.get("recommended")})
    return {"counts": result.counts, "origins": result.origin_counts, "not_in_scope": len(result.not_in_scope),
            "new_in_target": len(result.new_in_target), "result_digest": result.result_digest}


def as_rows(rows: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
    keys = ("group", "type", "source", "target", "origin", "details")
    return [dict(zip(keys, r, strict=True)) for r in rows]

