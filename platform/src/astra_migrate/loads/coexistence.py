"""Daily reconciliation while both systems run (E15.F1.S2).

For every shared entity in the plan's coexistence rules, the source is read now (read-only, through its adapter):
record count and the sum of every reconciled amount. That is compared with what the target accepted in loads so
far (the latest accepted payload of each record). A difference means the source changed and was not yet moved, or a
load lost records; each one is a break owned by the schedule's named owner. An open break for the same entity and
measure is updated rather than repeated, so the coexistence dashboard shows one row per open problem.

The scheduler runs inside the API process: every few minutes it enqueues the reconciliation for schedules that are
due (each schedule runs once a day at its hour, UTC).
"""

from __future__ import annotations

import logging
import threading
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select

from astra_migrate import audit
from astra_migrate.adapters import source
from astra_migrate.adapters.contract import SourceAdapterContent
from astra_migrate.adapters.engines import EngineError, EngineUnavailable, open_session
from astra_migrate.adapters.jobs import adapter_pack, content_of, params_for
from astra_migrate.connector_secrets import SecretError
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import (
    BuildArtifact,
    CoexistenceSchedule,
    LoadRun,
    Project,
    ReconBreak,
    SourceConnection,
    Tenant,
)
from astra_migrate.jobs.runner import JobContext, JobFailed, enqueue, handler
from astra_migrate.loads.engine import approved_blueprint, money
from astra_migrate.tenancy.service import tenant_connection
from astra_migrate.vault import get_vault

log = logging.getLogger(__name__)
TICK_SECONDS = 300


def next_run(hour: int, after: datetime) -> datetime:
    at = after.replace(hour=hour, minute=0, second=0, microsecond=0)
    return at if at > after else at + timedelta(days=1)


