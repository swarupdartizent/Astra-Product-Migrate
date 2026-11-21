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
    BandContract,
    FleetScan,
    Gap,
    GateApproval,
    GatePass,
    LoadRun,
    MciWeightVersion,
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
    return config_from(prog.mci_config or {})


def config_from(c: dict[str, Any]) -> dict[str, Any]:
    """Weights, ranges and band limits with defaults filled in."""
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


# ------------------------------------------------------------------ weights versions and recalibration (E18.F2.S3)

MIN_RECALIBRATION_SAMPLES = 3
PRIOR_STRENGTH = float(len(MEASURES))  # a fit from n customers moves the weights by n / (n + 10)


def versions(s: Session, prog: Programme) -> list[MciWeightVersion]:
    return list(s.scalars(select(MciWeightVersion).where(MciWeightVersion.programme_id == prog.id)
                          .order_by(MciWeightVersion.number)))


def current_version(s: Session, prog: Programme) -> int | None:
    return s.scalar(select(MciWeightVersion.number).where(MciWeightVersion.programme_id == prog.id)
                    .order_by(MciWeightVersion.number.desc()).limit(1))


def ensure_versions(s: Session, prog: Programme, user_id: uuid.UUID) -> int:
    """Record the starting weights as version 1 before the first change, so every version is kept."""
    n = current_version(s, prog)
    if n is not None:
        return n
    cfg = config_of(prog)
    s.add(MciWeightVersion(programme_id=prog.id, number=1, weights=cfg["weights"],
                           ranges={k: list(v) for k, v in cfg["ranges"].items()}, bands=cfg["bands"],
                           source="starting", basis={}, created_by=user_id,
                           reason="The programme's starting assumptions, recorded before the first change."))
    s.flush()
    return 1


def record_version(s: Session, prog: Programme, user_id: uuid.UUID, source: str, reason: str,
                   after_wave: str | None = None, basis: dict[str, Any] | None = None) -> MciWeightVersion:
    number = (current_version(s, prog) or 0) + 1
    cfg = config_of(prog)
    v = MciWeightVersion(programme_id=prog.id, number=number, weights=cfg["weights"],
                         ranges={k: list(r) for k, r in cfg["ranges"].items()}, bands=cfg["bands"], source=source,
                         after_wave=after_wave, basis=basis or {}, reason=reason, created_by=user_id)
    s.add(v)
    s.flush()
    return v


def contract_of(s: Session, tenant_id: uuid.UUID) -> BandContract | None:
    return s.scalar(select(BandContract).where(BandContract.tenant_id == tenant_id))


def band_of(s: Session, prog: Programme, tenant_id: uuid.UUID, sc: FleetScan | None) -> dict[str, Any] | None:
    """A customer's band: the contracted one when there is a contract (it never changes), otherwise the latest
    scan scored with the programme's current weights."""
    c = contract_of(s, tenant_id)
    if c is not None:
        return {"band": c.band, "score": float(c.score), "contracted": True, "weights_version": c.weights_version,
                "contract_reference": c.reference,
                "contracted_at": c.contracted_at.isoformat() if c.contracted_at else None}
    if sc is None or not sc.measures:
        return None
    idx = mci(sc.measures, prog)
    return {"band": idx["band"], "score": idx["score"], "contracted": False,
            "weights_version": current_version(s, prog), "contract_reference": None, "contracted_at": None}


def contract_band(s: Session, prog: Programme, t: Tenant, reference: str, actor: audit.Actor,
                  user_id: uuid.UUID) -> BandContract:
    if contract_of(s, t.id) is not None:
        raise ProgrammeError(409, "This customer's band is already contracted; contracted bands do not change.")
    sc = latest_scan(s, t.id)
    if sc is None or not sc.measures:
        raise ProgrammeError(409, "No complexity band yet: run a consented light scan first.")
    version = ensure_versions(s, prog, user_id)
    idx = mci(sc.measures, prog)
    c = BandContract(programme_id=prog.id, tenant_id=t.id, band=idx["band"], score=idx["score"],
                     weights_version=version, scan_id=sc.id, reference=reference.strip(), contracted_by=user_id)
    s.add(c)
    s.flush()
    audit.record(s, actor, "programme.band_contracted", tenant_id=t.id, target_type="programme",
                 target_id=str(prog.id), details={"band": c.band, "score": idx["score"], "weights_version": version,
                                                  "scan": str(sc.id), "reference": c.reference})
    return c


def _normalised(measures: dict[str, Any], ranges: dict[str, tuple[Any, ...]]) -> list[float]:
    out = []
    for key, *_ in MEASURES:
        lo, hi = (float(x) for x in ranges[key])
        v = float(measures.get(key, 0) or 0)
        out.append(min(1.0, max(0.0, (v - lo) / (hi - lo))))
    return out


