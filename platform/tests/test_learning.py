"""I14 learning from delivered work: bulk approval of items sharing an evidence pattern (never compliance-critical,
enforced in the database), confidence calibration per agent, estimate error per wave with calibration that does not
compound, and Complexity Index weights recalibrated from actual effort with every version kept and contracted bands
unchanged."""

from __future__ import annotations

import json
import random
import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine, text

from astra_migrate.config import get_settings
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import Tenant
from astra_migrate.evaluation import calibration
from astra_migrate.planning import service as plan_service
from astra_migrate.planning import store
from astra_migrate.programme import MEASURES, fit_weights
from tests.test_adapters_ontology import _connection
from tests.test_planning_api import EST, SRC, setup  # noqa: F401
from tests.test_review import _new, _project, agent_identity, pack  # noqa: F401

H = dict[str, str]


# ------------------------------------------------------------------ pure

def test_calibration_summary_measures_the_gap() -> None:
    rows = [calibration.Scored("a", "agent", 0.9, i < 6) for i in range(10)]  # says 90%, right 60%
    out = calibration.summarise(rows)
    assert out["items"] == 10 and out["accuracy"] == 0.6 and out["mean_confidence"] == 0.9
    assert out["ece"] == pytest.approx(0.3) and out["direction"] == "overconfident"
    assert out["brier"] == pytest.approx((6 * 0.01 + 4 * 0.81) / 10)
    assert next(b for b in out["bins"] if b["items"])["low"] == 0.9
    assert next(t for t in out["thresholds"] if t["threshold"] == 0.95)["items"] == 0
    assert out["enough_items"] is False
    perfect = calibration.summarise([calibration.Scored("b", "platform", 1.0, True)] * 25)
    assert perfect["ece"] == 0 and perfect["direction"] == "calibrated" and perfect["enough_items"]


def test_fit_weights_finds_the_measure_that_drives_effort() -> None:
    rnd = random.Random(7)  # noqa: S311 - reproducible test inputs, not security
    xs = [[rnd.random() for _ in MEASURES] for _ in range(40)]
    code = [k for k, *_ in MEASURES].index("code_objects")
    ys = [200 + 1000 * x[code] for x in xs]
    c, a = fit_weights(xs, ys)
    assert c[code] == pytest.approx(1000, rel=1e-3) and a == pytest.approx(200, rel=1e-3)
    assert sum(v for j, v in enumerate(c) if j != code) < 1e-3
    assert all(v >= 0 for v in c)


def test_actual_rows_keep_the_uncalibrated_estimate() -> None:
    task = {"scope": "s1", "low": 12.0, "likely": 15.0, "high": 30.0,
            "evidence": {"rule": "R-1", "calibration": {"factor": 1.5}}}
    assert plan_service.actual_row(task, {"s1": "W2"}) == ("R-1", 10.0, 12.0, 15.0, 30.0, 1.5, "W2", False)
    assert plan_service.actual_row({**task, "override": {"likely": 9}}, {})[-2:] == (None, True)


# ------------------------------------------------------------------ bulk approval (E16.F1.S5)

