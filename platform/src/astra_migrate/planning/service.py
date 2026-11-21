"""Planning service: gathers the plan's inputs (blueprint, packs, discovery, version delta) and keeps the plan in
the tenant database up to date."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

import psycopg
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate.adapters.contract import SourceAdapterContent, TargetAdapterContent, parse_source
from astra_migrate.blueprints import service as blueprints
from astra_migrate.checklist import target_content
from astra_migrate.db.models import (
    BlueprintVersion,
    ChecklistItem,
    DeltaRun,
    DiscoveryRun,
    Gap,
    ProjectBaseline,
    TargetBaseline,
)
from astra_migrate.packs import registry
from astra_migrate.packs.schema import Manifest, PackType
from astra_migrate.planning import controls, cutover, deps, estimation, scope, store, wbs
from astra_migrate.planning import waves as wave_solver


class PlanError(ValueError):
    """The plan cannot be produced; the message says what is missing."""


@dataclass
class Inputs:
    blueprint: dict[str, Any]
    blueprint_version: int | None
    rules: list[estimation.RuleSet]
    compliance: list[Manifest]
    missing_packs: list[str]
    max_task_hours: int
    freezes: list[dict[str, Any]]
    target_completion: str | None
    cutover_window: str | None
    cutover_strategy: str | None
    source: SourceAdapterContent | None
    target: TargetAdapterContent | None
    target_ref: str | None
    discovery: DiscoveryRun | None
    delta: DeltaRun | None
    notes: list[str] = field(default_factory=list)


def _manifest(s: Session, ref: str) -> Manifest | None:
    try:
        p = registry.get_by_ref(s, ref, published_only=False)
    except ValueError:
        return None
    return registry.manifest_of(p) if p else None


def inputs(s: Session, project_id: uuid.UUID) -> Inputs:
    bv = s.scalars(select(BlueprintVersion).where(BlueprintVersion.project_id == project_id,
                                                  BlueprintVersion.status == "approved")
                   .order_by(BlueprintVersion.number.desc())).first() or blueprints.latest(s, project_id)
    if bv is None:
        raise PlanError("The project has no blueprint yet. Planning reads its packs, constraints and approvals.")
    bp = bv.content or {}
    notes = [] if bv.status == "approved" else [f"Blueprint version {bv.number} is not approved yet."]
    rules, compliance, missing = [], [], []
    for ref in bp.get("pattern_packs") or []:
        m = _manifest(s, ref)
        if m is None:
            missing.append(ref)
            continue
        est = estimation.parse(m.content) if m.type == PackType.PATTERN else None
        if est:
            rules.append(estimation.RuleSet(m.ref, est))
    for ref in bp.get("compliance_packs") or []:
        m = _manifest(s, ref)
        if m is None:
            missing.append(ref)
        else:
            compliance.append(m)
    if not rules:
        notes.append("No pattern pack in the blueprint has estimation rules, so tasks cannot be estimated.")
    src_ref = (bp.get("source") or {}).get("adapter")
    src_m = _manifest(s, src_ref) if src_ref else None
    source = parse_source(src_m.content) if src_m is not None and src_m.type == PackType.SOURCE_ADAPTER else None
    pin = s.get(ProjectBaseline, project_id)
    b = s.get(TargetBaseline, pin.baseline_id) if pin else None
    target_ref, target = target_content(s, b.adapter_name) if b else (None, None)
    cons = bp.get("constraints") or {}
    planning = bp.get("planning") or {}
    disc = s.scalars(select(DiscoveryRun).where(DiscoveryRun.project_id == project_id,
                                                DiscoveryRun.status == "succeeded")
                     .order_by(DiscoveryRun.created_at.desc())).first()
    delta = s.scalars(select(DeltaRun).where(DeltaRun.project_id == project_id, DeltaRun.status == "succeeded")
                      .order_by(DeltaRun.created_at.desc())).first()
    return Inputs(bp, bv.number, rules, compliance, missing, int(planning.get("max_task_hours") or 40),
                  list(cons.get("freeze_periods") or []), cons.get("target_completion"), cons.get("cutover_window"),
                  bp.get("cutover_strategy"), source, target, target_ref, disc, delta, notes)


# ------------------------------------------------------------------ scope and dependencies

def generate_scope(tc: psycopg.Connection[Any], inp: Inputs, project_id: uuid.UUID, by: str) -> dict[str, Any]:
    if inp.discovery is None:
        raise PlanError("Run discovery first: the scope register is built from the newest successful discovery.")
    run_id = inp.discovery.id
    nodes = [scope.Element(r[0], r[1], r[2], r[3], r[4], r[5] or {}, r[6] or {}) for r in tc.execute(
        "SELECT node_id, kind, stream, element, concept, usage, props FROM estate.kg_nodes WHERE run_id = %s",
        (run_id,)).fetchall()]
    delta_rows: list[dict[str, Any]] = []
    nis: list[str] = []
    if inp.delta is not None:
        delta_rows = [{"group": g, "type": t, "source": src, "target": tgt, "origin": o} for g, t, src, tgt, o in
                      tc.execute("SELECT grp, type, source, target, origin FROM estate.delta_differences "
                                 "WHERE run_id = %s", (inp.delta.id,)).fetchall()]
        row = tc.execute("SELECT payload FROM estate.delta_lists WHERE run_id = %s AND section = 'not_in_scope'",
                         (inp.delta.id,)).fetchone()
        nis = list(row[0]) if row else []
    existing = store.items(tc, project_id, "scope")
    built = scope.build(nodes, delta_rows, nis, inp.discovery.window_days, existing,
                        {"discovery_run": str(run_id), "delta_run": str(inp.delta.id) if inp.delta else None})
    kg = [(a, b, k) for a, b, k in tc.execute("SELECT src, dst, kind FROM estate.kg_edges WHERE run_id = %s",
                                              (run_id,)).fetchall()]
    edges = deps.merge(deps.generated(kg, set(built)), store.items(tc, project_id, "edge"))
    with tc.transaction():
        store.put_many(tc, project_id, "scope", built, by, replace=True)
        store.put_many(tc, project_id, "edge", edges, by, replace=True)
    dropped = sorted(set(existing) - set(built))
    return {"items": len(built), "edges": len(edges), "dropped": dropped,
            "by_disposition": _count(built, lambda b: scope.effective(b)),
            "approved": sum(1 for b in built.values() if b["status"] == "approved")}


def _count(items: dict[str, dict[str, Any]], key: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    for b in items.values():
        k = key(b)
        out[k] = out.get(k, 0) + 1
    return out


def dependency_view(tc: psycopg.Connection[Any], project_id: uuid.UUID) -> dict[str, Any]:
    sc = store.items(tc, project_id, "scope")
    edges = store.items(tc, project_id, "edge")
    act = deps.active(edges)
    cyc = deps.cycles(set(sc), act)
    depth = deps.order(set(sc), act)
    return {"nodes": [{"key": k, "element": b["element"], "kind": b["kind"], "stream": b["stream"],
                       "disposition": scope.effective(b), "depth": depth.get(k, 0)} for k, b in sorted(sc.items())],
            "edges": [{"key": k, **e} for k, e in sorted(edges.items())],
            "errors": [{"kind": "cycle", "members": c,
                        "detail": "These elements depend on each other in a cycle: "
                                  + " -> ".join(sc[m]["element"] for m in c) + ". Remove or reverse one edge."}
                       for c in cyc]}


# ------------------------------------------------------------------ tasks

def factors(tc: psycopg.Connection[Any]) -> dict[str, dict[str, Any]]:
    """Calibration from actual effort in this tenant's projects, per estimation rule. Each sample compares the actual
    hours with the rule's *uncalibrated* estimate, so a factor never compounds an earlier one. Tasks whose hours a
    person overrode say nothing about the rule and are left out."""
    samples: dict[str, list[tuple[str, float, float]]] = {}
    for key, rule, est, hours in tc.execute("SELECT task_key, rule_id, estimate, hours FROM estate.plan_actuals "
                                            "WHERE rule_id IS NOT NULL AND NOT overridden").fetchall():
        samples.setdefault(rule, []).append((key, float(est or 0), float(hours)))
    return estimation.calibrate(samples)


def actual_row(task: dict[str, Any], assign: dict[str, str]) -> tuple[Any, ...]:
    """(rule_id, uncalibrated estimate, planned low, likely, high, factor applied, wave, overridden) for one task
    whose actual effort is being imported."""
    ev = task.get("evidence") or {}
    factor = float((ev.get("calibration") or {}).get("factor") or 1.0)
    likely = task.get("likely")
    base = float(likely) / factor if likely is not None and factor > 0 else likely
    return (ev.get("rule"), base, task.get("low"), likely, task.get("high"), factor,
            assign.get(str(task.get("scope"))) if task.get("scope") else None, bool(task.get("override")))


def estimate_accuracy(tc: psycopg.Connection[Any], project_id: uuid.UUID) -> dict[str, Any]:
    """Estimate error per wave (E21.F3.S2): planned hours (what the team was shown) against actual hours, in wave
    order, so a lead sees whether estimates improve as calibration learns from earlier waves."""
    names = {k: w.get("name") or k for k, w in ordered_waves(tc, project_id)}
    order = list(names)
    rows = tc.execute("SELECT task_key, rule_id, planned_low, planned_likely, planned_high, factor, hours, wave, "
                      "overridden FROM estate.plan_actuals WHERE project_id = %s", (project_id,)).fetchall()
    by: dict[str | None, list[tuple[Any, ...]]] = {}
    for r in rows:
        by.setdefault(r[7], []).append(r)
    waves: list[dict[str, Any]] = []
    for key in [*order, *sorted(k for k in by if k is not None and k not in names), None]:
        rs = by.get(key)
        if not rs:
            continue
        planned = [(float(r[3]), float(r[6])) for r in rs if r[3] is not None]
        p_sum, a_sum = sum(p for p, _ in planned), sum(a for _, a in planned)
        ape = [abs(a - p) / p for p, a in planned if p > 0]
        ranged = [r for r in rs if r[2] is not None and r[4] is not None]
        calibrated = sum(1 for r in rs if r[5] is not None and abs(float(r[5]) - 1.0) > 1e-9)
        waves.append({
            "wave": key, "name": names.get(key, key) if key else "Not in a wave", "tasks": len(rs),
            "planned_hours": round(p_sum, 1), "actual_hours": round(a_sum, 1),
            "error_pct": round(100 * (a_sum - p_sum) / p_sum, 1) if p_sum else None,
            "mean_abs_error_pct": round(100 * sum(ape) / len(ape), 1) if ape else None,
            "within_range_pct": round(100 * sum(1 for r in ranged if float(r[2]) <= float(r[6]) <= float(r[4]))
                                      / len(ranged), 1) if ranged else None,
            "calibrated_tasks": calibrated, "overridden_tasks": sum(1 for r in rs if r[8])})
    in_waves = [w for w in waves if w["wave"] is not None and w["mean_abs_error_pct"] is not None]
    trend = None
    if len(in_waves) >= 2:
        first, last = float(in_waves[0]["mean_abs_error_pct"]), float(in_waves[-1]["mean_abs_error_pct"])
        trend = {"from_wave": in_waves[0]["name"], "to_wave": in_waves[-1]["name"], "from": first, "to": last,
                 "direction": "improving" if last < first else "worsening" if last > first else "unchanged"}
    return {"waves": waves, "trend": trend, "factors": factors(tc), "tasks_with_actuals": len(rows),
            "min_samples": estimation.MIN_CALIBRATION_SAMPLES,
            "definitions": {
                "error_pct": "(actual − planned) ÷ planned, over the wave's tasks with actuals; positive means "
                             "the work took longer than planned",
                "mean_abs_error_pct": "Mean of |actual − planned| ÷ planned per task",
                "within_range_pct": "Share of tasks whose actual hours fell inside the planned low–high range"}}


def generate_tasks(tc: psycopg.Connection[Any], inp: Inputs, project_id: uuid.UUID, by: str) -> dict[str, Any]:
    sc = store.items(tc, project_id, "scope")
    if not sc:
        raise PlanError("Generate the scope register first.")
    if not inp.rules:
        raise PlanError("No estimation rules: add a pattern pack with estimation rules to the blueprint.")
    edges = deps.active(store.items(tc, project_id, "edge"))
    matrix = controls.matrix(inp.compliance)
    tasks, unestimated = wbs.build(sc, edges, inp.rules, factors(tc), inp.max_task_hours, matrix)
    keep_overrides(store.items(tc, project_id, "task"), tasks)
    with tc.transaction():
        store.put_many(tc, project_id, "task", tasks, by, replace=True)
        _planner_risks(tc, project_id, sc, edges, unestimated, by)
    over = [k for k, t in tasks.items() if (t.get("likely") or 0) > inp.max_task_hours]
    return {"tasks": len(tasks), "unestimated": unestimated, "over_limit": over,
            "max_task_hours": inp.max_task_hours}


def keep_overrides(old: dict[str, dict[str, Any]], new: dict[str, dict[str, Any]]) -> None:
    """A person's change to a task (role or estimate, from the planning workbench) survives regeneration while the
    task key still exists. The regenerated values become the override's 'original'."""
    for k, t in new.items():
        o = (old.get(k) or {}).get("override")
        if not o:
            continue
        original = {x: t.get(x) for x in ("role", "low", "likely", "high")}
        for x in ("role", "low", "likely", "high"):
            if o.get(x) is not None:
                t[x] = o[x]
        if None not in (t.get("low"), t.get("likely"), t.get("high")):
            t["low"], t["high"] = min(t["low"], t["likely"]), max(t["high"], t["likely"])
        t["override"] = {**o, "original": original}


