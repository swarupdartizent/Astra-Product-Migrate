"""Load runs (E13.F1), validation (E14.F1.S1), reconciliation to the cent (E14.F1.S2) and data quality (E14.F1.S3).

A run pins the approved transformation code (artifact ids and digests), the pack versions and the input extract.
For each artifact it stages the extract's rows (optionally only one segment), runs the approved procedure on the SQL
Server workbench in a rolled-back transaction and reads the target-shaped rows. Every row is validated. Rows that
pass are sent through the target adapter's load endpoint for their table (a rehearsal sends nothing). Delta and
repeat loads skip records whose payload is unchanged since they were last loaded. Every record is stored with its
outcome, the target's reason and its validation failures, which is the error queue.

Reconciliation compares, per target table, the source rows, the transformed rows and the records the target
accepted (or would accept, in a rehearsal): counts and every measured amount to the cent. Each difference is a
break with an owner. The result digest lets a rerun with the same pinned inputs prove it gave the same result.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections import Counter
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import psycopg
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters.contract import SourceAdapterContent, TargetAdapterContent
from astra_migrate.adapters.jobs import adapter_pack, content_of
from astra_migrate.adapters.target import TargetClient, TargetError, target_pack
from astra_migrate.blueprints import service as blueprints
from astra_migrate.blueprints.model import Blueprint
from astra_migrate.connector_secrets import SecretError, read_for_connector
from astra_migrate.conversion.workbench import IDENT, Table, Workbench, WorkbenchBlocked, q, sqlserver_type
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import (
    AdapterRun,
    BlueprintVersion,
    BuildArtifact,
    DiscoveryRun,
    Job,
    LoadRun,
    Project,
    ReconBreak,
    SourceConnection,
    TargetConnection,
    Tenant,
)
from astra_migrate.design.build import STAGE_SRC, STAGE_TGT, XF_SCHEMA, stage_name, stage_type
from astra_migrate.design.jobs import target_of
from astra_migrate.design.mapping import family
from astra_migrate.jobs.runner import JobContext, JobFailed, actor_dict, enqueue, handler, on_cancel
from astra_migrate.loads import validate
from astra_migrate.packs import registry as pack_registry
from astra_migrate.review import service as reviews
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

CENT = Decimal("0.01")
ROW = "__row__"
ACCEPTED = ("loaded", "unchanged", "rehearsed")
BATCH = 500


class LoadError(Exception):
    pass


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def money(v: Any) -> Decimal | None:
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v)).quantize(CENT, rounding=ROUND_HALF_UP)
    except ArithmeticError:
        return None


def approved_blueprint(s: Session, project_id: uuid.UUID) -> Blueprint | None:
    bv = s.scalars(select(BlueprintVersion).where(BlueprintVersion.project_id == project_id,
                                                  BlueprintVersion.status == "approved")
                   .order_by(BlueprintVersion.number.desc())).first() or blueprints.latest(s, project_id)
    if bv is None:
        return None
    try:
        return Blueprint.model_validate(bv.content or {})
    except ValueError:
        return None


# ------------------------------------------------------------------ starting a run

def start(s: Session, t: Tenant, p: Project, kind: str, actor: audit.Actor, extract_run_id: uuid.UUID | None,
          target_connection_id: uuid.UUID | None, segment: dict[str, Any] | None,
          parent: LoadRun | None = None, reload_keys: list[dict[str, str]] | None = None) -> LoadRun:
    arts = list(s.scalars(select(BuildArtifact).where(BuildArtifact.project_id == p.id,
                                                      BuildArtifact.kind == "transformation",
                                                      BuildArtifact.status == "approved")
                          .order_by(BuildArtifact.name)))
    if parent is not None:
        pinned = {a["id"] for a in parent.artifacts}
        arts = [a for a in s.scalars(select(BuildArtifact).where(BuildArtifact.project_id == p.id))
                if str(a.id) in pinned and a.status == "approved"]
        if len(arts) != len(pinned):
            raise LoadError("Some code the original run used is no longer approved; reload from a new run instead.")
    if not arts:
        raise LoadError("No approved transformation code: build, test and approve transformations first.")
    if extract_run_id is not None:
        ar = s.get(AdapterRun, extract_run_id)
        if ar is None or ar.kind != "extract" or ar.status != "succeeded" or ar.tenant_id != t.id:
            raise LoadError("Choose a successful extract run of this tenant.")
    bp = approved_blueprint(s, p.id)
    b, tgt = target_of(s, p.id)
    packs = {"blueprint": [*(bp.domain_packs if bp else []), *(bp.compliance_packs if bp else []),
                           *(bp.pattern_packs if bp else [])],
             "source": bp.source.adapter if bp else None, "target": bp.target.adapter if bp else None,
             "target_baseline": str(b.id) if b else None}
    pinned_arts = [{"id": str(a.id), "name": a.name, "version": a.version, "digest": a.digest} for a in arts]
    number = (s.scalar(select(LoadRun.number).where(LoadRun.project_id == p.id)
                       .order_by(LoadRun.number.desc()).limit(1)) or 0) + 1
    run = LoadRun(tenant_id=t.id, project_id=p.id, number=number, kind=kind,
                  parent_run_id=parent.id if parent else None,
                  extract_run_id=extract_run_id if parent is None else parent.extract_run_id,
                  target_connection_id=target_connection_id, segment=segment if parent is None else parent.segment,
                  artifacts=pinned_arts, packs=packs, status="queued", summary={},
                  input_digest=digest({"artifacts": pinned_arts, "packs": packs,
                                       "extract": str(extract_run_id if parent is None else parent.extract_run_id),
                                       "segment": segment if parent is None else parent.segment,
                                       "target": str(target_connection_id), "kind": kind,
                                       "reload": reload_keys or []}),
                  requested_by=actor_dict(actor))
    s.add(run)
    s.flush()
    job = enqueue(s, "load.run", f"Load run {number} ({kind}) for {p.name}", actor,
                  {"run_id": str(run.id), "reload": reload_keys or []}, tenant_id=t.id, project_id=p.id)
    run.job_id = job.id
    audit.record(s, actor, "load.run_requested", tenant_id=t.id, project_id=p.id, target_type="load_run",
                 target_id=str(run.id), details={"number": number, "kind": kind, "artifacts": pinned_arts,
                                                 "packs": packs, "segment": run.segment,
                                                 "extract_run": str(run.extract_run_id)})
    return run


@on_cancel("load.run")
def _cancel(s: Session, job: Job) -> None:
    run = s.get(LoadRun, uuid.UUID(job.payload["run_id"]))
    if run is not None and run.status == "queued":
        run.status, run.finished_at = "cancelled", datetime.now(UTC)


def _fail(run_id: uuid.UUID, status: str, detail: str) -> JobFailed:
    with session_scope() as s:
        r = s.get(LoadRun, run_id)
        if r is not None:
            r.status, r.status_detail, r.finished_at = status, detail, datetime.now(UTC)
    return JobFailed(detail)


# ------------------------------------------------------------------ the run


def _rules(s: Session, bp: Blueprint | None) -> list[validate.Rule]:
    raw: list[tuple[str, str, str, dict[str, Any], str]] = []
    for ref in [*(bp.domain_packs if bp else []), *(bp.pattern_packs if bp else [])]:
        try:
            pk = pack_registry.get_by_ref(s, ref, published_only=False)
        except ValueError:
            continue
        if pk is None:
            continue
        m = pack_registry.manifest_of(pk)
        raw += [(r.id, r.statement, r.severity, r.check, m.type.value) for r in m.adds.rules if r.check]
    return validate.compile_rules(raw)


def _context(arts: list[dict[str, Any]], content: SourceAdapterContent | None, baseline: dict[str, Any],
             rules: list[validate.Rule]) -> validate.Context:
    cols: dict[str, dict[str, dict[str, Any]]] = {}
    for o in baseline.get("objects", []):
        if o.get("type") == "table":
            cols[f"{o.get('schema') or 'dbo'}.{o['name']}".lower()] = {
                str(c["name"]).lower(): c for c in o.get("columns") or []}
    ents = {e.table.lower(): e for e in (content.entities if content else [])}
    by_name = {e.name: e for e in (content.entities if content else [])}
    # source table -> (target table, source column -> target column)
    maps: dict[str, tuple[str, dict[str, str]]] = {}
    for a in arts:
        inp = a["inputs"]
        maps[inp["source_table"].lower()] = (inp["target_table"].lower(),
                                             {m["source"].lower(): m["target"] for m in inp["mappings"]})
    keys: dict[str, list[str]] = {}
    concepts: dict[str, tuple[str, dict[str, str], dict[str, tuple[str, str]]]] = {}
    relations: list[validate.Relation] = []
    for st, (tt, cm) in maps.items():
        e = ents.get(st)
        if e is None:
            continue
        key = [cm.get(k.lower()) for k in e.key]
        if all(key):
            keys[tt] = [str(k) for k in key]
        attrs = {attr: cm[col.lower()] for attr, col in e.attributes.items() if col.lower() in cm}
        rels: dict[str, tuple[str, str]] = {}
        for rname, rel in e.relations.items():
            parent = by_name.get(rel.entity)
            child_col = cm.get(rel.column.lower())
            if parent is None or child_col is None:
                continue
            pmap = maps.get(parent.table.lower())
            if pmap and len(parent.key) == 1 and parent.key[0].lower() in pmap[1]:
                relations.append(validate.Relation(tt, child_col, pmap[0], pmap[1][parent.key[0].lower()], rname))
            if parent.concept:
                rels[rname] = (child_col, parent.concept)
        if e.concept:
            concepts[e.concept] = (tt, attrs, rels)
    return validate.Context(cols, keys, relations, {}, concepts, rules)


def _stage(wb: Workbench, a: dict[str, Any], rows: list[dict[str, Any]]) -> tuple[str | None, list[dict[str, Any]]]:
    inp = a["inputs"]
    src_cols, tgt_cols = inp["source_columns"], inp["target_columns"]
    src_t = Table(STAGE_SRC, stage_name(inp["source_table"]),
                  [(c["name"], stage_type(str(c["type"]), c.get("max_length"))) for c in src_cols],
                  frozenset(c["name"] for c in src_cols if not c.get("nullable", True)))
    tgt_t = Table(STAGE_TGT, stage_name(inp["target_table"]),
                  [(str(c["name"]), sqlserver_type(str(c.get("type", "")))) for c in tgt_cols],
                  frozenset(str(c["name"]) for c in tgt_cols if c.get("nullable") is False))
    names = {c["name"].lower(): c["name"] for c in src_cols if IDENT.fullmatch(c["name"])}
    ordered = list(names.values())
    insert = (f"INSERT INTO {q(STAGE_SRC)}.{q(src_t.name)} ({', '.join(q(c) for c in ordered)}) "
              f"VALUES ({', '.join(['%s'] * len(ordered))})")
    low = [{k.lower(): v for k, v in r.items()} for r in rows]
    values = [tuple(r.get(c.lower()) for c in ordered) for r in low]
    # the staged rows go in first, then the approved procedure is created and run
    steps: list[tuple[str, tuple[Any, ...] | None]] = [
        (f"IF SCHEMA_ID(N'{XF_SCHEMA}') IS NULL EXEC('CREATE SCHEMA {q(XF_SCHEMA)}')", None), (a["code"], None),
        (f"EXEC {q(XF_SCHEMA)}.{q(inp['procedure'])}", None)]
    return wb.rows([src_t, tgt_t], steps, f"SELECT * FROM {q(STAGE_TGT)}.{q(tgt_t.name)}",
                   batches=[(insert, values)])


@handler("load.run")
def run_load(ctx: JobContext) -> dict[str, Any]:
    run_id = uuid.UUID(ctx.payload["run_id"])
    reload_keys = list(ctx.payload.get("reload") or [])
    with session_scope() as s:
        run = s.get(LoadRun, run_id)
        if run is None:
            raise JobFailed("The load run no longer exists.")
        t, p = s.get(Tenant, run.tenant_id), s.get(Project, run.project_id)
        if t is None or p is None or t.status != "active":
            raise _fail(run_id, "failed", "The project or tenant is no longer available.")
        bp = approved_blueprint(s, p.id)
        b, _tgt = target_of(s, p.id)
        if b is None:
            raise _fail(run_id, "blocked", "Pin a target baseline first.")
        baseline = b.content
        content: SourceAdapterContent | None = None
        if run.extract_run_id:
            ar = s.get(AdapterRun, run.extract_run_id)
            conn = s.get(SourceConnection, ar.connection_id) if ar else None
            if conn is not None:
                c = content_of(adapter_pack(s, conn.adapter))
                content = c if isinstance(c, SourceAdapterContent) else None
        rules = _rules(s, bp)
        tconn = s.get(TargetConnection, run.target_connection_id) if run.target_connection_id else None
        tcontent: TargetAdapterContent | None = None
        secret = None
        if tconn is not None:
            _pk, tcontent = target_pack(s, tconn.adapter)
            try:
                secret = read_for_connector(s, get_vault(), t, tconn.client_secret_ref, f"target:{tconn.name}")
            except SecretError as e:
                raise _fail(run_id, "failed", f"The target connection's secret cannot be read: {e}") from e
        earlier = [str(r.id) for r in s.scalars(select(LoadRun).where(LoadRun.project_id == p.id,
                                                                      LoadRun.number < run.number))]
        prev_same = s.scalars(select(LoadRun).where(LoadRun.project_id == p.id, LoadRun.number < run.number,
                                                    LoadRun.input_digest == run.input_digest,
                                                    LoadRun.status == "succeeded")
                              .order_by(LoadRun.number.desc())).first()
        prev_same_info = (prev_same.number, prev_same.result_digest) if prev_same else None
        disc = s.scalars(select(DiscoveryRun).where(DiscoveryRun.project_id == p.id,
                                                    DiscoveryRun.status == "succeeded")
                         .order_by(DiscoveryRun.created_at.desc())).first()
        run.status = "running"
        arts_meta, kind, segment, extract_id, number = (list(run.artifacts), run.kind, run.segment,
                                                        run.extract_run_id, run.number)
        owner_holders = reviews.holders(s, t, p.id, "customer_data_owner")
        owner = next(iter(owner_holders)) if len(owner_holders) == 1 else None
        s.expunge(t)
        if tconn is not None:
            s.expunge(tconn)
        tenant_obj, project_id = t, p.id
    try:
        wb = Workbench()
    except WorkbenchBlocked as e:
        raise _fail(run_id, "blocked", str(e)) from e
    client = TargetClient(tconn, tcontent, secret) if tconn is not None and tcontent and secret else None
    summary: dict[str, Any] = {"tables": {}, "dq": {}, "measures": [], "errors": []}
    try:
        with tenant_connection(tenant_obj, get_vault()) as tc:
            migrate_tenant_schema(tc)
            arts = _load_artifacts(tc, arts_meta)
            if any("source_columns" not in a["inputs"] for a in arts):
                raise _fail(run_id, "blocked", "Some approved code was built before I10 and does not pin its table "
                                               "definitions; run a build and approve the new versions.")
            vctx = _context(arts, content, baseline, rules)
            vctx.known_keys = _known(tc, earlier, kind)
            last = _last_digests(tc, earlier)
            disc_scores = _scores(tc, disc.id if disc else None)
            parent_rows = _reload_rows(tc, run_id, reload_keys) if reload_keys else None
            staged: dict[str, list[dict[str, Any]]] = {}
            source_rows: dict[str, list[dict[str, Any]]] = {}
            for i, a in enumerate(arts):
                inp = a["inputs"]
                ctx.progress(5 + int(40 * i / max(1, len(arts))), f"Transforming {a['name']}")
                tt = inp["target_table"].lower()
                if parent_rows is not None:
                    staged[tt] = [r for (tab, _k), r in parent_rows.items() if tab == tt]
                    source_rows[tt] = []
                    continue
                rows = _extract(tc, extract_id, content, inp["source_table"]) if extract_id else []
                rows = _segment(rows, segment)
                source_rows[tt] = rows
                err, out = _stage(wb, a, rows)
                if err:
                    summary["errors"].append({"artifact": a["name"], "error": err})
                    staged[tt] = []
                    continue
                staged[tt] = out
            ctx.progress(50, "Validating")
            for tt, rows in staged.items():
                if not vctx.keys.get(tt):  # no entity key: records are numbered within the run
                    vctx.keys[tt] = [ROW]
                    for n, row in enumerate(rows):
                        row[ROW] = n + 1
            failures = validate.run(vctx, staged)
            for rows in staged.values():
                for row in rows:
                    row.pop(ROW, None)
            ctx.progress(60, "Loading" if kind != "rehearsal" else "Recording the rehearsal")
            records = _decide(staged, vctx, failures, last, kind, bp, segment)
            if kind != "rehearsal":
                _send(client, tcontent, records, summary)
            _store(tc, run_id, records)
            breaks = _reconcile(arts, source_rows, staged, records, bp, summary)
            _dq(summary, records, arts, disc_scores, segment)
    finally:
        wb.close()
    result_digest = digest(sorted((r["table"], r["key"], r["digest"], r["status"]) for r in records))
    counts = Counter(r["status"] for r in records)
    summary["counts"] = dict(counts)
    summary["repeat_of"] = ({"run": prev_same_info[0], "same_result": prev_same_info[1] == result_digest}
                            if prev_same_info else None)
    with session_scope() as s:
        r = s.get(LoadRun, run_id)
        assert r is not None
        for brk in breaks:
            s.add(ReconBreak(tenant_id=tenant_obj.id, project_id=project_id, origin="load", load_run_id=run_id,
                             owner_role="customer_data_owner", owner_user_id=owner, status="open", **brk))
        summary["breaks"] = len(breaks)
        failed = bool(summary["errors"]) and not records
        detail = "; ".join(f"{e['artifact']}: {e['error']}" for e in summary["errors"])[:2000] or None
        r.summary, r.result_digest = summary, result_digest
        r.status = "failed" if failed else "succeeded"
        r.status_detail, r.finished_at = detail, datetime.now(UTC)
        audit.record(s, ctx.actor, "load.run_finished", tenant_id=tenant_obj.id, project_id=project_id,
                     target_type="load_run", target_id=str(run_id),
                     details={"number": number, "kind": kind, "counts": dict(counts), "breaks": len(breaks),
                              "result_digest": result_digest, "repeat_of": summary["repeat_of"]})
    if failed:
        raise JobFailed(detail or "The transformation failed.")
    return {"number": number, "counts": dict(counts), "breaks": len(breaks)}


def _load_artifacts(tc: psycopg.Connection[Any], meta: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for m in meta:
        row = tc.execute("SELECT code, inputs FROM estate.build_code WHERE artifact_id = %s",
                         (uuid.UUID(m["id"]),)).fetchone()
        if row is None:
            raise LoadError(f"The code of {m['name']} is missing from the tenant database.")
        out.append({**m, "code": row[0], "inputs": row[1]})
    return out


def _extract(tc: psycopg.Connection[Any], extract_id: uuid.UUID, content: SourceAdapterContent | None,
             source_table: str) -> list[dict[str, Any]]:
    ent = next((e for e in (content.entities if content else []) if e.table.lower() == source_table.lower()), None)
    if ent is None:
        return []
    return [r[0] for r in tc.execute("SELECT row_data FROM estate.extract_rows WHERE run_id = %s AND entity = %s "
                                     "ORDER BY row_key", (extract_id, ent.name)).fetchall()]


def _segment(rows: list[dict[str, Any]], segment: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not segment:
        return rows
    col, values = str(segment["column"]).lower(), {str(v) for v in segment["values"]}
    out = []
    for r in rows:
        low = {k.lower(): v for k, v in r.items()}
        if col in low and str(low[col]) in values:
            out.append(r)
    return out


def _known(tc: psycopg.Connection[Any], earlier: list[str], kind: str) -> dict[str, set[str]]:
    if not earlier:
        return {}
    ok = list(ACCEPTED) if kind == "rehearsal" else ["loaded", "unchanged"]
    out: dict[str, set[str]] = {}
    for table, key in tc.execute("SELECT target_table, record_key FROM estate.load_records WHERE run_id = ANY(%s) "
                                 "AND status = ANY(%s)", ([uuid.UUID(x) for x in earlier], ok)).fetchall():
        out.setdefault(table, set()).add(key)
    return out


def _last_digests(tc: psycopg.Connection[Any], earlier: list[str]) -> dict[tuple[str, str], str]:
    if not earlier:
        return {}
    return {(t_, k): d for t_, k, d in tc.execute(
        "SELECT target_table, record_key, payload_digest FROM estate.load_records WHERE run_id = ANY(%s) "
        "AND status IN ('loaded', 'unchanged')", ([uuid.UUID(x) for x in earlier],)).fetchall()}


def _scores(tc: psycopg.Connection[Any], disc_id: uuid.UUID | None) -> dict[str, float]:
    if disc_id is None:
        return {}
    row = tc.execute("SELECT payload FROM estate.discovery_results WHERE run_id = %s AND section = 'profile'",
                     (disc_id,)).fetchone()
    return {str(x["table"]).lower(): float(x.get("score") or 0) for x in ((row[0] or {}).get("tables") or [])} \
        if row else {}


def _reload_rows(tc: psycopg.Connection[Any], run_id: uuid.UUID, keys: list[dict[str, str]]
                 ) -> dict[tuple[str, str], dict[str, Any]]:
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for k in keys:
        row = tc.execute("SELECT payload, fixed_payload FROM estate.load_records WHERE run_id = %s AND "
                         "target_table = %s AND record_key = %s",
                         (uuid.UUID(k["run_id"]), k["table"], k["key"])).fetchone()
        if row:
            out[(k["table"], k["key"])] = row[1] or row[0]
    return out


def _decide(staged: dict[str, list[dict[str, Any]]], vctx: validate.Context,
            failures: dict[tuple[str, str], list[validate.Failure]], last: dict[tuple[str, str], str], kind: str,
            bp: Blueprint | None, segment: dict[str, Any] | None) -> list[dict[str, Any]]:
    stop = bp.validation.blocking_rules_stop_load if bp else True
    seg_col = str(segment["column"]) if segment else None
    out = []
    for table, rows in staged.items():
        keys = vctx.keys.get(table) or [ROW]
        for n, row in enumerate(rows):
            key = str(n + 1) if keys == [ROW] else validate.record_key(row, keys)
            fs = failures.get((table, key), [])
            d = digest(row)
            blocking = any(f.severity == "blocking" for f in fs)
            if blocking and stop:
                status, reason = "invalid", "; ".join(f.message for f in fs if f.severity == "blocking")[:2000]
            elif kind == "rehearsal":
                status, reason = "rehearsed", None
            elif kind in ("delta", "load") and last.get((table, key)) == d:
                status, reason = "unchanged", "the same payload was loaded before"
            else:
                status, reason = "send", None
            out.append({"table": table, "key": key, "source_key": key, "payload": row, "digest": d,
                        "status": status, "reason": reason, "http": None,
                        "segment": str({k.lower(): v for k, v in row.items()}.get(seg_col.lower())) if seg_col
                        else None, "failures": [f.as_dict() for f in fs]})
    return out


def _send(client: TargetClient | None, tcontent: TargetAdapterContent | None, records: list[dict[str, Any]],
          summary: dict[str, Any]) -> None:
    by_table: dict[str, list[dict[str, Any]]] = {}
    for r in records:
        if r["status"] == "send":
            by_table.setdefault(r["table"], []).append(r)
    for table, recs in by_table.items():
        ep = next((e for e in (tcontent.load.endpoints if tcontent else []) if (e.table or "").lower() == table), None)
        if client is None or ep is None:
            why = ("No target connection." if client is None else
                   f"Blocked: the target adapter records no load endpoint for {table}.")
            for r in recs:
                r["status"], r["reason"] = "blocked", why
            summary.setdefault("blocked", {})[table] = why
            continue
        try:
            results = client.send(ep, [r["payload"] for r in recs], f"load:{table}"[:100])
        except TargetError as e:
            for r in recs:
                r["status"], r["reason"] = "blocked", str(e)
            summary.setdefault("blocked", {})[table] = str(e)
            continue
        for r, (outcome, http, reason) in zip(recs, results, strict=True):
            r["status"], r["http"], r["reason"] = outcome, http, reason


def _store(tc: psycopg.Connection[Any], run_id: uuid.UUID, records: list[dict[str, Any]]) -> None:
    with tc.transaction(), tc.cursor() as cur:
        for i in range(0, len(records), BATCH):
            cur.executemany(
                "INSERT INTO estate.load_records(run_id, target_table, record_key, source_key, segment, payload, "
                "payload_digest, status, http_status, reason, failures) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (run_id, target_table, record_key) DO NOTHING",
                [(run_id, r["table"], r["key"], r["source_key"], r["segment"], json.dumps(r["payload"], default=str),
                  r["digest"], r["status"], r["http"], r["reason"], json.dumps(r["failures"]))
                 for r in records[i:i + BATCH]])


def _measures(arts: list[dict[str, Any]], bp: Blueprint | None) -> list[tuple[str, str, str, str]]:
    """(target table lower, target column, source column, label)."""
    out = []
    for a in arts:
        inp = a["inputs"]
        tt = inp["target_table"].lower()
        tcols = {str(c["name"]).lower(): c for c in inp["target_columns"]}
        wanted = [x for x in (bp.validation.measures if bp else []) if x.table.lower() == tt]
        for m in inp["mappings"]:
            target = str(m["target"])
            if wanted:
                hit = next((x for x in wanted if x.column.lower() == target.lower()), None)
                if hit:
                    out.append((tt, target, str(m["source"]), hit.label or target))
                continue
            ttype = str((tcols.get(target.lower()) or {}).get("type", "")).lower()
            if family(ttype) == "numeric" and any(w in ttype for w in ("decimal", "numeric", "money")):
                out.append((tt, target, str(m["source"]), target))
    return out


def _sum(rows: list[dict[str, Any]], col: str) -> Decimal:
    total = Decimal(0)
    for r in rows:
        v = money({k.lower(): x for k, x in r.items()}.get(col.lower()))
        if v is not None:
            total += v
    return total


def _reconcile(arts: list[dict[str, Any]], source_rows: dict[str, list[dict[str, Any]]],
               staged: dict[str, list[dict[str, Any]]], records: list[dict[str, Any]], bp: Blueprint | None,
               summary: dict[str, Any]) -> list[dict[str, Any]]:
    breaks: list[dict[str, Any]] = []
    for a in arts:
        tt = a["inputs"]["target_table"].lower()
        recs = [r for r in records if r["table"] == tt]
        accepted = [r["payload"] for r in recs if r["status"] in ACCEPTED]
        src_n, tr_n = len(source_rows.get(tt, [])), len(staged.get(tt, []))
        summary["tables"][tt] = {"source": src_n, "transformed": tr_n, "accepted": len(accepted),
                                 **Counter(r["status"] for r in recs)}
        if source_rows.get(tt) is not None and src_n and src_n != tr_n:
            breaks.append({"scope": tt, "measure": "record count", "source_value": Decimal(src_n),
                           "target_value": Decimal(tr_n), "difference": Decimal(tr_n - src_n),
                           "detail": f"{src_n} source record(s) but {tr_n} transformed."})
        if tr_n != len(accepted):
            breaks.append({"scope": tt, "measure": "records accepted", "source_value": Decimal(tr_n),
                           "target_value": Decimal(len(accepted)), "difference": Decimal(len(accepted) - tr_n),
                           "detail": f"{tr_n - len(accepted)} record(s) were not accepted; see the error queue."})
    for tt, tcol, scol, label in _measures(arts, bp):
        src = _sum(source_rows.get(tt, []), scol) if source_rows.get(tt) else None
        tr = _sum(staged.get(tt, []), tcol)
        acc = _sum([r["payload"] for r in records if r["table"] == tt and r["status"] in ACCEPTED], tcol)
        summary["measures"].append({"table": tt, "column": tcol, "label": label,
                                    "source": str(src) if src is not None else None, "transformed": str(tr),
                                    "accepted": str(acc)})
        if src is not None and src != tr:
            breaks.append({"scope": tt, "measure": label, "source_value": src, "target_value": tr,
                           "difference": tr - src, "detail": f"The transformation changed the total of {label} "
                                                             f"from {src} to {tr}."})
        if tr != acc:
            breaks.append({"scope": tt, "measure": label, "source_value": tr, "target_value": acc,
                           "difference": acc - tr, "detail": f"{label}: {tr} transformed, {acc} accepted by the "
                                                             "target; the difference is in the error queue."})
    return breaks


def _dq(summary: dict[str, Any], records: list[dict[str, Any]], arts: list[dict[str, Any]],
        before: dict[str, float], segment: dict[str, Any] | None) -> None:
    """Score before (discovery's profile of the source table) and after (share of transformed records with no
    validation failure), per object and per segment."""
    for a in arts:
        st, tt = a["inputs"]["source_table"].lower(), a["inputs"]["target_table"].lower()
        recs = [r for r in records if r["table"] == tt]
        clean = sum(1 for r in recs if not r["failures"])
        after = round(100.0 * clean / len(recs), 1) if recs else None
        segs: dict[str, list[dict[str, Any]]] = {}
        for r in recs:
            segs.setdefault(str(r["segment"] or "all"), []).append(r)
        summary["dq"][tt] = {"source_table": st, "before": before.get(st), "after": after,
                             "segments": {k: round(100.0 * sum(1 for r in v if not r["failures"]) / len(v), 1)
                                          for k, v in segs.items()} if segment else {}}


# ------------------------------------------------------------------ error queue

def triage(tc: psycopg.Connection[Any], run_id: uuid.UUID, table: str, key: str, owner: str | None,
           triage_status: str | None, fixed_payload: dict[str, Any] | None, note: str | None) -> None:
    row = tc.execute("SELECT status, payload FROM estate.load_records WHERE run_id = %s AND target_table = %s AND "
                     "record_key = %s", (run_id, table, key)).fetchone()
    if row is None:
        raise LoadError("No such record.")
    if row[0] in ACCEPTED:
        raise LoadError("The record was accepted; only failed records are in the error queue.")
    if fixed_payload is not None and set(fixed_payload) - set(row[1]):
        raise LoadError("A fixed record keeps the same columns as the original.")
    tc.execute("UPDATE estate.load_records SET owner = COALESCE(%s, owner), triage = COALESCE(%s, triage), "
               "fixed_payload = COALESCE(%s, fixed_payload), note = COALESCE(%s, note) WHERE run_id = %s AND "
               "target_table = %s AND record_key = %s",
               (owner, triage_status, json.dumps(fixed_payload, default=str) if fixed_payload is not None else None,
                note, run_id, table, key))