@pytest.mark.integration
def test_bulk_approval_never_covers_compliance_critical_items(client: Any, admin: H, tenant_factory: Any,
                                                               user_factory: Any, pack: str) -> None:  # noqa: F811
    tenant = tenant_factory()
    pid = _project(client, admin, tenant, pack, "Bulk")
    o_h, _ = user_factory(("customer_data_owner", "project", pid))
    pat = f"bulk:{uuid.uuid4().hex[:6]}"
    maps = [_new(tenant["id"], pid, title=f"Map code {i}", subject_type="mapping", pattern=pat) for i in range(3)]
    crit = _new(tenant["id"], pid, kind="decision", title="Critical of the same pattern", subject_type="decision",
                pattern=pat)
    _new(tenant["id"], pid, title="Other pattern", subject_type="mapping", pattern=pat + "x")

    pv = client.get(f"/api/v1/projects/{pid}/review-bulk", headers=o_h, params={"pattern_key": pat}).json()
    assert {i["id"] for i in pv["eligible"]} == set(maps) and pv["can_bulk"] and pv["options"] == ["Yes", "No"]
    assert [x["item"]["id"] for x in pv["excluded"]] == [crit]
    assert "Compliance-critical" in pv["excluded"][0]["reason"]

    url = f"/api/v1/projects/{pid}/review-bulk"
    body = {"pattern_key": pat, "option": "Yes", "note": "Same code list fix for all three.", "item_ids": maps}
    with_crit = client.post(url, headers=o_h, json={**body, "item_ids": [*maps, crit]})
    assert with_crit.status_code == 409 and "Nothing was approved" in with_crit.json()["detail"]
    assert client.post(url, headers=o_h, json={**body, "note": "ok"}).status_code == 422
    assert client.post(url, headers=o_h, json={**body, "option": "Maybe"}).status_code == 409
    done = client.post(url, headers=o_h, json=body)
    assert done.status_code == 200, done.text
    assert done.json()["approved"] == 3 and done.json()["approval_recorded"] == 0
    for i in maps:
        item = client.get(f"/api/v1/review-items/{i}/workbench", headers=o_h).json()["item"]
        assert item["status"] == "resolved" and item["resolution"] == "Yes"
    again = client.post(url, headers=o_h, json=body)
    assert again.status_code == 409  # already decided: nothing recorded twice

    acts = [e for e in client.get("/api/v1/audit", headers=admin, params={"project_id": pid,
                                                                          "action": "review."}).json()["items"]]
    assert sum(1 for e in acts if e["action"] == "review.bulk_approved") == 1
    assert sum(1 for e in acts if e["action"] == "review.approved") == 3

    # The database refuses a bulk approval of a compliance-critical item, whatever the API does.
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        with eng.begin() as c:
            batch, person = c.execute(text(
                "SELECT id, decided_by FROM review_bulk_batches WHERE project_id = :p"), {"p": pid}).one()
        with pytest.raises(Exception, match="compliance-critical items cannot be approved in bulk"), eng.begin() as c:
            c.execute(text("INSERT INTO review_approvals(item_id, user_id, option, note, bulk_batch_id) "
                           "VALUES (:i, :u, 'Yes', 'x', :b)"), {"i": crit, "u": person, "b": batch})
        with pytest.raises(Exception, match="append-only|permission denied"), eng.begin() as c:
            c.execute(text("UPDATE review_bulk_batches SET note = 'changed afterwards' WHERE id = :b"), {"b": batch})
    finally:
        eng.dispose()


# ------------------------------------------------------------------ calibration (E22.F1.S3)

@pytest.mark.integration
def test_calibration_compares_confidence_with_reviewer_outcomes(client: Any, admin: H, tenant_factory: Any,
                                                                user_factory: Any, pack: str) -> None:  # noqa: F811
    tenant = tenant_factory()
    pid = _project(client, admin, tenant, pack, "Calibration")
    o_h, _ = user_factory(("customer_data_owner", "project", pid))
    src = f"fixture-rules-{uuid.uuid4().hex[:6]}"
    who = {"type": "system", "id": f"system:{src}", "name": src}
    ids = [_new(tenant["id"], pid, title=f"Proposal {i}", subject_type="retirement", confidence=0.8,
                requested_by=who, context={"suggested": "Yes"}) for i in range(5)]
    unknown = _new(tenant["id"], pid, title="No suggestion", subject_type="retirement", confidence=0.7,
                   requested_by=who)
    for i, item in enumerate(ids):
        if i < 3:
            body = {"action": "approve", "option": "Yes"}
        elif i == 3:
            body = {"action": "approve", "option": "No"}
        else:
            body = {"action": "reject", "note": "The proposal is wrong for this estate."}
        assert client.post(f"/api/v1/review-items/{item}/decide", headers=o_h, json=body).status_code == 200
    assert client.post(f"/api/v1/review-items/{unknown}/decide", headers=o_h,
                       json={"action": "approve", "option": "Yes"}).status_code == 200

    rep = client.get("/api/v1/evaluation/calibration", headers=admin, params={"tenant_id": tenant["id"]}).json()
    row = next(x for x in rep["sources"] if x["source"] == src)
    assert row["kind"] == "platform" and row["items"] == 5 and row["right"] == 3
    assert row["accuracy"] == 0.6 and row["mean_confidence"] == 0.8 and row["ece"] == pytest.approx(0.2)
    assert rep["unscored"][src] == 1
    assert client.get("/api/v1/evaluation/calibration", headers=o_h).status_code == 403


# ------------------------------------------------------------------ estimates per wave (E21.F3.S2)