@handler("coexistence.reconcile")
def reconcile(ctx: JobContext) -> dict[str, Any]:
    project_id = uuid.UUID(ctx.payload["project_id"])
    with session_scope() as s:
        sch = s.get(CoexistenceSchedule, project_id)
        p = s.get(Project, project_id)
        if sch is None or p is None:
            raise JobFailed("The schedule or project no longer exists.")
        t = s.get(Tenant, p.tenant_id)
        conn = s.get(SourceConnection, sch.connection_id)
        if t is None or conn is None:
            raise JobFailed("The tenant or connection no longer exists.")
        content = content_of(adapter_pack(s, conn.adapter))
        if not isinstance(content, SourceAdapterContent):
            raise JobFailed("The connection's adapter is not a source adapter.")
        try:
            params = params_for(s, conn, t)
        except SecretError as e:
            raise JobFailed(f"The connection's password reference cannot be read: {e}") from e
        bp = approved_blueprint(s, project_id)
        arts = [a for a in s.scalars(select(BuildArtifact).where(BuildArtifact.project_id == project_id,
                                                                 BuildArtifact.kind == "transformation",
                                                                 BuildArtifact.status == "approved"))]
        runs = [r.id for r in s.scalars(select(LoadRun).where(LoadRun.project_id == project_id,
                                                              LoadRun.kind != "rehearsal",
                                                              LoadRun.status == "succeeded"))]
        owner, engine = sch.owner_user_id, conn.engine
        s.expunge(t)
    with tenant_connection(t, get_vault()) as tc:
        rules = [b for (b,) in tc.execute("SELECT body FROM estate.plan_items WHERE project_id = %s AND "
                                          "kind = 'coexistence'", (project_id,)).fetchall()]
        code = {str(a.id): row for a in arts
                if (row := tc.execute("SELECT inputs FROM estate.build_code WHERE artifact_id = %s",
                                      (a.id,)).fetchone())}
        latest: dict[tuple[str, str], dict[str, Any]] = {}
        if runs:
            for table, key, payload in tc.execute(
                    "SELECT DISTINCT ON (target_table, record_key) target_table, record_key, payload FROM "
                    "estate.load_records r JOIN unnest(%s::uuid[]) WITH ORDINALITY AS o(id, n) ON o.id = r.run_id "
                    "WHERE r.status = ANY(%s) ORDER BY target_table, record_key, o.n DESC",
                    (runs, ["loaded", "unchanged"])).fetchall():
                latest[(table, key)] = payload
    entities = {e.name: e for e in content.entities}
    shared = sorted({str(r.get("entity")) for r in rules if r.get("entity") in entities})
    measures = {m.column.lower(): m for m in (bp.validation.measures if bp else [])}
    findings: list[dict[str, Any]] = []
    try:
        sess = open_session(engine, params)
    except (EngineUnavailable, EngineError) as e:
        raise JobFailed(str(e)) from e
    try:
        for name in shared:
            ent = entities[name]
            inp = next((row[0] for row in code.values() if row[0]["source_table"].lower() == ent.table.lower()),
                       None)
            if inp is None:
                findings.append({"scope": name, "measure": "transformation", "source": None, "target": None,
                                 "detail": f"No approved transformation moves {name}; it cannot be reconciled."})
                continue
            tt = inp["target_table"].lower()
            pairs = [(m["source"], m["target"]) for m in inp["mappings"]
                     if m["target"].lower() in measures or (not measures and _money(inp, m["target"]))]
            sums = ", ".join(f"SUM({sess.quote(sc)}) AS {sess.quote('m_' + str(i))}"
                             for i, (sc, _t) in enumerate(pairs))
            sql = f"SELECT COUNT(*) AS n{', ' + sums if sums else ''} FROM {source._table(sess, ent.table)}"
            row = sess.query(sql)[0]
            accepted = [p for (tab, _k), p in latest.items() if tab == tt]
            src_n, tgt_n = int(row["n"]), len(accepted)
            if src_n != tgt_n:
                findings.append({"scope": name, "measure": "record count", "source": Decimal(src_n),
                                 "target": Decimal(tgt_n),
                                 "detail": f"The source has {src_n} {name} record(s); the target accepted {tgt_n}."})
            for i, (_sc, tcol) in enumerate(pairs):
                sv = money(row.get(f"m_{i}")) or Decimal("0.00")
                tv = sum((money({k.lower(): v for k, v in p.items()}.get(tcol.lower())) or Decimal(0)
                          for p in accepted), Decimal("0.00"))
                if sv != tv:
                    findings.append({"scope": name, "measure": tcol, "source": sv, "target": tv,
                                     "detail": f"{tcol}: {sv} at source, {tv} accepted by the target."})
    finally:
        sess.close()
    opened = updated = 0
    with session_scope() as s:
        for f in findings:
            old = s.scalars(select(ReconBreak).where(ReconBreak.project_id == project_id,
                                                     ReconBreak.origin == "coexistence", ReconBreak.status == "open",
                                                     ReconBreak.scope == f["scope"],
                                                     ReconBreak.measure == f["measure"])).first()
            diff = (f["target"] - f["source"]) if f["source"] is not None and f["target"] is not None else None
            if old is not None:
                old.source_value, old.target_value, old.difference, old.detail = (f["source"], f["target"], diff,
                                                                                  f["detail"])
                updated += 1
            else:
                s.add(ReconBreak(tenant_id=t.id, project_id=project_id, origin="coexistence", scope=f["scope"],
                                 measure=f["measure"], source_value=f["source"], target_value=f["target"],
                                 difference=diff, detail=f["detail"], owner_role="customer_data_owner",
                                 owner_user_id=owner, status="open"))
                opened += 1
        sch = s.get(CoexistenceSchedule, project_id)
        if sch is not None:
            sch.last_run_at = datetime.now(UTC)
        audit.record(s, ctx.actor, "coexistence.reconciled", tenant_id=t.id, project_id=project_id,
                     target_type="project", target_id=str(project_id),
                     details={"entities": shared, "opened": opened, "updated": updated,
                              "differences": len(findings)})
    return {"entities": shared, "differences": len(findings), "opened": opened, "updated": updated}


def _money(inp: dict[str, Any], target: str) -> bool:
    col = next((c for c in inp["target_columns"] if str(c["name"]).lower() == target.lower()), None)
    t = str((col or {}).get("type", "")).lower()
    return any(w in t for w in ("decimal", "numeric", "money"))


def tick() -> int:
    """Enqueue the reconciliation for every schedule that is due. Returns how many were enqueued."""
    now = datetime.now(UTC)
    n = 0
    with session_scope() as s:
        due = list(s.scalars(select(CoexistenceSchedule).where(CoexistenceSchedule.enabled.is_(True),
                                                               CoexistenceSchedule.next_run_at <= now)
                             .with_for_update(skip_locked=True)))
        for sch in due:
            p = s.get(Project, sch.project_id)
            if p is None:
                continue
            enqueue(s, "coexistence.reconcile", f"Daily coexistence reconciliation for {p.name}",
                    audit.Actor.system("scheduler"), {"project_id": str(sch.project_id)}, tenant_id=sch.tenant_id,
                    project_id=sch.project_id)
            sch.next_run_at = next_run(sch.hour_utc, now)
            n += 1
    return n


class Scheduler(threading.Thread):
    def __init__(self) -> None:
        super().__init__(name="astra-scheduler", daemon=True)
        self.stopping = threading.Event()

    def run(self) -> None:
        while not self.stopping.is_set():
            try:
                tick()
            except Exception:  # keep the scheduler alive; the error is logged
                log.exception("scheduler tick failed")
            self.stopping.wait(TICK_SECONDS)

    def stop(self) -> None:
        self.stopping.set()
