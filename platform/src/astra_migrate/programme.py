"""Installed-base programmes (E18): access across partners, the consented fleet scan, the Migration Complexity
Index, the portfolio planner, the programme owner's view and commercial metering.

**Partners never see each other's customers.** Every programme read goes through `visible_partners`: a programme
or platform grant sees every customer; a partner grant sees only that partner's customers. The programme view and
metering hold only aggregates (counts, scores, gate dates); no customer element name or business value crosses a
tenant boundary.

**Fleet scan.** Through a checked, read-only source connection, it reads only metadata (object inventory, data
dictionary, configuration inventory) and counts (rows per entity, documents), plus how many of the adapter's known
traps apply. It never reads business values, and it keeps only numbers.

**Migration Complexity Index.** Each measure is normalised to 0..1 between a low and a high reference value and
weighted; the index is 100 times the weighted sum. Bands: simple below 35, medium below 65, complex from 65. A programme
can change weights, ranges and band limits; every score shows its measures, weights and contributions.
"""

from __future__ import annotations

import math
import uuid
from datetime import UTC, date, datetime
from typing import Any

from ortools.sat.python import cp_model
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters import source
from astra_migrate.adapters.contract import SourceAdapterContent
from astra_migrate.adapters.engines import EngineError, EngineUnavailable, open_session
from astra_migrate.adapters.jobs import adapter_pack, all_traps, content_of, params_for
from astra_migrate.connector_secrets import SecretError
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import (
    FleetScan,
    Gap,
    GateApproval,
    GatePass,
    LoadRun,
    Partner,
    Pod,
    PortfolioPlan,
    Programme,
    ProgrammeWave,
    Project,
    ReconBreak,
    SourceConnection,
    Tenant,
    User,
)
from astra_migrate.discovery.configuration import read_configuration
from astra_migrate.discovery.dictionary import harvest
from astra_migrate.gates import GATE_KEYS
from astra_migrate.jobs.runner import JobContext, JobFailed, actor_dict, enqueue, handler
from astra_migrate.security.rbac import ROLES, P
from astra_migrate.tenancy.service import tenant_connection
from astra_migrate.vault import get_vault

# key, label, weight, low, high
MEASURES: list[tuple[str, str, float, float, float]] = [
    ("tables", "Tables", 0.10, 50, 1500),
    ("columns", "Columns", 0.05, 500, 30000),
    ("custom_tables", "Customer-specific tables", 0.15, 0, 100),
    ("code_objects", "Code objects", 0.15, 0, 800),
    ("code_lines", "Lines of code", 0.10, 0, 200000),
    ("interfaces", "Interface objects", 0.15, 0, 60),
    ("configuration_items", "Configuration items", 0.10, 0, 3000),
    ("data_volume_log10", "Data volume (log10 of rows)", 0.10, 4, 9),
    ("documents_log10", "Documents (log10)", 0.05, 2, 7),
    ("traps", "Known traps that apply", 0.05, 0, 20),
]
BANDS = {"simple": 35.0, "medium": 65.0}