@pytest.mark.integration
def test_estimate_error_per_wave_and_non_compounding_factors(client: Any, admin: H, tenant_factory: Any) -> None:
    tenant = tenant_factory()
    p = client.post(f"/api/v1/tenants/{tenant['id']}/projects", headers=admin, json={"name": "Estimates"}).json()
    pid = uuid.UUID(p["id"])
    with session_scope() as s:
        t = s.get(Tenant, uuid.UUID(tenant["id"]))
        assert t is not None
        s.expunge(t)
    # W1 planned with factor 1.0 and 50% under; W2 planned with factor 1.5 and close; t5 was overridden by hand.
    rows = [("t1", "R-A", 10, 8, 10, 14, 1.0, "W1", 15, False), ("t2", "R-A", 10, 8, 10, 14, 1.0, "W1", 15, False),
            ("t3", "R-A", 10, 12, 15, 21, 1.5, "W2", 16, False), ("t4", "R-A", 10, 12, 15, 21, 1.5, "W2", 14, False),
            ("t5", "R-A", 10, 8, 10, 14, 1.0, "W2", 99, True)]
    with store.connect(t) as tc, tc.transaction():
        store.put(tc, pid, "wave", "W1", {"name": "Wave 1", "start": "2027-01-04", "end": "2027-02-01"}, "test")
        store.put(tc, pid, "wave", "W2", {"name": "Wave 2", "start": "2027-02-08", "end": "2027-03-01"}, "test")
        for key, rule, est, lo, li, hi, f, w, h, ov in rows:
            tc.execute("INSERT INTO estate.plan_actuals(project_id, task_key, rule_id, estimate, hours, source, "
                       "planned_low, planned_likely, planned_high, factor, wave, overridden) "
                       "VALUES (%s,%s,%s,%s,%s,'test.csv',%s,%s,%s,%s,%s,%s)",
                       (pid, key, rule, est, h, lo, li, hi, f, w, ov))
    acc = client.get(f"/api/v1/projects/{pid}/plan/estimate-accuracy", headers=admin).json()
    w1, w2 = acc["waves"][0], acc["waves"][1]
    assert (w1["wave"], w1["tasks"], w1["planned_hours"], w1["actual_hours"]) == ("W1", 2, 20.0, 30.0)
    assert w1["error_pct"] == 50.0 and w1["mean_abs_error_pct"] == 50.0 and w1["within_range_pct"] == 0.0
    assert w2["calibrated_tasks"] == 2 and w2["overridden_tasks"] == 1
    assert acc["trend"]["from_wave"] == "Wave 1" and acc["trend"]["to_wave"] == "Wave 2"
    # The factor compares actuals with the *uncalibrated* estimate (10 h) and leaves out the overridden task:
    # median of 15/10, 15/10, 16/10, 14/10 = 1.5, not a factor on top of the earlier 1.5.
    assert acc["factors"]["R-A"]["factor"] == 1.5 and acc["factors"]["R-A"]["samples"] == 4


# ------------------------------------------------------------------ Complexity Index recalibration (E18.F2.S3)

