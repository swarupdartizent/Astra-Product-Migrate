"""I7 planning end to end through the API, on the discovery fixture estate: scope, dependencies, tasks, controls,
waves, risks, cutover, coexistence, baselines with a second approver, exports and actuals, gaps and the programme's
vendor change ranking, and pre-sales estimates."""

from __future__ import annotations

import base64
import csv
import io
import uuid
from pathlib import Path
from typing import Any

import pytest
import yaml

from tests.conftest import wait_job
from tests.test_adapters_ontology import TARGET, _connection, _reader, _run, bundle, domain_manifest, target_manifest
from tests.test_discovery import AS_OF, disc_adapter, disc_files

pytestmark = pytest.mark.integration
H = dict[str, str]
ROOT = Path(__file__).resolve().parents[2]
RUN = uuid.uuid4().hex[:6]
SRC = f"fixture-plan-source-{RUN}"
COMP = f"fixture-plan-controls-{RUN}"
EST = "generic-estimation@1.0.0"


def _pack_files(name: str) -> dict[str, Any]:
    d = ROOT / "packs" / name
    return {"files": {str(f.relative_to(d)).replace("\\", "/"): base64.b64encode(f.read_bytes()).decode()
                      for f in sorted(d.rglob("*")) if f.is_file()}}


def _ensure_published(client: Any, admin: H, name: str, version: str, body: dict[str, Any]) -> None:
    got = client.get(f"/api/v1/packs/{name}/{version}", headers=admin)
    if got.status_code == 404:
        r = client.post("/api/v1/packs", headers=admin, json=body)
        assert r.status_code == 201, r.text
        got = client.get(f"/api/v1/packs/{name}/{version}", headers=admin)
    if got.json()["status"] == "draft":
        r = client.post(f"/api/v1/packs/{name}/{version}/publish", headers=admin)
        assert r.status_code == 200, r.text


def compliance_manifest() -> dict[str, Any]:
    return {"apiVersion": "astra.packs/v1", "type": "compliance", "name": COMP, "version": "1.0.0",
            "title": "Fixture migration controls", "publisher": "Test suite",
            "disclaimer": "Supports, but does not certify, compliance.",
            "adds": {"controls": [
                {"id": "FXC-APP-01", "type": "approval", "title": "Two people approve mappings",
                 "rule": "Mappings are approved by someone other than the author.",
                 "evidence_required": "Approval records.", "parameters": {"applies_to": ["mapping"]},
                 "sources": [{"reference": "fixture"}]},
                {"id": "FXC-REC-01", "type": "gate", "gate": "cutover", "title": "Reconciliation signed",
                 "rule": "Totals reconcile before go-live.", "evidence_required": "Signed reconciliation.",
                 "sources": [{"reference": "fixture"}]}]}}


@pytest.fixture(scope="module")
def setup(client: Any, admin: H) -> dict[str, Any]:
    if client.get(f"/api/v1/packs/{domain_manifest()['name']}/1.0.0", headers=admin).status_code == 404:
        client.post("/api/v1/packs", headers=admin, json=bundle(domain_manifest()))
    m = disc_adapter()
    m["name"] = SRC
    assert client.post("/api/v1/packs", headers=admin, json=bundle(m, disc_files())).status_code == 201
    g = client.post("/api/v1/golden-runs", headers=admin, json={"dataset": f"{SRC}@1.0.0:estate", "keep": True})
    wait_job(client, admin, g.json()["job_id"], timeout_s=240)
    run = client.get(f"/api/v1/golden-runs/{g.json()['id']}", headers=admin).json()
    assert run["status"] == "passed", run
    assert client.post(f"/api/v1/packs/{SRC}/1.0.0/publish", headers=admin).status_code == 200
    _ensure_published(client, admin, TARGET, "1.0.0", bundle(target_manifest(0)))
    _ensure_published(client, admin, "generic-estimation", "1.0.0", _pack_files("generic-estimation"))
    # compliance packs stay drafts until a named specialist reviews them; planning reads them as pinned
    assert client.post("/api/v1/packs", headers=admin, json=bundle(compliance_manifest())).status_code == 201
    return {"database": run["scorecard"]["database"]}