def fit_weights(xs: list[list[float]], ys: list[float], sweeps: int = 2000) -> tuple[list[float], float]:
    """Non-negative least squares with a free intercept, by coordinate descent: hours ≈ a + Σ c_k * n_k with every
    c_k ≥ 0. Returns (c, a). Pure and deterministic."""
    k, n = len(xs[0]), len(xs)
    c = [0.0] * k
    a = sum(ys) / n
    for _ in range(sweeps):
        moved = 0.0
        a = sum(ys[i] - sum(c[j] * xs[i][j] for j in range(k)) for i in range(n)) / n
        for j in range(k):
            col = [xs[i][j] for i in range(n)]
            denom = sum(v * v for v in col)
            if denom <= 0:
                continue
            resid = [ys[i] - a - sum(c[m] * xs[i][m] for m in range(k)) for i in range(n)]
            new = max(0.0, c[j] + sum(col[i] * resid[i] for i in range(n)) / denom)
            moved = max(moved, abs(new - c[j]))
            c[j] = new
        if moved < 1e-10:
            break
    return c, a


def _pearson(a: list[float], b: list[float]) -> float | None:
    n = len(a)
    if n < 2:
        return None
    ma, mb = sum(a) / n, sum(b) / n
    va, vb = sum((x - ma) ** 2 for x in a), sum((y - mb) ** 2 for y in b)
    if va <= 0 or vb <= 0:
        return None
    return round(sum((x - ma) * (y - mb) for x, y in zip(a, b, strict=True)) / math.sqrt(va * vb), 4)


def recalibration(s: Session, prog: Programme, after_wave: str) -> dict[str, Any]:
    """Propose new weights from the actual effort of customers planned in waves up to and including `after_wave`
    (latest portfolio plan). The fitted weights are blended with the current ones in proportion to the number of
    customers behind them. Bands already contracted are listed as kept."""
    waves = list(s.scalars(select(ProgrammeWave).where(ProgrammeWave.programme_id == prog.id)
                           .order_by(ProgrammeWave.start_date, ProgrammeWave.key)))
    keys = [w.key for w in waves]
    if after_wave not in keys:
        raise ProgrammeError(422, "Choose one of the programme's waves.", "after_wave")
    included = keys[:keys.index(after_wave) + 1]
    pp = s.scalars(select(PortfolioPlan).where(PortfolioPlan.programme_id == prog.id)
                   .order_by(PortfolioPlan.number.desc())).first()
    wave_of = {a["customer_id"]: a["wave"] for a in (pp.result.get("assignments") or [])} if pp else {}
    cfg = config_of(prog)
    keys_m = [k for k, *_ in MEASURES]
    xs: list[list[float]] = []
    ys: list[float] = []
    used: list[str] = []
    skipped = {"not_in_included_waves": 0, "no_scan": 0, "no_actual_effort": 0, "unreachable": 0}
    for t in customers(s, prog.id, None):
        if wave_of.get(str(t.id)) not in included:
            skipped["not_in_included_waves"] += 1
            continue
        sc = latest_scan(s, t.id)
        if sc is None or not sc.measures:
            skipped["no_scan"] += 1
            continue
        fig = _tenant_figures(t, [p.id for p in s.scalars(select(Project).where(Project.tenant_id == t.id))])
        if fig.get("unavailable"):
            skipped["unreachable"] += 1
            continue
        if not fig["actual_hours"]:
            skipped["no_actual_effort"] += 1
            continue
        xs.append(_normalised(sc.measures, cfg["ranges"]))
        ys.append(float(fig["actual_hours"]))
        used.append(str(t.id))
    base = {"after_wave": after_wave, "waves_included": included, "samples": len(used), "skipped": skipped,
            "current_version": current_version(s, prog), "current_weights": cfg["weights"],
            "min_samples": MIN_RECALIBRATION_SAMPLES, "plan_number": pp.number if pp else None}
    if len(used) < MIN_RECALIBRATION_SAMPLES:
        return {**base, "can_apply": False,
                "reason": f"{len(used)} customer(s) in these waves have a scan and actual effort; "
                          f"{MIN_RECALIBRATION_SAMPLES} are needed."}
    c, intercept = fit_weights(xs, ys)
    total = sum(c)
    if total <= 0:
        return {**base, "can_apply": False,
                "reason": "Actual effort shows no positive relation to any measure yet; the weights stay as they are."}
    fitted = {k: c[i] / total for i, k in enumerate(keys_m)}
    lam = len(used) / (len(used) + PRIOR_STRENGTH)
    blended = {k: (1 - lam) * cfg["weights"][k] + lam * fitted[k] for k in keys_m}
    proposed = {k: round(v, 4) for k, v in blended.items()}
    drift = round(1.0 - sum(proposed.values()), 4)
    biggest = max(proposed, key=lambda k: proposed[k])
    proposed[biggest] = round(proposed[biggest] + drift, 4)

    def scores(w: dict[str, float]) -> list[float]:
        return [100 * sum(w[k] * x[i] for i, k in enumerate(keys_m)) for x in xs]

    bands = cfg["bands"]

    def band(score: float) -> str:
        return "simple" if score < bands["simple"] else "medium" if score < bands["medium"] else "complex"

    changes = []
    for t in customers(s, prog.id, None):
        sc = latest_scan(s, t.id)
        if sc is None or not sc.measures:
            continue
        now = band_of(s, prog, t.id, sc)
        assert now is not None
        new_score = round(100 * sum(proposed[k] * x for k, x in zip(keys_m, _normalised(sc.measures, cfg["ranges"]),
                                                                     strict=True)), 1)
        new_band = now["band"] if now["contracted"] else band(new_score)
        if now["contracted"] or new_band != now["band"]:
            changes.append({"customer_id": str(t.id), "customer": t.name, "from": now["band"], "to": new_band,
                            "score_from": now["score"], "score_to": now["score"] if now["contracted"] else new_score,
                            "contracted": now["contracted"]})
    return {**base, "can_apply": True, "reason": None, "fitted_weights": {k: round(v, 4) for k, v in fitted.items()},
            "proposed_weights": proposed, "blend": round(lam, 4), "intercept_hours": round(intercept, 1),
            "fit": {"correlation_before": _pearson(scores(cfg["weights"]), ys),
                    "correlation_after": _pearson(scores(proposed), ys)},
            "band_changes": changes, "customers_used": used,
            "method": "Non-negative least squares of actual hours on the normalised measures (free intercept), "
                      "weights scaled to add up to 1, then blended with the current weights by n ÷ (n + 10)."}