def _planner_risks(tc: psycopg.Connection[Any], project_id: uuid.UUID, sc: dict[str, dict[str, Any]],
                   edges: list[tuple[str, str]], unestimated: list[str], by: str) -> None:
    """Risks the planner finds are proposals: a person accepts or rejects each one."""
    found = []
    cyc = deps.cycles(set(sc), edges)
    if cyc:
        found.append(("planner:dependency-cycles", f"{len(cyc)} dependency cycle(s) prevent ordering the work",
                      3, 3))
    if unestimated:
        found.append(("planner:unestimated", f"{len(unestimated)} scope item(s) have no estimation rule", 4, 2))
    pending = sum(1 for b in sc.values() if b["status"] != "approved")
    if pending:
        found.append(("planner:scope-unapproved", f"{pending} scope decision(s) are not approved yet", 3, 3))
    existing = store.items(tc, project_id, "risk")
    for key, title, likelihood, impact in found:
        if key in existing:
            continue
        store.put(tc, project_id, "risk", key, {
            "title": title, "detail": "Found by the planner when tasks were generated.", "likelihood": likelihood,
            "impact": impact, "owner_user_id": None, "owner_name": None, "mitigation_task": None,
            "status": "proposed", "source": "planner", "decision": None}, by)


def scope_hours(tasks: dict[str, dict[str, Any]]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for t in tasks.values():
        if t["scope"].startswith("control:") or t.get("likely") is None:
            continue
        r = out.setdefault(t["scope"], {})
        r[t["role"]] = r.get(t["role"], 0.0) + float(t["likely"])
    return out


def ordered_waves(tc: psycopg.Connection[Any], project_id: uuid.UUID) -> list[tuple[str, dict[str, Any]]]:
    return sorted(store.items(tc, project_id, "wave").items(), key=lambda kv: (str(kv[1].get("start")), kv[0]))


def vendor_dependencies(s: Session, project_id: uuid.UUID) -> list[dict[str, Any]]:
    return [{"gap_id": str(g.id), "title": g.title, "vendor_ref": g.vendor_ref, "blocks_waves": g.blocks_waves}
            for g in s.scalars(select(Gap).where(Gap.project_id == project_id, Gap.status == "open",
                                                 Gap.route == "vendor_product_change"))]


def solve_waves(s: Session, tc: psycopg.Connection[Any], inp: Inputs, project_id: uuid.UUID, by: str
                ) -> dict[str, Any]:
    tasks = store.items(tc, project_id, "task")
    if not tasks:
        raise PlanError("Generate tasks first: the solver places their hours into waves.")
    hours = scope_hours(tasks)
    waves = ordered_waves(tc, project_id)
    pins = {k: str(b["wave"]) for k, b in store.items(tc, project_id, "pin").items()}
    edges = deps.active(store.items(tc, project_id, "edge"))
    result = wave_solver.solve(hours, edges, waves, pins)
    cal_broken, cal_options = wave_solver.calendar_checks(waves, inp.freezes, inp.target_completion)
    result["broken"] = cal_broken + result["broken"]
    result["options"] = cal_options + result["options"]
    result["fits"] = not result["broken"]
    result["vendor_dependencies"] = vendor_dependencies(s, project_id)
    result["solved_at"] = datetime.now(UTC).isoformat()
    result["items"] = len(hours)
    with tc.transaction():
        store.put(tc, project_id, "wave_plan", "current", result, by)
    return result


def assignments_from(wave_plan: dict[str, Any] | None) -> dict[str, str]:
    return dict((wave_plan or {}).get("assignments") or {})


def assignments(tc: psycopg.Connection[Any], project_id: uuid.UUID) -> dict[str, str]:
    return assignments_from(store.get(tc, project_id, "wave_plan", "current"))


# ------------------------------------------------------------------ cutover

def _profile_rows(tc: psycopg.Connection[Any], inp: Inputs) -> dict[str, int]:
    if inp.discovery is None:
        return {}
    row = tc.execute("SELECT payload FROM estate.discovery_results WHERE run_id = %s AND section = 'profile'",
                     (inp.discovery.id,)).fetchone()
    return {str(t["table"]).lower(): int(t["rows"]) for t in (row[0].get("tables", []) if row else [])
            if t.get("rows") is not None}


def go_no_go(s: Session, inp: Inputs, project_id: uuid.UUID) -> list[dict[str, Any]]:
    checks = []
    for m in inp.compliance:
        for c in m.adds.controls:
            if c.gate == "cutover":
                checks.append({"key": c.id, "title": c.title, "role": "migration_lead",
                               "basis": f"{m.ref}: {c.evidence_required}"})
    items = s.scalars(select(ChecklistItem).where(ChecklistItem.project_id == project_id)).all()
    open_items = sum(1 for i in items if i.status not in ("done", "not_applicable"))
    checks.append({"key": "hosting-checklist", "title": "Hosting checklist complete", "role": "migration_lead",
                   "basis": f"{len(items) - open_items} of {len(items)} item(s) closed now"})
    checks.append({"key": "reconciliation", "title": "Reconciliation signed by the customer data owner",
                   "role": "customer_data_owner", "basis": "Reconciliation results of the final load"})
    return checks


def cutover_inputs(s: Session, tc: psycopg.Connection[Any], inp: Inputs, project_id: uuid.UUID,
                   assumptions: dict[str, float]) -> cutover.Inputs:
    rows = _profile_rows(tc, inp)
    assign = assignments(tc, project_id)
    waves = [k for k, _ in ordered_waves(tc, project_id)]
    batch = {e.entity: e.batch_size for e in (inp.target.load.endpoints if inp.target else [])}
    ents = []
    for e in (inp.source.entities if inp.source else []):
        ents.append(cutover.Entity(e.name, e.table, e.concept, rows.get(e.table.lower()), batch.get(e.name, 1),
                                   assign.get(f"table:{e.table.lower()}")))
    rpm = inp.target.load.rate_limit.requests_per_minute if inp.target else None
    blocked = inp.target is None or not inp.target.load.token_path or not inp.target.load.endpoints
    return cutover.Inputs(ents, rpm, blocked, cutover.window_hours(inp.cutover_window), waves,
                          go_no_go(s, inp, project_id), assumptions)


def coexistence(tc: psycopg.Connection[Any], ci: cutover.Inputs, project_id: uuid.UUID) -> dict[str, Any]:
    needed = cutover.coexistence_needed(ci.entities, ci.waves)
    rules = store.items(tc, project_id, "coexistence")
    waves = dict(ordered_waves(tc, project_id))
    final = waves[ci.waves[-1]].get("cutover") if ci.waves else None
    final_d = date.fromisoformat(str(final)[:10]) if final else None
    warnings = cutover.coexistence_warnings(rules, needed, final_d, datetime.now(UTC).date())
    return {"needed": [f"{e}:{w}" for e, w in needed], "rules": rules, "warnings": warnings,
            "complete": not any(w["level"] == "error" for w in warnings)}