def _blueprint(strategy: str) -> dict[str, Any]:
    return {"apiVersion": "astra.blueprints/v1", "name": "plan-fixture", "pattern": "same_family_upgrade",
            "cutover_strategy": strategy,
            "source": {"adapter": f"{SRC}@1.0.0"}, "target": {"adapter": f"{TARGET}@1.0.0"},
            "compliance_packs": [f"{COMP}@1.0.0"], "pattern_packs": [EST],
            "constraints": {"cutover_window": "weekend, max 36h", "target_completion": "2027-06-30",
                            "freeze_periods": [{"start": "2027-03-25", "end": "2027-04-05", "reason": "Quarter end"}]},
            "planning": {"max_task_hours": 40}}


def _project(client: Any, admin: H, tenant_factory: Any, setup: dict[str, Any], programme: str | None = None
             ) -> tuple[dict[str, Any], dict[str, Any]]:
    tenant = tenant_factory(**({"programme_id": programme} if programme else {}))
    proj = client.post(f"/api/v1/tenants/{tenant['id']}/projects", headers=admin, json={"name": "Plan"}).json()
    r = client.post(f"/api/v1/projects/{proj['id']}/blueprint/versions", headers=admin,
                    json={"content": _blueprint("phased"), "message": "Planning fixture"})
    assert r.status_code in (200, 201), r.text
    user, pw = _reader(setup["database"])
    conn = _connection(client, admin, tenant, setup["database"], user, pw, "plan-src", adapter=f"{SRC}@1.0.0")
    assert _run(client, admin, conn["id"], "check")["run"]["status"] == "succeeded"
    d = client.post(f"/api/v1/projects/{proj['id']}/discovery-runs", headers=admin,
                    json={"connection_id": conn["id"], "as_of": AS_OF.isoformat()})
    wait_job(client, admin, d.json()["job_id"], timeout_s=180)
    baseline = {"format": "astra.baseline/v1", "product": "Fixture", "product_version": "1",
                "provided_by": "Test suite", "provided_on": "2026-11-18",
                "objects": [{"type": "table", "name": n, "schema": "dbo", "columns": [{"name": "x", "type": "int"}]}
                            for n in ("Customer", "Orders", "OrderLine")]}
    b = client.post("/api/v1/target-baselines", headers=admin, json={
        "adapter_name": TARGET, "name": f"plan {uuid.uuid4().hex[:6]}", "baseline_yaml": yaml.safe_dump(baseline),
        "synthetic": True})
    assert client.put(f"/api/v1/projects/{proj['id']}/baseline", headers=admin,
                      json={"baseline_id": b.json()["id"], "reason": "planning test"}).status_code == 200
    dr = client.post(f"/api/v1/projects/{proj['id']}/delta-runs", headers=admin, json={"connection_id": conn["id"]})
    wait_job(client, admin, dr.json()["job_id"], timeout_s=120)
    return tenant, proj