def apply_recalibration(s: Session, prog: Programme, after_wave: str, reason: str, actor: audit.Actor,
                        user_id: uuid.UUID) -> tuple[MciWeightVersion, dict[str, Any]]:
    proposal = recalibration(s, prog, after_wave)
    if not proposal["can_apply"]:
        raise ProgrammeError(409, str(proposal["reason"]))
    ensure_versions(s, prog, user_id)
    prog.mci_config = {**(prog.mci_config or {}), "weights": proposal["proposed_weights"]}
    s.flush()
    basis = {k: proposal[k] for k in ("waves_included", "samples", "skipped", "fitted_weights", "blend",
                                      "intercept_hours", "fit", "customers_used", "method", "plan_number")}
    basis["previous_weights"] = proposal["current_weights"]
    basis["band_changes"] = [{k: v for k, v in c.items() if k != "customer"} for c in proposal["band_changes"]]
    v = record_version(s, prog, user_id, "recalibration", reason, after_wave, basis)
    audit.record(s, actor, "programme.mci_recalibrated", target_type="programme", target_id=str(prog.id),
                 details={"version": v.number, "after_wave": after_wave, "samples": proposal["samples"],
                          "weights": proposal["proposed_weights"], "reason": reason})
    return v, proposal


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
        b = band_of(s, prog, t.id, latest_scan(s, t.id))
        if t.partner_id is None:
            conflicts.append({"customer_id": str(t.id), "customer": t.name, "reason": "No partner is assigned."})
        elif not pods.get(t.partner_id):
            conflicts.append({"customer_id": str(t.id), "customer": t.name, "reason": "The partner has no pods."})
        elif b is None:
            conflicts.append({"customer_id": str(t.id), "customer": t.name,
                              "reason": "No complexity band yet: run a consented light scan first."})
        else:
            band = str(b["band"])
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
        b = band_of(s, prog, t.id, sc)
        gaps = s.scalar(select(Gap.id).where(Gap.tenant_id == t.id).limit(1))
        open_gaps = len(list(s.scalars(select(Gap.id).where(Gap.tenant_id == t.id, Gap.status == "open",
                                                            Gap.route == "vendor_product_change"))))
        breaks = len(list(s.scalars(select(ReconBreak.id).where(ReconBreak.project_id.in_(pids),
                                                                ReconBreak.status == "open"))))
        last_load = s.scalars(select(LoadRun).where(LoadRun.project_id.in_(pids), LoadRun.status == "succeeded")
                              .order_by(LoadRun.created_at.desc())).first()
        rows.append({"customer_id": str(t.id), "customer": t.name, "partner_id": str(t.partner_id)
                     if t.partner_id else None, "partner": names.get(t.partner_id) if t.partner_id else None,
                     "segment": t.segment, "band": b["band"] if b else None,
                     "score": b["score"] if b else None, "band_contracted": bool(b and b["contracted"]),
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
        b = band_of(s, prog, t.id, latest_scan(s, t.id))
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
                             "band": b["band"] if b else None})
        start = min((p.created_at for p in projects if p.created_at), default=None)
        end = max((gp.created_at for gp in passes if gp.created_at), default=None)
        elapsed = ((end or datetime.now(UTC)) - start).days if start else None
        rows.append({"customer_id": str(t.id), "customer": t.name, "segment": t.segment,
                     "partner_id": str(t.partner_id) if t.partner_id else None,
                     "band": b["band"] if b else None, "score": b["score"] if b else None,
                     "band_contracted": bool(b and b["contracted"]), "gates_passed": len(passes),
                     "effort_hours": fig.get("actual_hours", 0.0),
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