class ProgrammeError(Exception):
    def __init__(self, status: int, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.status, self.field = status, field


# ------------------------------------------------------------------ access

def visible_partners(principal: Any, s: Session, programme_id: uuid.UUID, perm: P) -> set[uuid.UUID] | None:
    """None = every customer of the programme; a set = only those partners' customers. Raises when neither."""
    if principal.has_platform(perm):
        return None
    for g in principal.grants:
        if g.scope_type == "programme" and g.scope_id == programme_id and perm in ROLES[g.role].permissions:
            return None
    partners = {p.id for p in s.scalars(select(Partner).where(Partner.programme_id == programme_id))}
    mine = {g.scope_id for g in principal.grants
            if g.scope_type == "partner" and g.scope_id in partners and perm in ROLES[g.role].permissions}
    if not mine:
        raise ProgrammeError(403, "You have no access to this programme.")
    return {x for x in mine if x is not None}


def customers(s: Session, programme_id: uuid.UUID, partners: set[uuid.UUID] | None) -> list[Tenant]:
    stmt = select(Tenant).where(Tenant.programme_id == programme_id, Tenant.status.in_(("active", "migrating")))
    if partners is not None:
        stmt = stmt.where(Tenant.partner_id.in_(partners))
    return list(s.scalars(stmt.order_by(Tenant.name)))


# ------------------------------------------------------------------ complexity index (E18.F2.S2)

def config_of(prog: Programme) -> dict[str, Any]:
    c = prog.mci_config or {}
    weights = {k: float(c.get("weights", {}).get(k, w)) for k, _l, w, _lo, _hi in MEASURES}
    ranges = {k: tuple(c.get("ranges", {}).get(k, (lo, hi))) for k, _l, _w, lo, hi in MEASURES}
    bands = {**BANDS, **{k: float(v) for k, v in (c.get("bands") or {}).items()}}
    return {"weights": weights, "ranges": ranges, "bands": bands}


def validate_config(raw: dict[str, Any]) -> dict[str, Any]:
    keys = {k for k, *_ in MEASURES}
    w = raw.get("weights") or {}
    if set(w) - keys or set(raw.get("ranges") or {}) - keys:
        raise ProgrammeError(422, f"Measures are: {', '.join(sorted(keys))}.", "mci_config")
    merged = {k: float(w.get(k, dw)) for k, _l, dw, _lo, _hi in MEASURES}
    if any(v < 0 for v in merged.values()) or abs(sum(merged.values()) - 1.0) > 1e-6:
        raise ProgrammeError(422, "Weights are 0 or more and add up to 1.", "mci_config.weights")
    for k, (lo, hi) in (raw.get("ranges") or {}).items():
        if not float(lo) < float(hi):
            raise ProgrammeError(422, f"The range of {k} needs low < high.", "mci_config.ranges")
    b = {**BANDS, **(raw.get("bands") or {})}
    if set(b) != set(BANDS) or not 0 < float(b["simple"]) < float(b["medium"]) < 100:
        raise ProgrammeError(422, "Band limits: 0 < simple < medium < 100.", "mci_config.bands")
    return {"weights": w, "ranges": raw.get("ranges") or {}, "bands": raw.get("bands") or {}}


def mci(measures: dict[str, float], prog: Programme) -> dict[str, Any]:
    cfg = config_of(prog)
    rows, total = [], 0.0
    for key, label, _w, _lo, _hi in MEASURES:
        lo, hi = cfg["ranges"][key]
        v = float(measures.get(key, 0) or 0)
        n = min(1.0, max(0.0, (v - lo) / (hi - lo)))
        c = cfg["weights"][key] * n
        total += c
        rows.append({"key": key, "label": label, "value": round(v, 2), "low": lo, "high": hi,
                     "normalised": round(n, 4), "weight": cfg["weights"][key], "contribution": round(100 * c, 2)})
    score = round(100 * total, 1)
    band = "simple" if score < cfg["bands"]["simple"] else "medium" if score < cfg["bands"]["medium"] else "complex"
    return {"score": score, "band": band, "measures": rows, "bands": cfg["bands"],
            "formula": "100 × Σ weight × clamp((value − low) / (high − low), 0, 1)"}


# ------------------------------------------------------------------ fleet scan (E18.F2.S1)

def measure(sess: Any, content: SourceAdapterContent, traps: list[Any]) -> dict[str, float]:
    meta = source.read_metadata(sess, content)
    dd = harvest(sess, content)
    cfg = read_configuration(sess, content)
    code_types = {o.key for o in content.object_types if o.code}
    interface_types = {o.key for o in content.object_types if o.interface}
    code = [o for o in meta.objects if o.type in code_types]
    rows = 0
    for e in content.entities:
        try:
            rows += source.count_rows(sess, e)
        except EngineError:
            continue
    docs = 0
    if content.documents is not None:
        try:
            docs = int(sess.query(f"SELECT COUNT(*) AS n FROM {source._table(sess, content.documents.table)}")[0]
                       ["n"])
        except EngineError:
            docs = 0
    findings, _errors = source.evaluate_traps(sess, traps, meta)
    return {"tables": float(len(dd.tables())), "columns": float(len(dd.columns)),
            "custom_tables": float(sum(1 for o in meta.objects if o.type == "user_defined_table")),
            "code_objects": float(len(code)),
            "code_lines": float(sum(len((o.definition or "").splitlines()) for o in code)),
            "interfaces": float(sum(1 for o in meta.objects if o.type in interface_types)),
            "configuration_items": float(len(cfg.items)),
            "data_volume_log10": round(math.log10(rows + 1), 3), "rows": float(rows),
            "documents_log10": round(math.log10(docs + 1), 3), "documents": float(docs),
            "traps": float(len(findings))}


@handler("fleet.scan")
def run_scan(ctx: JobContext) -> dict[str, Any]:
    scan_id = uuid.UUID(ctx.payload["scan_id"])
    with session_scope() as s:
        sc = s.get(FleetScan, scan_id)
        if sc is None:
            raise JobFailed("The scan no longer exists.")
        conn, t, prog = s.get(SourceConnection, sc.connection_id), s.get(Tenant, sc.tenant_id), s.get(
            Programme, sc.programme_id)
        if conn is None or t is None or prog is None:
            raise JobFailed("The connection, customer or programme no longer exists.")
        pack = adapter_pack(s, conn.adapter)
        content = content_of(pack)
        if not isinstance(content, SourceAdapterContent):
            raise JobFailed("The connection's adapter is not a source adapter.")
        try:
            params = params_for(s, conn, t)
        except SecretError as e:
            sc.status, sc.status_detail, sc.finished_at = "failed", str(e), datetime.now(UTC)
            raise JobFailed(str(e)) from e
        traps = all_traps(s, pack, content)
        sc.status = "running"
        engine = conn.engine
    try:
        sess = open_session(engine, params)
    except (EngineUnavailable, EngineError) as e:
        with session_scope() as s:
            sc2 = s.get(FleetScan, scan_id)
            if sc2 is not None:
                sc2.status = "blocked" if isinstance(e, EngineUnavailable) else "failed"
                sc2.status_detail, sc2.finished_at = str(e), datetime.now(UTC)
        raise JobFailed(str(e)) from e
    try:
        ctx.progress(20, "Reading metadata and counts")
        m = measure(sess, content, traps)
    finally:
        sess.close()
    with session_scope() as s:
        sc2 = s.get(FleetScan, scan_id)
        prog2 = s.get(Programme, sc2.programme_id) if sc2 else None
        assert sc2 is not None and prog2 is not None
        index = mci(m, prog2)
        sc2.measures, sc2.mci, sc2.status, sc2.finished_at = m, index, "succeeded", datetime.now(UTC)
        audit.record(s, ctx.actor, "fleet.scan_finished", tenant_id=sc2.tenant_id, target_type="fleet_scan",
                     target_id=str(scan_id), details={"measures": m, "score": index["score"], "band": index["band"]})
    return {"score": index["score"], "band": index["band"]}


def start_scan(s: Session, t: Tenant, conn: SourceConnection, consent_id: uuid.UUID, actor: audit.Actor
               ) -> FleetScan:
    assert t.programme_id is not None
    sc = FleetScan(tenant_id=t.id, programme_id=t.programme_id, connection_id=conn.id, consent_id=consent_id,
                   status="queued", measures={}, requested_by=actor_dict(actor))
    s.add(sc)
    s.flush()
    job = enqueue(s, "fleet.scan", f"Light scan of {t.name}", actor, {"scan_id": str(sc.id)}, tenant_id=t.id)
    sc.job_id = job.id
    audit.record(s, actor, "fleet.scan_requested", tenant_id=t.id, target_type="fleet_scan", target_id=str(sc.id),
                 details={"connection": conn.name, "consent": str(consent_id)})
    return sc


def latest_scan(s: Session, tenant_id: uuid.UUID) -> FleetScan | None:
    return s.scalars(select(FleetScan).where(FleetScan.tenant_id == tenant_id, FleetScan.status == "succeeded")
                     .order_by(FleetScan.created_at.desc())).first()


# ------------------------------------------------------------------ portfolio planner (E18.F3.S1)

def plan(s: Session, prog: Programme) -> dict[str, Any]:
    """Assign every customer to one programme wave and one pod of its partner. A customer's band sets how many
    weeks it needs; a wave can hold it only if the wave is that long. A pod migrates at most `capacity` customers
    in a wave. Customers that cannot be placed are reported with the reason; earlier waves are preferred."""
    waves = list(s.scalars(select(ProgrammeWave).where(ProgrammeWave.programme_id == prog.id)
                           .order_by(ProgrammeWave.start_date, ProgrammeWave.key)))
    partners = list(s.scalars(select(Partner).where(Partner.programme_id == prog.id)))
    pods = {p.id: list(s.scalars(select(Pod).where(Pod.partner_id == p.id).order_by(Pod.name))) for p in partners}
    weeks = {k: float(v) for k, v in (prog.band_effort_weeks or {}).items()}
    conflicts: list[dict[str, Any]] = []
    eligible: list[tuple[Tenant, str, float]] = []
    for t in customers(s, prog.id, None):
        sc = latest_scan(s, t.id)
        if t.partner_id is None:
            conflicts.append({"customer_id": str(t.id), "customer": t.name, "reason": "No partner is assigned."})
        elif not pods.get(t.partner_id):
            conflicts.append({"customer_id": str(t.id), "customer": t.name, "reason": "The partner has no pods."})
        elif sc is None or not sc.mci:
            conflicts.append({"customer_id": str(t.id), "customer": t.name,
                              "reason": "No complexity band yet: run a consented light scan first."})
        else:
            band = str(sc.mci["band"])
            eligible.append((t, band, weeks.get(band, 26.0)))
    if not waves:
        return {"assignments": [], "conflicts": [*conflicts, {"customer_id": None, "customer": None,
                                                              "reason": "The programme has no waves."}],
                "pods": [], "status": "no_waves"}
    m = cp_model.CpModel()
    x: dict[tuple[int, int, uuid.UUID], cp_model.IntVar] = {}
    unplaced = {}
    for ci, (t, _band, need) in enumerate(eligible):
        assert t.partner_id is not None
        for wi, w in enumerate(waves):
            if (w.end_date - w.start_date).days / 7 + 1e-9 < need:
                continue
            for pod in pods[t.partner_id]:
                x[(ci, wi, pod.id)] = m.new_bool_var(f"x{ci}_{wi}_{pod.id.hex[:6]}")
        unplaced[ci] = m.new_bool_var(f"u{ci}")
        m.add(sum(v for (c, _w, _p), v in x.items() if c == ci) + unplaced[ci] == 1)
    for plist in pods.values():
        for pod in plist:
            for wi in range(len(waves)):
                m.add(sum(v for (_c, w, p), v in x.items() if w == wi and p == pod.id) <= pod.capacity)
    m.minimize(1000 * sum(unplaced.values()) + sum((wi + 1) * v for (_c, wi, _p), v in x.items()))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 20
    solver.parameters.num_workers = 4
    status = solver.solve(m)
    assignments = []
    pod_by_id = {p.id: p for plist in pods.values() for p in plist}
    for ci, (t, band, need) in enumerate(eligible):
        hit = next(((wi, pid) for (c, wi, pid), v in x.items() if c == ci and solver.value(v)), None)
        if hit is None:
            fits = any(c == ci for (c, _w, _p) in x)
            conflicts.append({"customer_id": str(t.id), "customer": t.name, "band": band,
                              "reason": (f"No wave is long enough for a {band} customer ({need:g} weeks)." if not fits
                                         else "Every pod of its partner is full in every long-enough wave: add pod "
                                              "capacity or a wave.")})
            continue
        wi, pid = hit
        assignments.append({"customer_id": str(t.id), "customer": t.name, "partner_id": str(t.partner_id),
                            "segment": t.segment, "band": band, "weeks": need, "wave": waves[wi].key,
                            "pod_id": str(pid), "pod": pod_by_id[pid].name})
    rotation = []
    for pid, pod in pod_by_id.items():
        seq = [{"wave": w.key, "customers": [a["customer"] for a in assignments
                                              if a["pod_id"] == str(pid) and a["wave"] == w.key]} for w in waves]
        rotation.append({"pod_id": str(pid), "pod": pod.name, "partner_id": str(pod.partner_id),
                         "capacity": pod.capacity, "waves": seq})
    return {"status": solver.status_name(status).lower(), "assignments": assignments, "conflicts": conflicts,
            "pods": rotation, "waves": [{"key": w.key, "name": w.name, "start": w.start_date.isoformat(),
                                         "end": w.end_date.isoformat()} for w in waves]}


# ------------------------------------------------------------------ programme view (E18.F3.S2) and metering (S4.F4)

def _tenant_figures(t: Tenant, project_ids: list[uuid.UUID]) -> dict[str, Any]:
    """Counts read from the customer's own database; nothing but numbers leaves it."""
    out = {"open_risks": 0, "actual_hours": 0.0}
    if not project_ids:
        return out
    try:
        with tenant_connection(t, get_vault()) as tc:
            r = tc.execute("SELECT count(*) FROM estate.plan_items WHERE project_id = ANY(%s) AND kind = 'risk' "
                           "AND body->>'status' IN ('proposed', 'accepted')", (project_ids,)).fetchone()
            h = tc.execute("SELECT coalesce(sum(hours), 0) FROM estate.plan_actuals WHERE project_id = ANY(%s)",
                           (project_ids,)).fetchone()
        out["open_risks"] = int(r[0]) if r else 0
        out["actual_hours"] = float(h[0]) if h else 0.0
    except Exception:  # an unreachable customer database must not hide the rest of the programme
        out["unavailable"] = True
    return out


def view(s: Session, prog: Programme, partners: set[uuid.UUID] | None) -> dict[str, Any]:
    names = {p.id: p.name for p in s.scalars(select(Partner).where(Partner.programme_id == prog.id))}
    rows = []
    for t in customers(s, prog.id, partners):
        projects = list(s.scalars(select(Project).where(Project.tenant_id == t.id)))
        pids = [p.id for p in projects]
        passed = {(g.project_id, g.gate) for g in s.scalars(select(GatePass).where(GatePass.project_id.in_(pids)))}
        gates = []
        for p in projects:
            done = [k for k in GATE_KEYS if (p.id, k) in passed]
            nxt = next((k for k in GATE_KEYS if (p.id, k) not in passed), None)
            gates.append({"project": p.name, "project_id": str(p.id), "passed": len(done), "of": len(GATE_KEYS),
                          "next_gate": nxt})
        sc = latest_scan(s, t.id)
        gaps = s.scalar(select(Gap.id).where(Gap.tenant_id == t.id).limit(1))
        open_gaps = len(list(s.scalars(select(Gap.id).where(Gap.tenant_id == t.id, Gap.status == "open",
                                                            Gap.route == "vendor_product_change"))))
        breaks = len(list(s.scalars(select(ReconBreak.id).where(ReconBreak.project_id.in_(pids),
                                                                ReconBreak.status == "open"))))
        last_load = s.scalars(select(LoadRun).where(LoadRun.project_id.in_(pids), LoadRun.status == "succeeded")
                              .order_by(LoadRun.created_at.desc())).first()
        rows.append({"customer_id": str(t.id), "customer": t.name, "partner_id": str(t.partner_id)
                     if t.partner_id else None, "partner": names.get(t.partner_id) if t.partner_id else None,
                     "segment": t.segment, "band": sc.mci["band"] if sc and sc.mci else None,
                     "score": sc.mci["score"] if sc and sc.mci else None,
                     "scanned_at": sc.finished_at.isoformat() if sc and sc.finished_at else None,
                     "gates": gates, "open_vendor_gaps": open_gaps, "has_gaps": gaps is not None,
                     "open_breaks": breaks,
                     "last_load": {"number": last_load.number, "kind": last_load.kind,
                                   "counts": (last_load.summary or {}).get("counts")} if last_load else None,
                     **_tenant_figures(t, pids)})
    bands: dict[str, int] = {}
    for r in rows:
        bands[r["band"] or "not scanned"] = bands.get(r["band"] or "not scanned", 0) + 1
    return {"programme": {"id": str(prog.id), "name": prog.name}, "customers": rows,
            "totals": {"customers": len(rows), "bands": bands,
                       "open_vendor_gaps": sum(r["open_vendor_gaps"] for r in rows),
                       "open_breaks": sum(r["open_breaks"] for r in rows),
                       "open_risks": sum(r["open_risks"] for r in rows)},
            "scope": "programme" if partners is None else "partner"}


def metering(s: Session, prog: Programme, partners: set[uuid.UUID] | None) -> dict[str, Any]:
    latest_plan = s.scalars(select(PortfolioPlan).where(PortfolioPlan.programme_id == prog.id)
                            .order_by(PortfolioPlan.number.desc())).first()
    wave_of = {a["customer_id"]: a["wave"] for a in (latest_plan.result.get("assignments") or [])} \
        if latest_plan else {}
    rows, evidence = [], []
    for t in customers(s, prog.id, partners):
        projects = list(s.scalars(select(Project).where(Project.tenant_id == t.id)))
        pids = [p.id for p in projects]
        sc = latest_scan(s, t.id)
        fig = _tenant_figures(t, pids)
        passes = list(s.scalars(select(GatePass).where(GatePass.project_id.in_(pids)).order_by(GatePass.created_at)))
        for gp in passes:
            appr = list(s.scalars(select(GateApproval).where(GateApproval.project_id == gp.project_id,
                                                             GateApproval.gate == gp.gate,
                                                             GateApproval.checklist_digest == gp.checklist_digest)))
            evidence.append({"customer_id": str(t.id), "customer": t.name, "segment": t.segment,
                             "project": next((p.name for p in projects if p.id == gp.project_id), None),
                             "gate": gp.gate, "label": (gp.checklist or {}).get("label") or gp.gate,
                             "passed_at": gp.created_at.isoformat() if gp.created_at else None,
                             "approvers": "; ".join(f"{_who(s, a.user_id)} ({a.role})" for a in appr),
                             "checklist_digest": gp.checklist_digest,
                             "band": sc.mci["band"] if sc and sc.mci else None})
        start = min((p.created_at for p in projects if p.created_at), default=None)
        end = max((gp.created_at for gp in passes if gp.created_at), default=None)
        elapsed = ((end or datetime.now(UTC)) - start).days if start else None
        rows.append({"customer_id": str(t.id), "customer": t.name, "segment": t.segment,
                     "partner_id": str(t.partner_id) if t.partner_id else None,
                     "band": sc.mci["band"] if sc and sc.mci else None, "score": sc.mci["score"] if sc and sc.mci
                     else None, "gates_passed": len(passes), "effort_hours": fig.get("actual_hours", 0.0),
                     "elapsed_days": elapsed, "wave": wave_of.get(str(t.id))})
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for r in rows:
        groups.setdefault((r["segment"] or "(no segment)", r["wave"] or "(unplanned)"), []).append(r)
    comparison = [{"segment": seg, "wave": wave, "customers": len(v),
                   "effort_hours": round(sum(x["effort_hours"] for x in v), 1),
                   "hours_per_customer": round(sum(x["effort_hours"] for x in v) / len(v), 1),
                   "hours_per_score_point": round(sum(x["effort_hours"] for x in v)
                                                  / max(1.0, sum(x["score"] or 0 for x in v)), 2)}
                  for (seg, wave), v in sorted(groups.items())]
    return {"customers": rows, "gate_evidence": evidence, "segment_waves": comparison,
            "plan_number": latest_plan.number if latest_plan else None}


def _who(s: Session, uid: uuid.UUID) -> str:
    u = s.get(User, uid)
    return u.display_name if u else "unknown"


def today() -> date:
    return datetime.now(UTC).date()
