"""I12 installed-base programme: set-up, customers assigned to one partner each, consent before a light scan that
keeps only numbers, the Complexity Index with its measures and weights, the portfolio planner within pod capacity,
and the programme view and metering, with partners seeing only their own customers."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine, text

from astra_migrate.config import get_settings
from tests.conftest import wait_job
from tests.test_adapters_ontology import _connection, _reader, _run
from tests.test_planning_api import EST, SRC, setup  # noqa: F401

pytestmark = pytest.mark.integration
H = dict[str, str]


def _scan(client: Any, h: H, admin: H, tenant: dict[str, Any], setup: dict[str, Any]) -> dict[str, Any]:  # noqa: F811
    user, pw = _reader(setup["database"])
    conn = _connection(client, admin, tenant, setup["database"], user, pw, f"fleet-{uuid.uuid4().hex[:4]}",
                       adapter=f"{SRC}@1.0.0")
    assert _run(client, admin, conn["id"], "check")["run"]["status"] == "succeeded"
    r = client.post(f"/api/v1/tenants/{tenant['id']}/fleet-scans", headers=h, json={"connection_id": conn["id"]})
    assert r.status_code == 201, r.text
    job = wait_job(client, admin, r.json()["job_id"], timeout_s=180)
    assert job["status"] == "succeeded", job
    return dict(client.get(f"/api/v1/tenants/{tenant['id']}/fleet-scans", headers=h).json()[0])


def test_installed_base_programme(client: Any, admin: H, tenant_factory: Any, user_factory: Any,
                                  setup: dict[str, Any]) -> None:  # noqa: F811
    prog = client.post("/api/v1/programmes", headers=admin, json={"name": f"Fleet {uuid.uuid4().hex[:6]}"}).json()
    pid = prog["id"]
    base = f"/api/v1/programmes/{pid}"
    pa = client.post(f"{base}/partners", headers=admin, json={"name": "Partner A"}).json()
    pb = client.post(f"{base}/partners", headers=admin, json={"name": "Partner B"}).json()
    owner, _ = user_factory(("programme_owner", "programme", pid))
    lead_a, _ = user_factory(("partner_delivery_lead", "partner", pa["id"]))
    sales, _ = user_factory(("sales_engineer", "programme", pid))
    commercial, _ = user_factory(("commercial_manager", "programme", pid))

    # ---- set-up: one playbook and one set of packs
    bad = client.put(f"{base}/setup", headers=owner, json={"mci_config": {"weights": {"tables": 0.9}}})
    assert bad.status_code == 422
    assert client.put(f"{base}/setup", headers=lead_a, json={}).status_code == 403
    ok = client.put(f"{base}/setup", headers=owner, json={
        "source_adapter": f"{SRC}@1.0.0", "packs": [EST], "segments": ["Commercial", "Personal"],
        "band_effort_weeks": {"simple": 8, "medium": 16, "complex": 26}})
    assert ok.status_code == 200, ok.text
    assert ok.json()["packs"] == [EST] and ok.json()["can_manage"]
    for h, partner in ((owner, pa), (owner, pb)):
        assert client.post(f"{base}/partners/{partner['id']}/pods", headers=h,
                           json={"name": "Pod 1", "capacity": 1}).status_code == 201
    for key, start, end in (("W1", "2027-01-04", "2027-03-01"), ("W2", "2027-03-08", "2027-06-28")):
        assert client.put(f"{base}/waves/{key}", headers=owner,
                          json={"name": key, "start": start, "end": end}).status_code == 200

    # ---- customers: each assigned to one partner, in a segment
    t1 = tenant_factory(programme_id=pid, partner_id=pa["id"])
    t2 = tenant_factory(programme_id=pid, partner_id=pa["id"])
    t3 = tenant_factory(programme_id=pid, partner_id=pb["id"])
    other = client.post("/api/v1/programmes", headers=admin, json={"name": f"Other {uuid.uuid4().hex[:6]}"}).json()
    px = client.post(f"/api/v1/programmes/{other['id']}/partners", headers=admin, json={"name": "Elsewhere"}).json()
    assert client.put(f"{base}/customers/{t1['id']}", headers=owner,
                      json={"partner_id": px["id"], "segment": "Commercial"}).status_code == 422
    for t, seg in ((t1, "Commercial"), (t2, "Personal"), (t3, "Commercial")):
        r = client.put(f"{base}/customers/{t['id']}", headers=owner,
                       json={"partner_id": t["partner_id"], "segment": seg})
        assert r.status_code == 200, r.text
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        with pytest.raises(Exception, match="partner must belong"), eng.begin() as c:
            c.execute(text("UPDATE tenants SET partner_id = :p WHERE id = :t"), {"p": px["id"], "t": t1["id"]})
    finally:
        eng.dispose()

    # ---- consent before a light scan; the scan keeps only numbers
    no = client.post(f"/api/v1/tenants/{t1['id']}/fleet-scans", headers=sales,
                     json={"connection_id": str(uuid.uuid4())})
    assert no.status_code == 409 and "consent" in no.json()["detail"]
    for t in (t1, t2):
        c = client.post(f"/api/v1/tenants/{t['id']}/consents", headers=sales, json={
            "signatory_name": "Jordan Example", "signatory_title": "Chief Information Officer",
            "scope": "Read metadata and record counts only, no business data values, for sizing.",
            "reference": "Signed consent form CF-2026-11"})
        assert c.status_code == 201, c.text
    s1 = _scan(client, sales, admin, t1, setup)
    m = s1["measures"]
    assert m["tables"] >= 5 and m["code_objects"] >= 2 and all(isinstance(v, int | float) for v in m.values())
    idx = s1["mci"]
    assert idx["band"] in ("simple", "medium", "complex") and 0 <= idx["score"] <= 100
    assert {r["key"] for r in idx["measures"]} >= {"tables", "code_objects", "interfaces"}
    assert abs(sum(r["weight"] for r in idx["measures"]) - 1) < 1e-9
    assert abs(sum(r["contribution"] for r in idx["measures"]) - idx["score"]) <= 0.1  # each rounded on its own
    _scan(client, sales, admin, t2, setup)

    consent = client.get(f"/api/v1/tenants/{t1['id']}/consents", headers=sales).json()[0]
    assert client.post(f"/api/v1/consents/{consent['id']}/revoke", headers=sales,
                       json={"reason": "The customer withdrew its consent."}).json()["active"] is False
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        with pytest.raises(Exception, match="consent"), eng.begin() as c:
            c.execute(text("INSERT INTO fleet_scans(id, tenant_id, programme_id, connection_id, consent_id, status, "
                           "requested_by) VALUES (:i, :t, :p, :c, :k, 'queued', '{}')"),
                      {"i": str(uuid.uuid4()), "t": t1["id"], "p": pid,
                       "c": client.get(f"/api/v1/tenants/{t1['id']}/fleet-scans", headers=sales).json()[0]["id"],
                       "k": consent["id"]})
        with pytest.raises(Exception, match="stays revoked"), eng.begin() as c:
            c.execute(text("UPDATE customer_consents SET revoked_at = NULL WHERE id = :i"), {"i": consent["id"]})
    finally:
        eng.dispose()

    # ---- the Complexity Index per customer and per segment; partners see only their own customers
    fl = client.get(f"{base}/fleet", headers=owner).json()
    assert {r["customer_id"] for r in fl["customers"]} == {t1["id"], t2["id"], t3["id"]}
    assert {s["segment"] for s in fl["segments"]} == {"Commercial", "Personal"}
    fa = client.get(f"{base}/fleet", headers=lead_a).json()
    assert {r["customer_id"] for r in fa["customers"]} == {t1["id"], t2["id"]} and fa["scope"] == "partner"

    # ---- portfolio planner: one pod of capacity 1 rotates between partner A's customers
    plan = client.post(f"{base}/portfolio-plans", headers=owner)
    assert plan.status_code == 201, plan.text
    pl = plan.json()
    placed = {a["customer_id"]: a for a in pl["assignments"]}
    assert set(placed) == {t1["id"], t2["id"]} and {a["wave"] for a in placed.values()} == {"W1", "W2"}
    assert any(c["customer_id"] == t3["id"] and "scan" in c["reason"] for c in pl["conflicts"])
    pod_a = next(p for p in pl["pods"] if p["partner_id"] == pa["id"])
    assert [len(w["customers"]) for w in pod_a["waves"]] == [1, 1]
    assert client.post(f"{base}/portfolio-plans", headers=lead_a).status_code == 403
    mine = client.get(f"{base}/portfolio-plans/latest", headers=lead_a).json()
    assert {a["partner_id"] for a in mine["assignments"]} == {pa["id"]}
    assert all(c["customer_id"] != t3["id"] for c in mine["conflicts"])

    # ---- programme view and metering
    view = client.get(f"{base}/view", headers=owner).json()
    assert view["totals"]["customers"] == 3 and view["totals"]["bands"].get("not scanned") == 1
    row = next(r for r in view["customers"] if r["customer_id"] == t1["id"])
    assert row["band"] and row["partner"] == "Partner A" and {"open_vendor_gaps", "open_breaks", "open_risks",
                                                              "gates"} <= set(row)
    assert {r["customer_id"] for r in client.get(f"{base}/view", headers=lead_a).json()["customers"]} == \
        {t1["id"], t2["id"]}
    met = client.get(f"{base}/metering", headers=commercial).json()
    assert len(met["customers"]) == 3 and met["plan_number"] == pl["number"]
    assert {(r["segment"], r["wave"]) for r in met["segment_waves"]} >= {("Commercial", "W1"), ("Personal", "W2")} \
        or {(r["segment"], r["wave"]) for r in met["segment_waves"]} >= {("Commercial", "W2"), ("Personal", "W1")}
    csv_r = client.get(f"{base}/metering", headers=commercial, params={"format": "csv"})
    assert csv_r.status_code == 200 and csv_r.text.splitlines()[0].startswith("customer,segment,band,project,gate")
