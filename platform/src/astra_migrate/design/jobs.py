"""The design run (E12) and the build run (E12.F2.S3, E12.F3.S3, E12.F4.S1) as background jobs.

A design run reads the source live through its adapter (metadata with details, the data dictionary and the
configuration), takes interfaces from the newest discovery, table matches from the newest version delta, the scope
register, the latest code conversion and the pinned target baseline with its adapter's design section, and proposes
every stream. Items that need a person go to the review queue.

A build run generates code from the register's current decisions, versions it by digest and tests it on the SQL
Server workbench.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any

import psycopg
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters import source
from astra_migrate.adapters.contract import SourceAdapterContent, TargetAdapterContent
from astra_migrate.adapters.engines import EngineError, EngineUnavailable, open_session
from astra_migrate.adapters.jobs import adapter_pack, content_of, params_for
from astra_migrate.checklist import target_content
from astra_migrate.connector_secrets import SecretError
from astra_migrate.conversion.workbench import Table, Workbench, WorkbenchBlocked, sqlserver_type
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import (
    BuildArtifact,
    ConversionRun,
    DeltaRun,
    DesignRun,
    DiscoveryRun,
    Job,
    Project,
    ProjectBaseline,
    SourceConnection,
    TargetBaseline,
    Tenant,
)
from astra_migrate.design import build, mapping, register, streams
from astra_migrate.design.register import Item
from astra_migrate.discovery.configuration import read_configuration
from astra_migrate.discovery.dictionary import harvest
from astra_migrate.jobs.runner import JobContext, JobFailed, actor_dict, enqueue, handler, on_cancel
from astra_migrate.planning import scope as plan_scope
from astra_migrate.review import service as reviews
from astra_migrate.tenancy.service import tenant_connection
from astra_migrate.vault import get_vault

ORDER = ("mapping", "configuration", "form", "code", "integration", "report", "page", "security")


@on_cancel("design.run")
def _cancel(s: Session, job: Job) -> None:
    run = s.get(DesignRun, uuid.UUID(job.payload["run_id"]))
    if run is not None and run.status == "queued":
        run.status, run.finished_at = "cancelled", datetime.now(UTC)


def _fail(run_id: uuid.UUID, status: str, detail: str) -> JobFailed:
    with session_scope() as s:
        r = s.get(DesignRun, run_id)
        if r is not None:
            r.status, r.status_detail, r.finished_at = status, detail, datetime.now(UTC)
    return JobFailed(detail)


def target_of(s: Session, project_id: uuid.UUID) -> tuple[TargetBaseline | None, TargetAdapterContent | None]:
    pin = s.get(ProjectBaseline, project_id)
    b = s.get(TargetBaseline, pin.baseline_id) if pin else None
    if b is None:
        return None, None
    _, content = target_content(s, b.adapter_name)
    return b, content


def target_tables(baseline: dict[str, Any]) -> list[mapping.TargetTable]:
    return [mapping.TargetTable(o.get("schema") or "dbo", o["name"], list(o.get("columns") or []),
                                (o.get("detail") or {}).get("concept"))
            for o in baseline.get("objects", []) if o.get("type") == "table"]


def _latest(s: Session, model: Any, project_id: uuid.UUID) -> Any:
    return s.scalars(select(model).where(model.project_id == project_id, model.status == "succeeded")
                     .order_by(model.created_at.desc())).first()


def _tenant_inputs(tc: psycopg.Connection[Any], project_id: uuid.UUID, disc: uuid.UUID | None,
                   delta: uuid.UUID | None, conv: uuid.UUID | None) -> dict[str, Any]:
    out: dict[str, Any] = {"interfaces": [], "delta_tables": {}, "in_scope": None, "precedents": {},
                           "converted": [], "samples": {}}
    if disc:
        row = tc.execute("SELECT payload FROM estate.discovery_results WHERE run_id = %s AND section = 'interfaces'",
                         (disc,)).fetchone()
        out["interfaces"] = list(row[0] or []) if row else []
    if delta:
        for src, tgt in tc.execute("SELECT source, target FROM estate.delta_differences WHERE run_id = %s AND "
                                   "type = 'table' AND target IS NOT NULL", (delta,)).fetchall():
            out["delta_tables"][str(src).lower()] = str(tgt).lower()
    sc = {k: b for k, b in tc.execute("SELECT key, body FROM estate.plan_items WHERE project_id = %s AND "
                                      "kind = 'scope'", (project_id,)).fetchall()}
    if sc:
        out["in_scope"] = {str(b["element"]).lower() for b in sc.values()
                           if b.get("kind") in ("table", "user_defined_table")
                           and plan_scope.effective(b) in ("migrate", "rebuild")}
    for pid, key, body in tc.execute("SELECT project_id, key, body FROM estate.design_items WHERE stream = 'mapping' "
                                     "AND status = 'approved' AND project_id <> %s", (project_id,)).fetchall():
        rec = {"project_id": str(pid), "target": body.get("target"),
               "decided_by": (body.get("decision") or {}).get("by"),
               "decided_at": (body.get("decision") or {}).get("at")}
        out["precedents"].setdefault(key, []).append(rec)
        out["precedents"].setdefault(f"*.{key.rsplit('.', 1)[-1]}", []).append(rec)
    if conv:
        out["converted"] = [{"object_type": t, "name": n, "status": st} for t, n, st in tc.execute(
            "SELECT object_type, name, status FROM estate.conversions WHERE run_id = %s", (conv,)).fetchall()]
    return out


@handler("design.run")
def run_design(ctx: JobContext) -> dict[str, Any]:
    run_id = uuid.UUID(ctx.payload["run_id"])
    with session_scope() as s:
        run = s.get(DesignRun, run_id)
        if run is None:
            raise JobFailed("The design run no longer exists.")
        conn, t, p = s.get(SourceConnection, run.connection_id), s.get(Tenant, run.tenant_id), s.get(Project,
                                                                                                    run.project_id)
        if conn is None or t is None or p is None or t.status != "active":
            raise _fail(run_id, "failed", "The connection, project or tenant is no longer available.")
        content = content_of(adapter_pack(s, conn.adapter))
        assert isinstance(content, SourceAdapterContent)
        try:
            params = params_for(s, conn, t)
        except SecretError as e:
            raise _fail(run_id, "failed", f"The connection's password reference cannot be read: {e}") from e
        b, tgt = target_of(s, p.id)
        if b is None:
            raise _fail(run_id, "blocked", "Pin a target baseline first: design proposes targets from it.")
        baseline = b.content
        disc, delta, conv = (_latest(s, DiscoveryRun, p.id), _latest(s, DeltaRun, p.id),
                             _latest(s, ConversionRun, p.id))
        ids = (disc.id if disc else None, delta.id if delta else None, conv.id if conv else None)
        run.status = "running"
        engine, project_id, tenant_obj, by = conn.engine, p.id, t, run.requested_by
        s.expunge(t)
    ctx.progress(5, "Reading the source through its adapter")
    try:
        sess = open_session(engine, params)
    except EngineUnavailable as e:
        raise _fail(run_id, "blocked", str(e)) from e
    except EngineError as e:
        raise _fail(run_id, "failed", str(e)) from e
    try:
        meta = source.read_metadata(sess, content)
        dictionary = harvest(sess, content)
        cfg = read_configuration(sess, content)
    finally:
        sess.close()
    ctx.progress(40, "Proposing the design")
    with tenant_connection(tenant_obj, get_vault()) as tc:
        ti = _tenant_inputs(tc, project_id, *ids)
        old_security = {i["key"]: i for i in register.items(tc, project_id, "security")}
    d = tgt.design if tgt else None
    entities: list[dict[str, Any]] = [{"name": e.name, "table": e.table, "key": e.key, "concept": e.concept,
                 "attributes": e.attributes, "relations": {k: v.model_dump() for k, v in e.relations.items()}}
                for e in content.entities]
    custom = {o.qualified.lower() for o in meta.objects if o.type == "user_defined_table"}
    columns = [mapping.SourceColumn(c.table, c.name, c.data_type, c.max_length, c.nullable, c.ordinal)
               for c in dictionary.columns]
    m_inp = mapping.Inputs(columns, target_tables(baseline), ti["delta_tables"],
                           {e["table"].lower(): e for e in entities}, ti["precedents"],
                           ({x for x in ti["in_scope"] if x not in custom} if ti["in_scope"] is not None else
                            {c.table.lower() for c in columns if c.table.lower() not in custom}))
    m_items, m_summary = mapping.propose(m_inp)
    mapped = [{"source": i.source, "target": i.target, "status": i.status} for i in m_items]
    objs = [streams.Obj(o.type, o.name, o.schema, o.detail, o.definition) for o in meta.objects]
    s_inp = streams.Inputs(d, objs, [streams.Config(c.kind, c.key, c.name, c.scope, c.definition,
                                                    list(c.depends_on)) for c in cfg.items],
                           ti["interfaces"], tgt.load.rate_limit.requests_per_minute if tgt else None, entities,
                           mapped, {o.key for o in content.object_types if o.code}, sorted(
                               o.qualified for o in meta.objects if o.type == "user_defined_table"), ti["converted"],
                           {t_.lower(): [{"name": c.name, "type": c.data_type, "max_length": c.max_length,
                                          "nullable": c.nullable, "ordinal": c.ordinal} for c in cols]
                            for t_, cols in dictionary.tables().items()})
    by_stream: dict[str, list[Item]] = {
        "mapping": m_items, "configuration": streams.configuration(s_inp), "form": streams.forms(s_inp),
        "code": streams.code(s_inp), "integration": streams.integrations(s_inp), "report": streams.reports(s_inp),
        "page": streams.pages(s_inp)}
    for it in by_stream["report"]:
        view = next((o for o in objs if o.type == "view" and o.qualified.lower() == it.source["name"].lower()), None)
        it.extra["definition"] = view.definition if view else None
    new_objects = sorted([f"page:{i.target['title']}" for i in by_stream["page"] if i.target]
                         + [f"report:{i.target['qualified']}" for i in by_stream["report"] if i.target])
    by_stream["security"] = streams.security(s_inp, new_objects, old_security)
    blocked_streams = {k: v[0].evidence[0] for k, v in by_stream.items() if v and all(i.status == "blocked" for i in v)}
    if d is None:
        blocked_streams["target"] = "The target adapter has no design section."
    ctx.progress(70, "Saving the register and asking for reviews")
    summary: dict[str, Any] = {"streams": {}, "mapping": m_summary, "blocked": blocked_streams,
                               "problems": dictionary.problems + cfg.problems
                               + [f"{c.label}: {c.error}" for c in meta.coverage if c.error]}
    review_count = 0
    with tenant_connection(tenant_obj, get_vault()) as tc, session_scope() as s:
        for stream in ORDER:
            need, kept = register.store(tc, project_id, run_id, stream, by_stream.get(stream, []),
                                        str(by.get("name", "design")))
            comp = reviews.compliance_for(s, project_id, "mapping" if stream == "mapping" else
                                          "configuration" if stream == "configuration" else
                                          "integration" if stream == "integration" else stream)
            for it in need:
                rv = it.review or {}
                ri = reviews.new_item(
                    s, tenant_id=tenant_obj.id, project_id=project_id, kind="proposal", title=rv["title"],
                    question=rv["question"], options=rv["options"], owner_role=rv["owner_role"],
                    requested_by=actor_dict(audit.Actor.system("design")),
                    context={"design": {"stream": stream, "key": it.key, "run_id": str(run_id)},
                             "proposed": it.target, "evidence": it.evidence[:10],
                             "suggested": rv["options"][0]},
                    subject_type="mapping" if stream == "mapping" else stream,
                    stream={"mapping": "data", "configuration": "configuration", "integration": "integrations"}
                    .get(stream, "data"), segment=rv.get("segment"), risk=rv.get("risk", "medium"),
                    confidence=rv.get("confidence"), pattern=reviews.pattern_key(f"design:{stream}",
                                                                                  *it.flags, str(rv.get("segment"))),
                    evidence=[{"label": "Design register item", "kind": "design_item",
                               "ref": {"stream": stream, "key": it.key}}], compliance=comp)
                s.flush()
                register.update(tc, project_id, stream, it.key, None, {"review_item_id": str(ri.id)},
                                "design")
                review_count += 1
            counts = {st: sum(1 for i in by_stream.get(stream, []) if i.status == st) for st in register.STATUSES}
            summary["streams"][stream] = {"items": len(by_stream.get(stream, [])), "kept_decisions": kept,
                                          **{k: v for k, v in counts.items() if v}}
        summary["review_items"] = review_count
        r = s.get(DesignRun, run_id)
        assert r is not None
        r.summary, r.status, r.finished_at = summary, "succeeded", datetime.now(UTC)
        audit.record(s, ctx.actor, "design.run_finished", tenant_id=tenant_obj.id, project_id=project_id,
                     target_type="design_run", target_id=str(run_id),
                     details={"streams": summary["streams"], "review_items": review_count,
                              "blocked": blocked_streams})
    return {"streams": summary["streams"], "review_items": review_count}


def start_design(s: Session, t: Tenant, p: Project, conn: SourceConnection, actor: audit.Actor) -> DesignRun:
    run = DesignRun(tenant_id=t.id, project_id=p.id, connection_id=conn.id, status="queued", summary={},
                    requested_by=actor_dict(actor))
    s.add(run)
    s.flush()
    job = enqueue(s, "design.run", f"Design proposals for {p.name}", actor, {"run_id": str(run.id)},
                  tenant_id=t.id, project_id=p.id)
    run.job_id = job.id
    audit.record(s, actor, "design.run_requested", tenant_id=t.id, project_id=p.id, target_type="design_run",
                 target_id=str(run.id), details={"connection": conn.name})
    return run


# ------------------------------------------------------------------ build


def _versions(s: Session, project_id: uuid.UUID, kind: str, name: str) -> list[BuildArtifact]:
    return list(s.scalars(select(BuildArtifact).where(BuildArtifact.project_id == project_id,
                                                      BuildArtifact.kind == kind, BuildArtifact.name == name)
                          .order_by(BuildArtifact.version.desc())))


def save(s: Session, tc: psycopg.Connection[Any], t: Tenant, project_id: uuid.UUID, g: build.Generated,
         actor: audit.Actor) -> tuple[BuildArtifact, bool]:
    """Store a generated artifact as a new version, or return the existing version with the same digest."""
    vs = _versions(s, project_id, g.kind, g.name)
    if vs and vs[0].digest == g.digest:
        return vs[0], False
    for old in vs:
        if old.status in ("generated", "tests_failed", "tests_passed"):
            old.status = "superseded"
    a = BuildArtifact(tenant_id=t.id, project_id=project_id, kind=g.kind, name=g.name,
                      version=(vs[0].version + 1) if vs else 1, digest=g.digest,
                      inputs_digest=register.digest(g.inputs), status="generated", test_summary={},
                      created_by=actor_dict(actor))
    s.add(a)
    s.flush()
    tc.execute("INSERT INTO estate.build_code(artifact_id, code, tests, inputs) VALUES (%s,%s,%s,%s)",
               (a.id, g.code, json.dumps(g.tests, default=str), json.dumps(g.inputs, default=str)))
    return a, True


def record_results(s: Session, tc: psycopg.Connection[Any], a: BuildArtifact, results: list[dict[str, Any]]) -> None:
    passed = bool(results) and all(r["passed"] for r in results)
    tc.execute("UPDATE estate.build_code SET results = %s WHERE artifact_id = %s", (json.dumps(results), a.id))
    if a.status in ("approved", "superseded"):
        return
    a.status = "tests_passed" if passed else "tests_failed"
    a.tests_digest = a.digest if passed else None
    a.test_summary = {"tests": len(results), "passed": sum(1 for r in results if r["passed"]),
                      "failed": [r["name"] for r in results if not r["passed"]][:20],
                      "at": datetime.now(UTC).isoformat()}


def _baseline_tables(baseline: dict[str, Any]) -> list[Table]:
    out = []
    for o in baseline.get("objects", []):
        if o.get("type") == "table" and o.get("columns"):
            out.append(Table(o.get("schema") or "dbo", o["name"],
                             [(str(c["name"]), sqlserver_type(str(c.get("type", "")))) for c in o["columns"]]))
    return out


@handler("design.build")
def run_build(ctx: JobContext) -> dict[str, Any]:
    project_id = uuid.UUID(ctx.payload["project_id"])
    actor = audit.Actor(**ctx.payload["actor"]) if ctx.payload.get("actor") else ctx.actor
    with session_scope() as s:
        p, t = s.get(Project, project_id), None
        if p is None:
            raise JobFailed("The project no longer exists.")
        t = s.get(Tenant, p.tenant_id)
        b, _ = target_of(s, project_id)
        if t is None or b is None:
            raise JobFailed("Pin a target baseline first.")
        baseline = b.content
        s.expunge(t)
    try:
        wb = Workbench()
    except WorkbenchBlocked as e:
        raise JobFailed(str(e)) from e
    made: dict[str, int] = {"transformation": 0, "code_object": 0}
    tested = passed = 0
    try:
        with tenant_connection(t, get_vault()) as tc:
            gens = _generate(tc, project_id, baseline)
            for i, g in enumerate(gens):
                ctx.progress(5 + int(90 * i / max(1, len(gens))), f"Testing {g.name}")
                with session_scope() as s:
                    a, new = save(s, tc, t, project_id, g, actor)
                    if new or a.status == "generated":
                        made[g.kind] += 1 if new else 0
                        res = (build.run_transformation(wb, g) if g.kind == "transformation" else
                               build.run_code(wb, g))
                        record_results(s, tc, a, res)
                        tested += 1
                        passed += 1 if a.status == "tests_passed" else 0
                    tc.commit()
    finally:
        wb.close()
    with session_scope() as s:
        audit.record(s, actor, "build.run_finished", tenant_id=t.id, project_id=project_id, target_type="project",
                     target_id=str(project_id), details={"generated": made, "tested": tested, "passed": passed,
                                                         "artifacts": len(gens)})
    return {"artifacts": len(gens), "new_versions": made, "tested": tested, "passed": passed}


def _generate(tc: psycopg.Connection[Any], project_id: uuid.UUID, baseline: dict[str, Any]) -> list[build.Generated]:
    gens: list[build.Generated] = []
    tgt_tables = {f"{o.get('schema') or 'dbo'}.{o['name']}".lower(): o for o in baseline.get("objects", [])
                  if o.get("type") == "table"}
    maps = [m for m in register.items(tc, project_id, "mapping", "approved") if m.get("target")]
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for m in maps:
        groups.setdefault((m["source"]["table"], m["target"]["table"]), []).append(m)
    all_cols: dict[str, list[dict[str, Any]]] = {}
    for m in register.items(tc, project_id, "mapping"):
        all_cols.setdefault(m["source"]["table"], []).append(
            {"name": m["source"]["column"], "type": m["source"]["type"], "max_length": m["source"].get("max_length"),
             "nullable": m["source"].get("nullable", True), "ordinal": m["source"].get("ordinal")})
    entity_runs = tc.execute("SELECT DISTINCT ON (entity) entity, run_id FROM estate.extract_counts "
                             "ORDER BY entity, run_id").fetchall()
    for (st, tt), ms in sorted(groups.items()):
        tobj = tgt_tables.get(tt.lower())
        if tobj is None:
            continue
        samples: list[dict[str, Any]] = []
        for ent, rid in entity_runs:
            rows = tc.execute("SELECT row_data FROM estate.extract_rows WHERE run_id = %s AND entity = %s LIMIT 50",
                              (rid, ent)).fetchall()
            cand = [r[0] for r in rows]
            wanted = {c["name"].lower() for c in all_cols.get(st, [])}
            if cand and wanted and len(wanted & {k.lower() for k in cand[0]}) >= max(1, len(wanted) // 2):
                samples = cand
                break
        src_cols = sorted(all_cols.get(st, []), key=lambda c: c.get("ordinal") or 0)
        gens.append(build.transformation(st, tt, ms, src_cols, list(tobj.get("columns") or []), samples))
    # customer code to the target's naming rules
    code_items = [c for c in register.items(tc, project_id, "code") if c.get("target") and c["status"] != "rejected"]
    renames = {c["source"]["name"]: c["target"]["qualified"] for c in code_items}
    base_tables = _baseline_tables(baseline)
    udt_tables: list[Table] = []
    for c in code_items:
        if c["source"]["type"] != "user_defined_table":
            continue
        cols = sorted(c["source"].get("columns") or [], key=lambda x: x.get("ordinal") or 0)
        key = list(c.get("key_columns") or [])
        g = build.udt(c["target"]["qualified"], cols, key)
        gens.append(g)
        sch, _, nm = c["target"]["qualified"].partition(".")
        udt_tables.append(Table(sch, nm, [(x["name"], sqlserver_type(str(x["type"]))) for x in cols]))
    for c in code_items:
        otype = c["source"]["type"]
        if otype == "user_defined_table":
            continue
        row = tc.execute("SELECT converted FROM estate.conversions WHERE name = %s AND object_type = %s AND "
                         "status = 'compiled' AND converted IS NOT NULL ORDER BY run_id DESC LIMIT 1",
                         (c["source"]["name"], otype)).fetchone()
        if not row:
            continue
        cases = [{**body, "id": str(tid), "name": name} for tid, name, body in tc.execute(
            "SELECT id, name, body FROM estate.conversion_tests WHERE project_id = %s AND lower(object_name) = "
            "lower(%s) ORDER BY name", (project_id, c["source"]["name"])).fetchall()]
        kind = {"procedure": "procedure", "function": "function", "trigger": "trigger"}.get(otype, "procedure")
        gens.append(build.converted_object(kind, c["target"]["qualified"], row[0], cases,
                                           base_tables + udt_tables, renames))
    # reports on the report access mechanism
    table_map = {m["source"]["table"]: m["target"]["table"] for m in register.items(tc, project_id, "mapping")
                 if m.get("target") and m["status"] != "rejected"}
    column_map: dict[str, dict[str, str]] = {}
    for m in register.items(tc, project_id, "mapping"):
        if m.get("target") and m["status"] != "rejected":
            column_map.setdefault(m["source"]["table"].lower(), {})[m["source"]["column"]] = m["target"]["column"]
    for r in register.items(tc, project_id, "report"):
        if r.get("target") and r.get("definition") and r["status"] != "rejected":
            gens.append(build.report_procedure(r["target"]["qualified"], r["definition"], table_map, column_map,
                                               base_tables + udt_tables))
    return gens


def start_build(s: Session, t: Tenant, p: Project, actor: audit.Actor) -> Job:
    job = enqueue(s, "design.build", f"Build and test generated code for {p.name}", actor,
                  {"project_id": str(p.id), "actor": actor_dict(actor)}, tenant_id=t.id, project_id=p.id)
    audit.record(s, actor, "build.run_requested", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"job": str(job.id)})
    return job