@pytest.mark.integration
def test_recalibration_keeps_versions_and_contracted_bands(client: Any, admin: H, tenant_factory: Any,
                                                           user_factory: Any, setup: dict[str, Any]) -> None:  # noqa: F811
    prog = client.post("/api/v1/programmes", headers=admin, json={"name": f"Learn {uuid.uuid4().hex[:6]}"}).json()
    base = f"/api/v1/programmes/{prog['id']}"
    partner = client.post(f"{base}/partners", headers=admin, json={"name": "Partner L"}).json()
    owner, _ = user_factory(("programme_owner", "programme", prog["id"]))
    lead, _ = user_factory(("partner_delivery_lead", "partner", partner["id"]))
    assert client.put(f"{base}/setup", headers=owner, json={"source_adapter": f"{SRC}@1.0.0", "packs": [EST],
                                                            "band_effort_weeks": {"simple": 4, "medium": 4,
                                                                                  "complex": 4}}).status_code == 200
    assert client.post(f"{base}/partners/{partner['id']}/pods", headers=owner,
                       json={"name": "Pod", "capacity": 10}).status_code == 201
    for key, start, end in (("W1", "2027-01-04", "2027-03-01"), ("W2", "2027-03-08", "2027-05-03")):
        assert client.put(f"{base}/waves/{key}", headers=owner,
                          json={"name": key, "start": start, "end": end}).status_code == 200

    # Four customers with light-scan measures (synthetic test inputs) where code objects drive the effort.
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    customers = []
    try:
        for i, (code, hours) in enumerate(((50, 300), (300, 900), (550, 1500), (800, 2100))):
            t = tenant_factory(programme_id=prog["id"], partner_id=partner["id"])
            assert client.put(f"{base}/customers/{t['id']}", headers=owner,
                              json={"partner_id": partner["id"], "segment": None}).status_code == 200
            consent = client.post(f"/api/v1/tenants/{t['id']}/consents", headers=admin, json={
                "signatory_name": "Jordan Example", "signatory_title": "Chief Information Officer",
                "scope": "Read metadata and record counts only, no business data values, for sizing.",
                "reference": f"Consent form CF-{i}"}).json()
            conn = _connection(client, admin, t, setup["database"], "unused", "unused-Pw1!", f"lc{i}",
                               adapter=f"{SRC}@1.0.0")
            measures = {"tables": 400, "columns": 6000, "custom_tables": 10, "code_objects": code,
                        "code_lines": 20000, "interfaces": 10, "configuration_items": 300, "data_volume_log10": 6,
                        "documents_log10": 4, "traps": 3}
            with eng.begin() as c:
                c.execute(text("INSERT INTO fleet_scans(id, tenant_id, programme_id, connection_id, consent_id, "
                               "status, measures, requested_by, finished_at) VALUES (:i, :t, :p, :c, :k, 'succeeded', "
                               "CAST(:m AS jsonb), '{}', now())"),
                          {"i": str(uuid.uuid4()), "t": t["id"], "p": prog["id"], "c": conn["id"],
                           "k": consent["id"], "m": json.dumps(measures)})
            proj = client.post(f"/api/v1/tenants/{t['id']}/projects", headers=admin, json={"name": "Upgrade"}).json()
            with session_scope() as s:
                tobj = s.get(Tenant, uuid.UUID(t["id"]))
                assert tobj is not None
                s.expunge(tobj)
            with store.connect(tobj) as tc, tc.transaction():
                tc.execute("INSERT INTO estate.plan_actuals(project_id, task_key, hours, source) "
                           "VALUES (%s, 'T-1', %s, 'test.csv')", (uuid.UUID(proj["id"]), hours))
            customers.append(t)
    finally:
        eng.dispose()
    assert client.post(f"{base}/portfolio-plans", headers=owner).status_code == 201

    # Contract the first customer's band before recalibrating.
    before = {r["customer_id"]: r["index"] for r in client.get(f"{base}/fleet", headers=owner).json()["customers"]}
    first = customers[0]["id"]
    assert client.post(f"{base}/customers/{first}/band-contract", headers=lead,
                       json={"reference": "PO-1"}).status_code == 403
    k = client.post(f"{base}/customers/{first}/band-contract", headers=owner, json={"reference": "Order PO-1001"})
    assert k.status_code == 201 and k.json()["band"] == before[first]["band"] and k.json()["weights_version"] == 1
    assert client.post(f"{base}/customers/{first}/band-contract", headers=owner,
                       json={"reference": "Order PO-1002"}).status_code == 409

    prev = client.post(f"{base}/mci/recalibration", headers=owner, json={"after_wave": "W1"}).json()
    assert prev["applied"] is False and prev["can_apply"] and prev["samples"] == 4, prev
    assert prev["fitted_weights"]["code_objects"] > 0.99
    assert prev["proposed_weights"]["code_objects"] > prev["current_weights"]["code_objects"]
    assert abs(sum(prev["proposed_weights"].values()) - 1) < 1e-9
    assert prev["fit"]["correlation_after"] >= prev["fit"]["correlation_before"]
    assert any(c["customer_id"] == first and c["contracted"] and c["from"] == c["to"] for c in prev["band_changes"])
    assert client.post(f"{base}/mci/recalibration", headers=owner,
                       json={"after_wave": "W1", "apply": True}).status_code == 422  # a reason is required
    done = client.post(f"{base}/mci/recalibration", headers=owner, json={
        "after_wave": "W1", "apply": True, "reason": "Wave 1 actual effort is in for all four customers."})
    assert done.status_code == 200, done.text
    assert done.json()["version"]["number"] == 2 and done.json()["version"]["source"] == "recalibration"

    vs = client.get(f"{base}/mci/versions", headers=owner).json()
    assert [v["number"] for v in vs["versions"]] == [2, 1] and vs["versions"][1]["source"] == "starting"
    assert vs["versions"][0]["created_at"] and vs["current_version"] == 2
    assert vs["current"]["weights"] == done.json()["proposed_weights"]
    assert [c["customer_id"] for c in vs["contracts"]] == [first]
    partner_view = client.get(f"{base}/mci/versions", headers=lead).json()
    assert "customers_used" not in partner_view["versions"][0]["basis"]

    after = {r["customer_id"]: r["index"] for r in client.get(f"{base}/fleet", headers=owner).json()["customers"]}
    assert after[first]["contracted"] and after[first]["band"] == before[first]["band"]
    assert after[first]["score"] == before[first]["score"]
    assert after[customers[3]["id"]]["weights_version"] == 2

    # A hand change in set-up is a new version too; stored versions and contracts never change.
    w = dict(vs["current"]["weights"])
    w["tables"], w["columns"] = round(w["tables"] + w["columns"], 4), 0.0
    assert client.put(f"{base}/setup", headers=owner, json={"source_adapter": f"{SRC}@1.0.0", "packs": [EST],
                                                            "mci_config": {"weights": w}}).status_code == 200
    assert client.get(f"{base}/mci/versions", headers=owner).json()["current_version"] == 3
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        for sql in ("UPDATE mci_weight_versions SET reason = 'rewritten history' WHERE programme_id = :p",
                    "UPDATE band_contracts SET band = 'complex' WHERE programme_id = :p",
                    "DELETE FROM band_contracts WHERE programme_id = :p"):
            with pytest.raises(Exception, match="append-only|permission denied"), eng.begin() as c:
                c.execute(text(sql), {"p": prog["id"]})
    finally:
        eng.dispose()