def test_planning_end_to_end(client: Any, admin: H, tenant_factory: Any, user_factory: Any,
                             setup: dict[str, Any]) -> None:
    prog = client.post("/api/v1/programmes", headers=admin, json={"name": f"Plan programme {RUN}"}).json()
    tenant, proj = _project(client, admin, tenant_factory, setup, prog["id"])
    base = f"/api/v1/projects/{proj['id']}/plan"

    ov = client.get(base, headers=admin).json()
    assert ov["ready"] and ov["estimation"][0]["calibrated"] is False and ov["compliance_packs"] == [f"{COMP}@1.0.0"]
    early = client.post(f"{base}/tasks/generate", headers=admin)
    assert early.status_code == 409 and "scope register" in early.json()["detail"]

    # ---- scope: every element proposed with evidence; people approve
    gen = client.post(f"{base}/scope/generate", headers=admin).json()
    assert gen["items"] >= 8 and gen["approved"] == 0
    sc = client.get(f"{base}/scope", headers=admin, params={"limit": 500}).json()
    items = {i["element"]: i for i in sc["items"]}
    # no activity was imported, so nothing is known to be unused; the delta has no standard baseline
    assert items["dbo.ScratchNoKey"]["proposed"] == "rebuild"
    assert "Origin unknown" in items["dbo.ScratchNoKey"]["evidence"][-1]
    assert items["dbo.Customer"]["proposed"] == "migrate" and items["dbo.Customer"]["evidence"]
    assert all(i["evidence"] for i in sc["items"]) and sc["pending"] == sc["total"]
    keys = [i["key"] for i in sc["items"]]
    short = client.post(f"{base}/scope/decisions", headers=admin, json={"keys": keys, "reason": "ok"})
    assert short.status_code == 422
    done = client.post(f"{base}/scope/decisions", headers=admin,
                       json={"keys": keys, "reason": "Reviewed the evidence with the data owner."})
    assert done.json()["decided"] == len(keys)
    change = client.post(f"{base}/scope/decisions", headers=admin, json={
        "keys": [items["dbo.ScratchNoKey"]["key"]], "disposition": "archive",
        "reason": "Finance keeps scratch figures for audit."}).json()
    assert change["decided"] == 1
    regen = client.post(f"{base}/scope/generate", headers=admin).json()
    assert regen["approved"] == len(keys)  # decisions survive re-generation

    # ---- dependencies: discovered edges, a person's edge, cycles as errors
    dep = client.get(f"{base}/dependencies", headers=admin).json()
    orders, lines = "table:dbo.orders", "table:dbo.orderline"
    assert any(e["src"] == lines and e["dst"] == orders for e in dep["edges"]) and dep["errors"] == []
    cyc = client.post(f"{base}/dependencies", headers=admin,
                      json={"src": orders, "dst": lines, "reason": "Totals are recalculated from lines."}).json()
    assert cyc["errors"] and set(cyc["errors"][0]["members"]) == {orders, lines}
    fixed = client.delete(f"{base}/dependencies", headers=admin,
                          params={"key": f"{orders}->{lines}", "reason": "Recalculation happens after the load."})
    assert fixed.json()["errors"] == []

    # ---- tasks and estimates
    tg = client.post(f"{base}/tasks/generate", headers=admin).json()
    assert tg["tasks"] > 0 and tg["over_limit"] == []
    tasks = client.get(f"{base}/tasks", headers=admin, params={"limit": 500}).json()["items"]
    assert all(t["likely"] is None or t["likely"] <= 40 for t in tasks) and all(t["role"] for t in tasks)
    est = client.get(f"{base}/estimates", headers=admin).json()
    assert est["total"]["low"] < est["total"]["likely"] < est["total"]["high"] and "data" in est["by_stream"]
    ctrl = client.get(f"{base}/controls", headers=admin).json()
    rows = {r["control"]: r for r in ctrl["controls"]}
    assert rows["FXC-APP-01"]["task_count"] > 0 and rows["FXC-REC-01"]["gates"] == ["cutover"] and ctrl["complete"]

    # ---- waves and the solver
    for key, body in (("W1", {"name": "Wave 1", "start": "2027-01-04", "end": "2027-02-26", "cutover": "2027-02-27",
                               "capacity": {"data_sme": 2}}),
                      ("W2", {"name": "Wave 2", "start": "2027-03-01", "end": "2027-04-30", "cutover": "2027-03-30",
                              "capacity": {"data_sme": 400, "test_engineer": 400, "solution_architect": 400,
                                           "customer_data_owner": 100, "migration_lead": 100,
                                           "customer_it_security_lead": 100}})):
        assert client.put(f"{base}/waves/{key}", headers=admin, json=body).status_code == 200
    solved = client.post(f"{base}/waves/solve", headers=admin).json()
    assert not solved["fits"] and len(solved["assignments"]) == solved["items"]
    kinds = {b["constraint"] for b in solved["broken"]}
    assert "freeze_period" in kinds  # W2 cuts over in the quarter-end freeze
    assert any(o["option"] == "move_cutover" for o in solved["options"])

    # ---- risks: the planner's are proposals a person accepts
    rk = client.get(f"{base}/risks", headers=admin).json()
    mine = client.post(f"{base}/risks", headers=admin, json={
        "title": "Key users unavailable in March", "likelihood": 3, "impact": 4,
        "mitigation_task": tasks[0]["key"]}).json()
    assert mine["status"] == "accepted" and mine["score"] == 12
    for r in rk:
        if r["status"] == "proposed":
            ok = client.patch(f"{base}/risks/{r['key']}", headers=admin,
                              json={"status": "accepted", "note": "Tracked in the weekly review."})
            assert ok.status_code == 200 and ok.json()["decision"]["by"]

    # ---- cutover, runbook, coexistence
    cmp_ = client.post(f"{base}/cutover/compare", headers=admin, json={}).json()
    opts = {o["option"]: o for o in cmp_["options"]}
    assert set(opts) == {"whole_estate", "phased", "parallel_run"} and cmp_["inputs"]["loads_blocked"] is False
    assert not opts["phased"]["ok"]  # coexistence rules are missing
    ch = client.put(f"{base}/cutover/choice", headers=admin,
                    json={"option": "phased", "reason": "Two lines of business go live separately."})
    assert ch.json()["option"] == "phased"
    rb = client.post(f"{base}/runbook/generate", headers=admin).json()
    step = next(s for s in rb["steps"] if s["key"].endswith("freeze"))
    rh = client.post(f"{base}/runbook/rehearsals", headers=admin,
                     json={"name": "Rehearsal 1", "timings": {step["key"]: 25}}).json()
    after = next(s for s in rh["steps"] if s["key"] == step["key"])
    assert after["planned_minutes"] == 25 and after["estimate_minutes"] == 15 and after["rehearsals"]

    # ---- baselines: a second person approves; phased plans need coexistence rules
    prop = client.post(f"{base}/baselines", headers=admin, json={"reason": "First plan for review."})
    assert prop.status_code == 201, prop.text
    bid = prop.json()["id"]
    self_ok = client.post(f"/api/v1/plan-baselines/{bid}/decision", headers=admin,
                          json={"approve": True, "note": "Looks right to me."})
    assert self_ok.status_code == 403
    approver, _ = user_factory(("customer_data_owner", "tenant", tenant["id"]))
    blocked = client.post(f"/api/v1/plan-baselines/{bid}/decision", headers=approver,
                          json={"approve": True, "note": "Agreed with the business."})
    assert blocked.status_code == 409 and blocked.json()["errors"], blocked.text
    co = client.get(f"{base}/coexistence", headers=admin).json()
    assert co["needed"] and not co["complete"]
    for key in co["needed"]:
        ent, wave = key.split(":")
        r = client.put(f"{base}/coexistence", headers=admin, json={
            "entity": ent, "wave": wave, "system_of_record": "source", "end_date": "2027-04-30",
            "exit_reconciliation": "Record counts and totals match in both systems."})
        assert r.status_code == 200, r.text
    ok = client.post(f"/api/v1/plan-baselines/{bid}/decision", headers=approver,
                     json={"approve": True, "note": "Agreed with the business."})
    assert ok.status_code == 200 and ok.json()["status"] == "approved"
    gate = client.put(f"/api/v1/projects/{proj['id']}/stages/planning", headers=admin, json={"status": "done"})
    assert "No approved migration plan" not in gate.json().get("detail", "")

    # ---- re-plan: the diff shows what changed against the approved baseline
    client.put(f"{base}/waves/W1", headers=admin, json={"name": "Wave 1", "start": "2027-01-04", "end": "2027-02-26",
                                                         "cutover": "2027-02-27", "capacity": {"data_sme": 500}})
    diff = client.get(f"{base}/diff", headers=admin).json()
    assert diff["counts"]["changed"] >= 1 and any(c["item"] == "wave/W1" for c in diff["changed"])
    again = client.post(f"{base}/baselines", headers=admin, json={"reason": "More capacity in wave 1."}).json()
    assert again["changes"]["against"] == 1 and again["status"] == "proposed"

    # ---- exports keep task ids; actuals flow back
    jira = client.get(f"{base}/export", headers=admin, params={"format": "jira", "target": "MIG"})
    rows_ = list(csv.DictReader(io.StringIO(jira.text)))
    assert len(rows_) == len(client.get(f"{base}/tasks", headers=admin, params={"limit": 500}).json()["items"])
    first_key = rows_[0]["Astra ID"]
    actuals = f"Work Item Type,Title,Astra ID,Completed Work\nTask,x,{first_key},6\nTask,y,unknown-task,2\n"
    imp = client.post(f"{base}/actuals", headers=admin, json={
        "filename": "ado.csv", "content_base64": base64.b64encode(actuals.encode()).decode()}).json()
    assert imp["matched"] == 1 and imp["unmatched"] == ["unknown-task"] and imp["hours"] == 6

    # ---- gaps: no close without route and owner; vendor changes rank across the programme
    gap = client.post(f"/api/v1/projects/{proj['id']}/gaps", headers=admin,
                      json={"title": "Bordereau export needs an API", "scope_key": orders}).json()
    early_close = client.patch(f"/api/v1/gaps/{gap['id']}", headers=admin,
                               json={"status": "closed", "close_note": "done"})
    assert early_close.status_code == 409
    me = client.get("/api/v1/me", headers=admin).json()
    routed = client.patch(f"/api/v1/gaps/{gap['id']}", headers=admin, json={
        "route": "vendor_product_change", "owner_user_id": me["id"], "vendor_ref": "REQ-77",
        "blocks_waves": ["W2"]}).json()
    assert routed["product"] == TARGET and routed["blocks_waves"] == ["W2"]
    _, proj2 = _project(client, admin, tenant_factory, setup, prog["id"])
    g2 = client.post(f"/api/v1/projects/{proj2['id']}/gaps", headers=admin, json={"title": "Same API request"}).json()
    client.patch(f"/api/v1/gaps/{g2['id']}", headers=admin,
                 json={"route": "vendor_product_change", "owner_user_id": me["id"], "vendor_ref": "REQ-77"})
    ranked = client.get(f"/api/v1/programmes/{prog['id']}/vendor-changes", headers=admin).json()
    assert ranked["changes"][0]["change"] == "REQ-77" and ranked["changes"][0]["customer_count"] == 2
    as_csv = client.get(f"/api/v1/programmes/{prog['id']}/vendor-changes", headers=admin,
                        params={"format": "csv"})
    assert as_csv.text.splitlines()[1].startswith("1,REQ-77,")
    solved2 = client.post(f"{base}/waves/solve", headers=admin).json()
    assert solved2["vendor_dependencies"][0]["blocks_waves"] == ["W2"]


def test_presales_estimate(client: Any, admin: H, setup: dict[str, Any]) -> None:
    r = client.post("/api/v1/presales-estimates", headers=admin, json={
        "name": "Prospect sizing", "estimation_packs": [EST],
        "questionnaire": {"tables": 300, "customer_tables": 25, "code_objects": 80, "reports": 40, "interfaces": 6,
                          "rows_millions": 40, "team_hours_per_week": 300, "wave_weeks": 8}})
    assert r.status_code == 201, r.text
    res = r.json()["result"]
    assert res["label"].startswith("ESTIMATE") and res["waves"] and res["assumptions"]
    assert res["effort_hours"]["low"] < res["effort_hours"]["high"]
    bad = client.post("/api/v1/presales-estimates", headers=admin, json={
        "name": "Wrong pack", "estimation_packs": [f"{COMP}@1.0.0"], "questionnaire": {"tables": 1}})
    assert bad.status_code == 422
    assert client.get(f"/api/v1/presales-estimates/{r.json()['id']}", headers=admin).status_code == 200
