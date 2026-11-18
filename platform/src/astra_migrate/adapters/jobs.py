"""Adapter operations as background jobs: connection check, metadata harvest (with traps and coverage),
full and delta extraction, and golden dataset runs."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import psycopg
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters import source
from astra_migrate.adapters.contract import SourceAdapterContent, Trap, parse_source
from astra_migrate.adapters.engines import ConnParams, EngineError, EngineUnavailable, open_session
from astra_migrate.connector_secrets import SecretError, read_for_connector
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import AdapterRun, CuratedTrap, GoldenRun, Job, Pack, SourceConnection, Tenant
from astra_migrate.golden.runner import GoldenBlocked, run_dataset
from astra_migrate.jobs.runner import JobContext, JobFailed, handler, on_cancel
from astra_migrate.packs.registry import manifest_of
from astra_migrate.packs.schema import Manifest, parse_ref
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

log = logging.getLogger(__name__)


class AdapterError(ValueError):
    pass


def adapter_pack(session: Session, ref: str, *, published_only: bool = True) -> Pack:
    name, version = parse_ref(ref)
    stmt = select(Pack).where(Pack.name == name, Pack.version == version)
    if published_only:
        stmt = stmt.where(Pack.status.in_(("published", "deprecated")))
    p = session.scalar(stmt)
    if p is None:
        raise AdapterError(f"{ref} is not a {'published ' if published_only else ''}pack.")
    if p.type != "source_adapter":
        raise AdapterError(f"{ref} is a {p.type} pack, not a source adapter.")
    return p


def content_of(p: Pack) -> SourceAdapterContent:
    return parse_source(manifest_of(p).content)


def all_traps(session: Session, p: Pack, content: SourceAdapterContent) -> list[tuple[Trap, str]]:
    traps: list[tuple[Trap, str]] = [(t, "pack") for t in content.traps]
    shipped = {t.id for t in content.traps}
    for ct in session.scalars(select(CuratedTrap).where(CuratedTrap.adapter_name == p.name, CuratedTrap.active)):
        if ct.trap_id not in shipped:
            traps.append((Trap.model_validate(ct.definition), "curated"))
    return traps


def params_for(session: Session, conn: SourceConnection, t: Tenant) -> ConnParams:
    password = read_for_connector(session, get_vault(), t, conn.password_ref, f"source:{conn.name}")
    return ConnParams(conn.host, conn.port, conn.database, conn.username, password, conn.encrypt)


def _load(run_id: uuid.UUID) -> tuple[AdapterRun, SourceConnection, Tenant, Pack, ConnParams]:
    with session_scope() as s:
        run = s.get(AdapterRun, run_id)
        if run is None:
            raise JobFailed("The adapter run no longer exists.")
        conn, t = s.get(SourceConnection, run.connection_id), s.get(Tenant, run.tenant_id)
        if conn is None or t is None or t.status != "active":
            raise JobFailed("The connection or tenant is no longer available.")
        p = adapter_pack(s, conn.adapter)
        try:
            params = params_for(s, conn, t)
        except SecretError as e:
            raise JobFailed(f"The connection's password reference cannot be read: {e}") from e
        run.status = "running"
        s.expunge_all()
        return run, conn, t, p, params


def _finish(run_id: uuid.UUID, status: str, summary: dict[str, Any], detail: str | None,
            actor: audit.Actor) -> None:
    with session_scope() as s:
        run = s.get(AdapterRun, run_id)
        assert run is not None
        run.status, run.summary, run.status_detail, run.finished_at = status, summary, detail, datetime.now(UTC)
        if run.kind == "check":
            conn = s.get(SourceConnection, run.connection_id)
            if conn is not None:
                conn.last_check = {"status": status, **summary, "detail": detail}
                conn.last_checked_at = datetime.now(UTC)
        audit.record(s, actor, f"adapter.{run.kind}_finished",
                     outcome="success" if status == "succeeded" else "failure",
                     tenant_id=run.tenant_id, target_type="adapter_run", target_id=str(run.id),
                     details={"adapter": run.adapter, "mode": run.mode, "status": status,
                              **{k: v for k, v in summary.items() if k in ("objects", "coverage_complete", "traps",
                                                                            "entities", "documents")}})


def _guard(run_id: uuid.UUID, ctx: JobContext, fn: Any) -> dict[str, Any]:
    try:
        result: dict[str, Any] = fn()
        return result
    except EngineUnavailable as e:
        _finish(run_id, "blocked", {}, str(e), ctx.actor)
        raise JobFailed(str(e)) from e
    except EngineError as e:
        _finish(run_id, "failed", {}, str(e), ctx.actor)
        raise JobFailed(str(e)) from e


@on_cancel("adapter.run")
def _cancel(s: Session, job: Job) -> None:
    run = s.get(AdapterRun, uuid.UUID(job.payload["run_id"]))
    if run is not None and run.status == "queued":
        run.status, run.finished_at = "cancelled", datetime.now(UTC)


@handler("adapter.run")
def run_adapter(ctx: JobContext) -> dict[str, Any]:
    run_id = uuid.UUID(ctx.payload["run_id"])
    run, conn, t, p, params = _load(run_id)
    content = content_of(p)
    match run.kind:
        case "check":
            return _guard(run_id, ctx, lambda: _check(run_id, ctx, conn, content, params))
        case "harvest":
            return _guard(run_id, ctx, lambda: _harvest(run_id, ctx, conn, t, p, content, params))
        case "extract":
            return _guard(run_id, ctx, lambda: _extract(run_id, ctx, conn, t, content, params, run.mode or "full"))
    raise JobFailed(f"Unknown adapter run kind {run.kind}")


def _check(run_id: uuid.UUID, ctx: JobContext, conn: SourceConnection, content: SourceAdapterContent,
           params: ConnParams) -> dict[str, Any]:
    support = next((e for e in content.engines if e.engine == conn.engine), None)
    if support is None:
        _finish(run_id, "failed", {}, f"The adapter does not support {conn.engine}.", ctx.actor)
        raise JobFailed(f"The adapter does not support {conn.engine}.")
    sess = open_session(conn.engine, params)
    try:
        chk = sess.check(support.min_version)
    finally:
        sess.close()
    summary = chk.model_dump()
    status = "succeeded" if chk.ok else "failed"
    detail = None if chk.ok else ("The account can write to the source. Adapters only run with read-only accounts. "
                                  if not chk.read_only else "") + " ".join(chk.problems)
    _finish(run_id, status, summary, detail, ctx.actor)
    if not chk.ok:
        raise JobFailed(detail or "The connection check failed.")
    return summary


def _tenant_write(t: Tenant, fn: Any) -> None:
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        with tc.transaction():
            fn(tc)


def _harvest(run_id: uuid.UUID, ctx: JobContext, conn: SourceConnection, t: Tenant, p: Pack,
             content: SourceAdapterContent, params: ConnParams) -> dict[str, Any]:
    ctx.progress(10, "Reading metadata")
    sess = open_session(conn.engine, params)
    try:
        meta = source.read_metadata(sess, content)
        ctx.progress(60, "Evaluating known traps")
        with session_scope() as s:
            traps = all_traps(s, p, content)
        findings, trap_errors = source.evaluate_traps(sess, traps, meta)
    finally:
        sess.close()
    ctx.progress(80, "Saving the inventory")

    def write(tc: psycopg.Connection[Any]) -> None:
        with tc.cursor() as cur:
            cur.executemany(
                "INSERT INTO estate.metadata_objects(run_id, object_type, schema_name, name, owner, modified_at, "
                "definition, definition_sha256, depends_on, detail) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [(run_id, o.type, o.schema or "", o.name, o.owner, o.modified_at, o.definition, o.definition_sha256,
                  json.dumps(o.depends_on), json.dumps(o.detail, default=str)) for o in meta.objects])
            cur.executemany(
                "INSERT INTO estate.coverage(run_id, object_type, label, required, status, object_count, error, "
                "dependencies, code_missing) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [(run_id, c.object_type, c.label, c.required, c.status, c.count, c.error, c.dependencies,
                  c.code_missing) for c in meta.coverage])
            cur.executemany(
                "INSERT INTO estate.trap_findings(run_id, trap_id, origin, title, severity, stream, advice, hits) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                [(run_id, f.trap_id, f.origin, f.title, f.severity, f.stream, f.advice, json.dumps(f.hits))
                 for f in findings])

    _tenant_write(t, write)
    summary = {"objects": len(meta.objects), "objects_by_type": meta.by_type(), "coverage_complete": meta.complete,
               "coverage_gaps": [{"object_type": c.object_type, "status": c.status, "code_missing": c.code_missing}
                                 for c in meta.coverage if c.status == "failed" or c.code_missing],
               "traps": [{"id": f.trap_id, "severity": f.severity, "origin": f.origin, "hits": len(f.hits)}
                         for f in findings], "trap_errors": trap_errors}
    _finish(run_id, "succeeded", summary, None if meta.complete else "Some object types could not be read fully.",
            ctx.actor)
    return {"objects": len(meta.objects), "traps": len(findings), "coverage_complete": meta.complete}


def _previous_marks(t: Tenant, connection_id: uuid.UUID) -> dict[str, str]:
    with session_scope() as s:
        prev = [r.id for r in s.scalars(select(AdapterRun).where(
            AdapterRun.connection_id == connection_id, AdapterRun.kind == "extract",
            AdapterRun.status == "succeeded").order_by(AdapterRun.created_at.desc()))]
    if not prev:
        return {}
    marks: dict[str, str] = {}
    with tenant_connection(t, get_vault()) as tc:
        for rid in prev:
            for entity, wm in tc.execute("SELECT entity, watermark FROM estate.extract_counts WHERE run_id = %s",
                                         (rid,)).fetchall():
                if entity not in marks and wm:
                    marks[entity] = wm
    return marks


def _extract(run_id: uuid.UUID, ctx: JobContext, conn: SourceConnection, t: Tenant, content: SourceAdapterContent,
             params: ConnParams, mode: str) -> dict[str, Any]:
    marks = _previous_marks(t, conn.id) if mode == "delta" else {}
    if mode == "delta" and not marks:
        _finish(run_id, "failed", {}, "A delta extract needs a successful full extract first.", ctx.actor)
        raise JobFailed("A delta extract needs a successful full extract first.")
    sess = open_session(conn.engine, params)
    entities: dict[str, dict[str, Any]] = {}
    docs_summary: dict[str, Any] = {}
    try:
        with tenant_connection(t, get_vault()) as tc:
            migrate_tenant_schema(tc)
            total = max(1, len(content.entities))
            for i, e in enumerate(content.entities):
                ctx.progress(5 + int(80 * i / total), f"Extracting {e.name}")
                since = marks.get(e.name) if mode == "delta" else None
                if mode == "delta" and not e.delta_column:
                    entities[e.name] = {"extracted": 0, "skipped": "no delta column; use a full extract"}
                    continue
                wm = source.watermark(sess, e)
                n = 0
                with tc.transaction(), tc.cursor() as cur:
                    for batch in source.extract_entity(sess, e, since=since):
                        cur.executemany("INSERT INTO estate.extract_rows(run_id, entity, row_key, row_data) "
                                        "VALUES (%s,%s,%s,%s)",
                                        [(run_id, e.name, k, json.dumps(r, default=str)) for k, r in batch])
                        n += len(batch)
                    src = source.count_rows(sess, e, since)
                    cur.execute("INSERT INTO estate.extract_counts(run_id, entity, mode, source_count, extracted, "
                                "watermark) VALUES (%s,%s,%s,%s,%s,%s)",
                                (run_id, e.name, mode, src, n, str(wm) if wm is not None else None))
                entities[e.name] = {"extracted": n, "source_count": src, "matches": src == n}
            if content.documents:
                ctx.progress(88, "Extracting documents")
                d = content.documents
                since = marks.get("__documents__") if mode == "delta" else None
                keys: dict[str, set[str]] = {}
                for ent, in tc.execute("SELECT DISTINCT entity FROM estate.extract_rows").fetchall():
                    keys[ent] = {r[0] for r in tc.execute(
                        "SELECT DISTINCT row_key FROM estate.extract_rows WHERE entity = %s", (ent,)).fetchall()}
                n_docs = broken = 0
                with tc.transaction(), tc.cursor() as cur:
                    for doc_batch in source.extract_documents(sess, d, since=since):
                        rows = []
                        for doc in doc_batch:
                            ok = bool(doc.link_entity and doc.link_key
                                      and doc.link_key in keys.get(doc.link_entity, ()))
                            broken += 0 if ok else 1
                            rows.append((run_id, doc.key, doc.name, doc.link_type, doc.link_entity, doc.link_key, ok,
                                         doc.created_at, len(doc.content) if doc.content is not None else None,
                                         doc.sha256, doc.content))
                        cur.executemany("INSERT INTO estate.documents(run_id, doc_key, name, link_type, link_entity, "
                                        "link_key, link_resolved, created_at, size_bytes, sha256, content) "
                                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", rows)
                        n_docs += len(doc_batch)
                docs_summary = {"extracted": n_docs, "broken_links": broken}
    finally:
        sess.close()
    mismatched = [k for k, v in entities.items() if v.get("matches") is False]
    summary = {"mode": mode, "entities": entities, "documents": docs_summary,
               "rows": sum(int(v.get("extracted", 0)) for v in entities.values())}
    status = "failed" if mismatched else "succeeded"
    detail = f"Counts do not match the source for: {', '.join(mismatched)}" if mismatched else None
    _finish(run_id, status, summary, detail, ctx.actor)
    if mismatched:
        raise JobFailed(detail or "")
    return {"rows": summary["rows"], "documents": docs_summary.get("extracted", 0)}


# ------------------------------------------------------------------ golden runs

@handler("golden.run")
def golden(ctx: JobContext) -> dict[str, Any]:
    gid = uuid.UUID(ctx.payload["golden_run_id"])
    with session_scope() as s:
        g = s.get(GoldenRun, gid)
        if g is None:
            raise JobFailed("The golden run no longer exists.")
        refs = list(g.packs)
        adapter_ref, dataset = g.dataset.rsplit(":", 1)
        packs: dict[str, tuple[Manifest, dict[str, bytes], str]] = {}
        for ref in refs:
            name, version = parse_ref(ref)
            p = s.scalar(select(Pack).where(Pack.name == name, Pack.version == version))
            if p is None:
                raise JobFailed(f"{ref} no longer exists.")
            from astra_migrate.db.models import PackFile

            files = {f.path: bytes(f.content) for f in s.scalars(select(PackFile).where(PackFile.pack_id == p.id))}
            packs[ref] = (manifest_of(p), files, p.digest)
        changed = [r for r in refs if packs[r][2] != g.packs[r]]
        g.status = "running"
        keep = g.keep
    if changed:
        _golden_finish(gid, "error", None, f"Pack(s) changed since the run was requested: {', '.join(changed)}")
        raise JobFailed("Pack contents changed since the run was requested.")
    adapter_m, adapter_files, _ = packs[adapter_ref]
    domain = [m for r, (m, _f, _d) in packs.items() if r != adapter_ref and m.type.value == "domain"]
    try:
        card = run_dataset(adapter_m, adapter_files, dataset, domain, keep=keep, progress=ctx.progress)
    except GoldenBlocked as e:
        _golden_finish(gid, "blocked", None, str(e))
        raise JobFailed(str(e)) from e
    status = "passed" if card.passed else "failed"
    _golden_finish(gid, status, card.as_dict(), None if card.passed else
                   f"{sum(1 for m in card.measures if not m.passed)} measure(s) did not match the expected answers.")
    return {"status": status, "measures": len(card.measures)}


def _golden_finish(gid: uuid.UUID, status: str, card: dict[str, Any] | None, detail: str | None) -> None:
    with session_scope() as s:
        g = s.get(GoldenRun, gid)
        assert g is not None
        g.status, g.scorecard, g.status_detail, g.finished_at = status, card, detail, datetime.now(UTC)
        audit.record(s, audit.Actor.system("golden"), "golden.run_finished",
                     outcome="success" if status == "passed" else "failure", target_type="golden_run",
                     target_id=str(g.id), details={"dataset": g.dataset, "status": status, "packs": g.packs})
