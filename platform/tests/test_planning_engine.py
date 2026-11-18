"""I7 planning engines (unit): estimation, scope proposals, dependencies, work breakdown, the wave solver,
cutover comparison, coexistence warnings, baselines, exports and pre-sales."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

import pytest
import yaml

from astra_migrate.planning import baseline, cutover, deps, estimation, exports, presales, scope, waves, wbs

ROOT = Path(__file__).resolve().parents[2]


def generic_rules() -> list[estimation.RuleSet]:
    m = yaml.safe_load((ROOT / "packs" / "generic-estimation" / "pack.yaml").read_text(encoding="utf-8"))
    est = estimation.parse(m["content"])
    assert est is not None and est.calibrated is False
    return [estimation.RuleSet("generic-estimation@1.0.0", est)]


def E(key: str, kind: str = "table", stream: str = "data", usage: dict[str, Any] | None = None,
      props: dict[str, Any] | None = None) -> scope.Element:
    return scope.Element(key, kind, stream, key.split(":", 1)[1], None, usage or {}, props or {"columns": 10})


# ------------------------------------------------------------------ estimation

def test_estimation_rules_are_validated() -> None:
    with pytest.raises(ValueError, match="shares must add up to 1"):
        estimation.EstimationRule.model_validate({
            "id": "X-A", "stream": "data", "disposition": "migrate", "per_unit": {"low": 1, "likely": 2, "high": 3},
            "activities": [{"name": "Only half", "role": "data_sme", "share": 0.5}]})
    with pytest.raises(ValueError, match="low <= likely <= high"):
        estimation.Range(low=3, likely=2, high=4)


def test_calibration_needs_three_past_tasks_and_names_them() -> None:
    few = estimation.calibrate({"R-1": [("a", 10, 20), ("b", 10, 20)]})
    assert few["R-1"]["factor"] == 1.0 and "Not calibrated" in few["R-1"]["note"]
    enough = estimation.calibrate({"R-1": [("a", 10, 15), ("b", 10, 20), ("c", 10, 12)]})
    assert enough["R-1"]["factor"] == 1.5 and enough["R-1"]["past_tasks"] == ["a", "b", "c"]


# ------------------------------------------------------------------ scope

def test_every_element_gets_a_disposition_with_evidence() -> None:
    unused = E("table:dbo.old", usage={"unused": True, "reads": 0, "writes": 0})
    hist = E("table:dbo.hist", usage={"reads": 40, "writes": 0})
    ext = E("table:dbo.usr_x", stream="customizations", usage={"reads": 3, "writes": 3})
    same = E("table:dbo.orders", usage={"reads": 9, "writes": 9})
    gone = E("table:dbo.legacy", usage={"reads": 9, "writes": 9})
    proc = E("procedure:dbo.p", kind="procedure", stream="customizations", usage={"executions": 2})
    itf = E("interface:program:etl", kind="interface", stream="integrations")
    delta = [{"group": "removed_in_target", "source": "dbo.hist", "target": None, "origin": "standard"},
             {"group": "removed_in_target", "source": "dbo.usr_x", "target": None, "origin": "customer_specific"},
             {"group": "unchanged", "source": "dbo.orders", "target": "dbo.orders", "origin": "standard"},
             {"group": "removed_in_target", "source": "dbo.legacy", "target": None, "origin": "standard"}]
    built = scope.build([unused, hist, ext, same, gone, proc, itf], delta, ["procedure:dbo.p"], 90, {}, {})
    got = {k.split(":", 1)[1]: (b["proposed"], b["evidence"]) for k, b in built.items()}
    assert got["dbo.old"][0] == "retire" and "90-day" in got["dbo.old"][1][0]
    assert got["dbo.hist"][0] == "archive"
    assert got["dbo.usr_x"][0] == "rebuild"
    assert got["dbo.orders"][0] == "migrate"
    assert got["dbo.legacy"][0] == "replace_with_standard"
    assert got["dbo.p"][0] == "rebuild" and "does not describe" in got["dbo.p"][1][0]
    assert got["program:etl"][0] == "rebuild"
    assert all(b["status"] == "proposed" and b["evidence"] for b in built.values())
    assert "agentify" not in {b["proposed"] for b in built.values()}


def test_decisions_survive_regeneration_and_flag_a_changed_proposal() -> None:
    first = scope.build([E("table:dbo.a", usage={"reads": 1, "writes": 1})], [], [], 90, {}, {})
    first["table:dbo.a"].update(status="approved", disposition="rebuild", decision={"by": "Lee"})
    again = scope.build([E("table:dbo.a", usage={"unused": True})], [], [], 90, first, {})
    a = again["table:dbo.a"]
    assert a["status"] == "approved" and a["disposition"] == "rebuild" and a["proposed"] == "retire"
    assert "review the decision" in a["evidence"][-1]


# ------------------------------------------------------------------ dependencies

def test_cycles_are_found_and_depths_ignore_them() -> None:
    nodes = {"a", "b", "c", "d", "e"}
    edges = [("b", "a"), ("c", "b"), ("a", "c"), ("d", "c"), ("e", "e")]
    assert deps.cycles(nodes, edges) == [["a", "b", "c"]]
    depth = deps.order(nodes, edges)
    assert depth["d"] == depth["a"] + 1


def test_people_keep_their_edges_and_removals() -> None:
    fresh = deps.generated([("x", "y", "depends_on"), ("x", "y", "reads"), ("y", "z", "has_column")],
                           {"x", "y", "z"})
    assert list(fresh) == ["x->y"] and fresh["x->y"]["kinds"] == ["depends_on", "reads"]
    existing = {"x->y": {**fresh["x->y"], "removed": {"by": "Lee", "reason": "not a real dependency"}},
                "z->x": {"src": "z", "dst": "x", "source": "person", "removed": None}}
    merged = deps.merge(fresh, existing)
    assert merged["x->y"]["removed"] and "z->x" in merged
    assert deps.active(merged) == [("z", "x")]


# ------------------------------------------------------------------ work breakdown

def test_no_task_is_longer_than_the_limit_and_each_has_a_role_and_dependencies() -> None:
    big = {"element": "dbo.big", "kind": "table", "stream": "data", "segment": "dbo", "props": {"columns": 200},
           "proposed": "migrate", "status": "approved", "disposition": "migrate"}
    small = {**big, "element": "dbo.small", "props": {"columns": 4}}
    tasks, unest = wbs.build({"table:dbo.big": big, "table:dbo.small": small},
                             [("table:dbo.big", "table:dbo.small")], generic_rules(), {}, 40, [])
    assert not unest
    assert all(t["likely"] <= 40 for t in tasks.values())
    parts = [t for t in tasks.values() if t["element"] == "dbo.big" and t["activity"] == "Map and design"]
    assert len(parts) == 2 and parts[0]["parts"] == 2  # (4 + 0.5 * 200) * 0.4 = 41.6 h -> two parts
    first_big = next(k for k in sorted(tasks) if k.startswith("table:dbo.big|map"))
    assert any(d.startswith("table:dbo.small|test") for d in tasks[first_big]["depends_on"])
    assert all(t["role"] for t in tasks.values())
    ev = tasks[first_big]["evidence"]
    assert ev["rule"] == "GEN-DATA-MIGRATE" and ev["pack"] == "generic-estimation@1.0.0" and ev["unit"] == "column"
    roll = wbs.rollup(tasks, {"table:dbo.big": "W1"})
    assert roll["by_wave"]["W1"]["likely"] > 0 and "unassigned" in roll["by_wave"]
    assert roll["total"]["low"] <= roll["total"]["likely"] <= roll["total"]["high"]


def test_items_without_a_rule_are_reported_not_invented() -> None:
    odd = {"element": "x", "kind": "configuration", "stream": "configuration", "segment": "s", "props": {},
           "proposed": "agentify", "status": "proposed", "disposition": None}
    tasks, unest = wbs.build({"config:x": odd}, [], generic_rules(), {}, 40, [])
    assert tasks == {} and unest == ["config:x"]


# ------------------------------------------------------------------ waves

def W(key: str, start: str, end: str, cut: str | None = None, **cap: float) -> tuple[str, dict[str, Any]]:
    return key, {"start": start, "end": end, "cutover": cut, "capacity": cap}


def test_solver_fits_work_and_respects_dependencies() -> None:
    items = {"a": {"data_sme": 30}, "b": {"data_sme": 30}, "c": {"data_sme": 30}}
    res = waves.solve(items, [("c", "a")], [W("W1", "2027-01-01", "2027-02-01", data_sme=60),
                                            W("W2", "2027-02-02", "2027-03-01", data_sme=60)], {})
    assert res["fits"] and res["broken"] == []
    order = {"W1": 0, "W2": 1}
    assert order[res["assignments"]["c"]] >= order[res["assignments"]["a"]]


def test_solver_reports_every_broken_constraint_and_never_drops_work() -> None:
    items = {"a": {"data_sme": 50}, "b": {"data_sme": 50}, "c": {"solution_architect": 10}}
    res = waves.solve(items, [], [W("W1", "2027-01-01", "2027-02-01", data_sme=40)], {"c": "W1"})
    assert not res["fits"] and set(res["assignments"]) == {"a", "b", "c"}
    cap = {(b["role"], b["over_by_hours"]) for b in res["broken"] if b["constraint"] == "capacity"}
    assert cap == {("data_sme", 60), ("solution_architect", 10)}
    assert {o["option"] for o in res["options"]} >= {"add_capacity", "add_wave"}


def test_calendar_checks_find_freezes_and_late_finishes() -> None:
    broken, options = waves.calendar_checks(
        [W("W1", "2027-01-01", "2027-02-01", "2027-01-20")],
        [{"start": "2027-01-15", "end": "2027-01-25", "reason": "year-end"}], "2027-01-30")
    kinds = {b["constraint"] for b in broken}
    assert kinds == {"freeze_period", "target_completion"}
    assert any(o["option"] == "move_cutover" and o["to"] == "2027-01-26" for o in options)


def test_no_waves_is_reported() -> None:
    res = waves.solve({"a": {"data_sme": 1}}, [], [], {})
    assert res["status"] == "no_waves" and not res["fits"]


# ------------------------------------------------------------------ cutover and coexistence

def _inputs(window: float | None = 36) -> cutover.Inputs:
    ents = [cutover.Entity("customer", "dbo.Customer", "x.customer", 120_000, 100, "W1"),
            cutover.Entity("order", "dbo.Orders", "x.order", 480_000, 100, "W2")]
    return cutover.Inputs(ents, 600, False, window, ["W1", "W2"], [{"key": "REC", "title": "Reconciled"}])


def test_cutover_options_show_duration_effort_risk_and_constraints() -> None:
    opts = {o["option"]: o for o in cutover.compare(_inputs(), coexistence_ok=False)}
    assert set(opts) == {"whole_estate", "phased", "parallel_run"}
    whole, phased = opts["whole_estate"], opts["phased"]
    # 600,000 rows / 100 per call / 600 calls per minute = 10 minutes of loading
    assert whole["windows"] == 1 and phased["windows"] == 2
    assert phased["longest_window_hours"] < whole["longest_window_hours"]
    factors = {o: {f["factor"]: f["value"] for f in opts[o]["risk_factors"]} for o in opts}
    assert factors["whole_estate"]["blast_radius"] == 1.0 and factors["phased"]["blast_radius"] == 0.8
    assert factors["phased"]["coexistence_periods"] == 1 and factors["whole_estate"]["coexistence_periods"] == 0
    assert 1 <= whole["risk"] <= 5 and 1 <= phased["risk"] <= 5
    assert not phased["ok"] and any(c["constraint"] == "coexistence_rules" and not c["ok"]
                                    for c in phased["constraints"])
    assert opts["parallel_run"]["effort_hours"] > whole["effort_hours"]
    tight = {o["option"]: o for o in cutover.compare(_inputs(window=0.5), True)}
    assert not tight["whole_estate"]["ok"]


def test_runbook_steps_have_owners_durations_and_rollback() -> None:
    steps = cutover.runbook("whole_estate", _inputs(), cutover.DEFAULT_ASSUMPTIONS)
    assert all(s["role"] for s in steps)
    load = next(s for s in steps if s["key"] == "load:order")
    assert load["planned_minutes"] == 8.0  # 4,800 calls at 600 per minute
    assert any(s["kind"] == "go_no_go" for s in steps) and any(s["kind"] == "rollback" for s in steps)
    phased = cutover.runbook("phased", _inputs(), cutover.DEFAULT_ASSUMPTIONS)
    assert {s["wave"] for s in phased} == {"W1", "W2"}


def test_coexistence_needs_a_rule_for_every_shared_entity_in_every_phase() -> None:
    needed = cutover.coexistence_needed(_inputs().entities, ["W1", "W2", "W3"])
    assert needed == [("customer", "W1"), ("order", "W1"), ("customer", "W2"), ("order", "W2")]
    rules = {"customer:W1": {"end_date": "2027-03-01", "exit_reconciliation": "Counts and balances match."},
             "order:W1": {"end_date": "2027-01-10", "exit_reconciliation": ""}}
    warns = cutover.coexistence_warnings(rules, needed, date(2027, 2, 15), date(2027, 1, 1))
    by = {(w["key"], w["level"]) for w in warns}
    assert ("order:W1", "warning") in by  # ends before the last wave cuts over
    assert ("order:W1", "error") in by  # no exit reconciliation
    assert ("customer:W2", "error") in by and ("customer:W1", "error") not in by


# ------------------------------------------------------------------ baselines, exports, pre-sales

def test_baseline_diff_lists_added_removed_and_changed_fields() -> None:
    a = {"task/x": {"likely": 4, "evidence": {"n": 1}}, "task/y": {"likely": 2}}
    b = {"task/x": {"likely": 6, "evidence": {"n": 2}}, "task/z": {"likely": 1}}
    d = baseline.diff(a, b)
    assert d["added"] == ["task/z"] and d["removed"] == ["task/y"]
    assert d["changed"] == [{"item": "task/x", "fields": [{"field": "likely", "before": 4, "after": 6}]}]
    assert baseline.digest(a) == baseline.digest({**a, "task/x": {"likely": 4, "evidence": {"n": 9}}})


def test_exports_keep_task_ids_and_actuals_flow_back() -> None:
    tasks = {"table:dbo.a|map|1": {"title": "Map: dbo.a", "activity": "Map", "element": "dbo.a", "stream": "data",
                                   "disposition": "migrate", "role": "data_sme", "low": 1, "likely": 2, "high": 4,
                                   "depends_on": []}}
    assert "table:dbo.a|map|1" in exports.jira_csv(tasks, "MIG") and ",7200," in exports.jira_csv(tasks, "MIG")
    assert "table:dbo.a|map|1" in exports.ado_csv(tasks, "Area\\Mig")
    ado = b"Work Item Type,Title,Astra ID,Completed Work\nTask,x,table:dbo.a|map|1,3.5\nTask,y,other,1\n"
    assert exports.parse_actuals(ado) == [("other", 1.0), ("table:dbo.a|map|1", 3.5)]
    jira = "Summary,Astra ID,Time Spent\nx,table:dbo.a|map|1,5400\n".encode()
    assert exports.parse_actuals(jira) == [("table:dbo.a|map|1", 1.5)]
    with pytest.raises(exports.ImportError_, match="task id column"):
        exports.parse_actuals(b"a,b\n1,2\n")


def test_presales_is_marked_as_an_estimate_and_lists_its_assumptions() -> None:
    q = presales.Questionnaire(tables=100, customer_tables=10, code_objects=20, interfaces=3, rows_millions=5,
                               team_hours_per_week=200, wave_weeks=8)
    out = presales.run(q, generic_rules(), presales.sample_counts([
        {"type": "table", "columns": [{"name": "a"}] * 20}] * 120))
    assert out["label"].startswith("ESTIMATE")
    assert out["effort_hours"]["low"] < out["effort_hours"]["likely"] < out["effort_hours"]["high"]
    assert any("sample extract has 120" in a for a in out["assumptions"])
    assert out["waves"] and out["duration_weeks"] == len(out["waves"]) * 8
    assert out["basis"][0]["calibrated"] is False
