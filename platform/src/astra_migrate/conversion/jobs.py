"""Code conversion as a background job (E10.F1.S1, E10.F1.S2).

Reads the source's code objects through its adapter, converts each one to the target dialect, compiles it on
the workbench against the pinned target baseline's tables (plus the source's own tables, which the code also
uses), runs the project's recorded test cases for it, and stores everything in the tenant database. Objects
that cannot be converted safely, or do not compile, go to the review queue with the reason.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters import source
from astra_migrate.adapters.engines import EngineError, EngineUnavailable, open_session
from astra_migrate.adapters.jobs import adapter_pack, content_of, params_for
from astra_migrate.connector_secrets import SecretError
from astra_migrate.conversion import sqlanywhere
from astra_migrate.conversion.sqlanywhere import Conversion
from astra_migrate.conversion.workbench import Table, Workbench, WorkbenchBlocked, sqlserver_type, tables_from_baseline
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import AdapterRun, ConversionRun, Job, ReviewItem, SourceConnection, TargetBaseline, Tenant
from astra_migrate.discovery.dictionary import harvest
from astra_migrate.jobs.runner import JobContext, JobFailed, actor_dict, handler, on_cancel
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

KINDS = ("procedure", "function", "trigger", "view")


def _same_dialect(kind: str, name: str, sql: str) -> Conversion:
    c = Conversion(kind, name, sql, re.sub(r"^\s*CREATE\s+OR\s+ALTER\b", "CREATE", sql.strip(), flags=re.I))
    c.rules.append("same dialect: compiled as written")
    return c


CONVERTERS: dict[tuple[str, str], Callable[[str, str, str], Conversion]] = {
    ("sqlanywhere", "sqlserver"): sqlanywhere.convert,
    ("sqlserver", "sqlserver"): _same_dialect,
}


def supported(source_dialect: str, target_dialect: str) -> bool:
    return (source_dialect, target_dialect) in CONVERTERS


def _type_for(source_dialect: str, t: str, max_length: int | None) -> str:
    t = t.strip().lower()
    if source_dialect == "sqlanywhere":
        for pat, repl, _ in sqlanywhere.TYPES:
            t = re.sub(pat, repl, t, flags=re.I)
    if t in ("varchar", "nvarchar", "char", "nchar", "varbinary", "binary") and max_length:
        size = "max" if max_length < 0 else str(max_length // 2 if t.startswith("n") else max_length)
        t = f"{t}({size})"
    return sqlserver_type(t)


def workbench_tables(baseline: dict[str, Any], source_columns: list[Any], source_dialect: str) -> list[Table]:
    """Target baseline tables first; the source's own tables are added where the baseline has no table of
    that name, because converted customer code still reads them after migration."""
    tables = tables_from_baseline(baseline)
    known = {f"{t.schema}.{t.name}".lower() for t in tables}
    extra: dict[str, Table] = {}
    for c in sorted(source_columns, key=lambda c: (c.table, c.ordinal)):
        if c.table.lower() in known:
            continue
        schema, _, name = c.table.partition(".")
        extra.setdefault(c.table.lower(), Table(schema, name, [])).columns.append(
            (c.name, _type_for(source_dialect, c.data_type, c.max_length)))
    return tables + list(extra.values())


def load_tests(t: Tenant, project_id: uuid.UUID) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        for tid, obj, name, body in tc.execute("SELECT id, object_name, name, body FROM estate.conversion_tests "
                                               "WHERE project_id = %s ORDER BY object_name, name",
                                               (project_id,)).fetchall():
            out.setdefault(str(obj).lower(), []).append({**body, "id": str(tid), "name": name})
    return out


@on_cancel("conversion.run")
def _cancel(s: Session, job: Job) -> None:
    run = s.get(ConversionRun, uuid.UUID(job.payload["run_id"]))
    if run is not None and run.status == "queued":
        run.status, run.finished_at = "cancelled", datetime.now(UTC)


def _fail(run_id: uuid.UUID, status: str, detail: str) -> JobFailed:
    with session_scope() as s:
        r = s.get(ConversionRun, run_id)
        if r is not None:
            r.status, r.status_detail, r.finished_at = status, detail, datetime.now(UTC)
    return JobFailed(detail)


@handler("conversion.run")
def run_conversion(ctx: JobContext) -> dict[str, Any]:
    run_id = uuid.UUID(ctx.payload["run_id"])
    with session_scope() as s:
        run = s.get(ConversionRun, run_id)
        if run is None:
            raise JobFailed("The conversion run no longer exists.")
        conn, t = s.get(SourceConnection, run.connection_id), s.get(Tenant, run.tenant_id)
        if conn is None or t is None or t.status != "active":
            raise _fail(run_id, "failed", "The connection or tenant is no longer available.")
        if s.scalar(select(AdapterRun.id).where(AdapterRun.connection_id == conn.id, AdapterRun.kind == "check",
                                                AdapterRun.status == "succeeded")) is None:
            raise _fail(run_id, "blocked", "Conversion needs a passing connection check first.")
        content = content_of(adapter_pack(s, conn.adapter))
        try:
            params = params_for(s, conn, t)
        except SecretError as e:
            raise _fail(run_id, "failed", f"The connection's password reference cannot be read: {e}") from e
        baseline = s.get(TargetBaseline, run.baseline_id)
        assert baseline is not None
        baseline_content = baseline.content
        run.status = "running"
        engine, src_d, tgt_d, project_id, tenant_obj = (conn.engine, run.source_dialect, run.target_dialect,
                                                        run.project_id, t)
        s.expunge(t)
    convert = CONVERTERS[(src_d, tgt_d)]
    try:
        wb = Workbench()
    except WorkbenchBlocked as e:
        raise _fail(run_id, "blocked", str(e)) from e
    ctx.progress(5, "Reading the source code through its adapter")
    try:
        sess = open_session(engine, params)
    except EngineUnavailable as e:
        wb.close()
        raise _fail(run_id, "blocked", str(e)) from e
    except EngineError as e:
        wb.close()
        raise _fail(run_id, "failed", str(e)) from e
    try:
        meta = source.read_metadata(sess, content)
        dictionary = harvest(sess, content)
    except EngineError as e:
        wb.close()
        raise _fail(run_id, "failed", str(e)) from e
    finally:
        sess.close()
    code_types = {o.key: o for o in content.object_types if o.code}
    objects = sorted((m for m in meta.objects if m.type in code_types and m.definition),
                     key=lambda m: (m.type, m.qualified.lower()))
    missing = sum(1 for m in meta.objects if m.type in code_types and not m.definition)
    tables = workbench_tables(baseline_content, dictionary.columns, src_d)
    tests = load_tests(tenant_obj, project_id)
    rows: list[tuple[Any, ...]] = []
    counts = {"compiled": 0, "compile_failed": 0, "review": 0}
    test_counts = {"passed": 0, "failed": 0}
    review: list[tuple[str, str, list[str]]] = []
    try:
        for i, m in enumerate(objects):
            ctx.progress(10 + int(85 * i / max(1, len(objects))), f"Converting {m.qualified}")
            kind = m.type if m.type in KINDS else (code_types[m.type].compare_as or m.type)
            qualified = f"{m.schema or 'dbo'}.{m.name}"
            assert m.definition is not None
            c = convert(kind, qualified, m.definition)
            comp: dict[str, Any] = {}
            results: list[dict[str, Any]] = []
            if c.needs_review or c.converted is None:
                status = "review"
                review.append((qualified, kind, c.review or ["The object could not be converted."]))
            else:
                res = wb.compile(tables, c.converted, qualified)
                comp = res.as_dict()
                status = "compiled" if res.ok else "compile_failed"
                if res.ok:
                    for case in tests.get(qualified.lower(), []):
                        o = wb.run_test(tables, c.converted, kind, qualified, case)
                        results.append(o.__dict__)
                        test_counts["passed" if o.passed else "failed"] += 1
                else:
                    review.append((qualified, kind, [f"Does not compile on the workbench: {res.error}"]))
            counts[status] += 1
            rows.append((run_id, m.type, qualified, status, m.definition, c.converted, json.dumps(c.rules),
                         json.dumps(c.warnings), json.dumps(c.review), json.dumps(comp), json.dumps(results)))
    finally:
        wb.close()
    with tenant_connection(tenant_obj, get_vault()) as tc, tc.transaction(), tc.cursor() as cur:
        cur.executemany(
            "INSERT INTO estate.conversions(run_id, object_type, name, status, source, converted, rules, "
            "warnings, review, compile, tests) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", rows)
    summary = {"objects": len(objects), **counts, "tests": test_counts, "code_unreadable": missing,
               "workbench_tables": len(tables)}
    with session_scope() as s:
        r = s.get(ConversionRun, run_id)
        assert r is not None
        r.summary, r.status, r.finished_at = summary, "succeeded", datetime.now(UTC)
        for qualified, kind, reasons in review:
            s.add(ReviewItem(
                tenant_id=r.tenant_id, project_id=project_id, kind="proposal",
                title=f"Convert by hand: {kind} {qualified}"[:300],
                question="Automatic conversion stopped for this object. " + " ".join(reasons),
                options=["Convert by hand", "Retire the object", "Keep it out of scope"],
                owner_role="solution_architect",
                context={"conversion_run_id": str(run_id), "object": qualified, "kind": kind, "reasons": reasons},
                requested_by=actor_dict(audit.Actor.system("conversion")), status="open"))
        audit.record(s, ctx.actor, "conversion.run_finished", tenant_id=r.tenant_id, project_id=project_id,
                     target_type="conversion_run", target_id=str(run_id), details=summary)
    return summary
