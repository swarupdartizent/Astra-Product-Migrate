"""The reference case's packs: register, prove on the synthetic golden estate, publish, and query.

Covers E05.F2.S1-S4 (source adapter), E05.F3.S1-S3 (target adapter), E06.F2.S1-S2 (core and P&C packs),
E07.F2.S1 (compliance packs) and E22.F1.S1 (golden dataset).
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import pytest
import yaml

from tests.conftest import wait_job

pytestmark = pytest.mark.integration
H = dict[str, str]
ROOT = Path(__file__).resolve().parents[3]
PACKS = ["core-ontology", "pc-insurance", "conceptone-source", "prosuite-base-target", "sox-itgc", "soc1-ssae18",
         "naic-data-security", "us-insurance-record-retention", "us-surplus-lines-filing"]
COMPLIANCE = PACKS[4:]


def bundle(name: str) -> dict[str, Any]:
    d = ROOT / "packs" / name
    return {"files": {str(f.relative_to(d)).replace("\\", "/"): base64.b64encode(f.read_bytes()).decode()
                      for f in sorted(d.rglob("*")) if f.is_file()}}


def _publish(client: Any, admin: H, name: str) -> None:
    p = client.get(f"/api/v1/packs/{name}/1.0.0", headers=admin).json()
    if p["status"] != "draft":
        return
    r = client.post(f"/api/v1/packs/{name}/1.0.0/publish", headers=admin)
    assert r.status_code == 200, r.text


@pytest.fixture(scope="module")
def reference(client: Any, admin: H) -> dict[str, Any]:
    for name in PACKS:
        r = client.post("/api/v1/packs", headers=admin, json=bundle(name))
        assert r.status_code == 201, f"{name}: {r.text}"
    _publish(client, admin, "core-ontology")
    g = client.post("/api/v1/golden-runs", headers=admin, json={
        "dataset": "conceptone-source@1.0.0:synthetic-v1", "packs": ["core-ontology@1.0.0", "pc-insurance@1.0.0"]})
    assert g.status_code == 202, g.text
    wait_job(client, admin, g.json()["job_id"], timeout_s=300)
    run = client.get(f"/api/v1/golden-runs/{g.json()['id']}", headers=admin).json()
    assert run["status"] == "passed", [m for m in (run["scorecard"] or {}).get("measures", []) if not m["passed"]] \
        or run["status_detail"]
    _publish(client, admin, "pc-insurance")
    _publish(client, admin, "conceptone-source")
    _publish(client, admin, "prosuite-base-target")
    return run


def test_golden_estate_proves_the_adapter_and_the_pc_pack(reference: dict[str, Any]) -> None:
    measures = {m["name"]: m for m in reference["scorecard"]["measures"]}
    assert all(m["passed"] for m in measures.values())
    for rule in ("PC-POLICY-TERM", "PC-CLAIM-IN-FORCE", "PC-SPLIT-RECONCILE", "PC-INVOICE-RECONCILE",
                 "PC-COMMISSION-SPLIT-RECONCILE"):
        assert measures[f"Rule {rule} violations"]["precision"] == 1.0
        assert measures[f"Rule {rule} violations"]["recall"] == 1.0
    assert measures["Coverage report is complete"]["passed"]
    assert measures["Interfaces found"]["recall"] == 1.0


def test_published_packs_and_their_status(client: Any, admin: H, reference: dict[str, Any]) -> None:
    for name in ("core-ontology", "pc-insurance", "conceptone-source", "prosuite-base-target"):
        assert client.get(f"/api/v1/packs/{name}/1.0.0", headers=admin).json()["status"] == "published"
    adapters = {a["name"]: a for a in client.get("/api/v1/adapters", headers=admin).json()}
    assert adapters["conceptone-source"]["engines"] == ["sqlserver", "sqlanywhere"]
    assert adapters["conceptone-source"]["validated"] is False  # until a real estate has been read
    assert set(adapters["conceptone-source"]["object_types"]) >= {
        "user_defined_table", "procedure", "trigger", "validation_rule", "workflow", "security_profile",
        "external_program"}


def test_compliance_packs_list_sources_and_evidence_and_need_a_named_reviewer(client: Any, admin: H,
                                                                               reference: dict[str, Any]) -> None:
    for name in COMPLIANCE:
        p = client.get(f"/api/v1/packs/{name}/1.0.0", headers=admin).json()
        m = p["manifest"]
        for c in m["adds"]["controls"]:
            assert c["sources"] and c["evidence_required"], f"{name} {c['id']}"
        if p["status"] != "draft":
            continue
        t = client.post(f"/api/v1/packs/{name}/1.0.0/test", headers=admin).json()
        assert t["passed"], (name, [c for c in t["checks"] if not c["passed"]])
        r = client.post(f"/api/v1/packs/{name}/1.0.0/publish", headers=admin)
        assert r.status_code in (409, 422) and "named compliance specialist" in r.text


def test_mga_extension_concepts_and_rules_exist(client: Any, admin: H, reference: dict[str, Any]) -> None:
    packs = {"packs": ["core-ontology@1.0.0", "pc-insurance@1.0.0"]}
    listed = client.get("/api/v1/ontology/concepts", headers=admin, params=packs).json()["concepts"]
    concepts = {c["id"] for c in listed}
    assert {"pc.binding_authority_agreement", "pc.coverholder", "pc.bordereau", "pc.carrier_split",
            "pc.carrier_statement", "pc.surplus_lines_tax", "pc.stamping_fee", "pc.policy_fee", "pc.inspection_fee",
            "pc.instalment", "pc.premium_finance_agreement", "pc.finance_company", "pc.commission_agreement",
            "pc.commission_split", "pc.agency_statement"} <= concepts
    for phrase, expect in (("bordereaux", "pc.bordereau"), ("finco agreement", "pc.premium_finance_agreement"),
                           ("premium split", "pc.carrier_split"), ("SL tax", "pc.surplus_lines_tax")):
        found = client.get("/api/v1/ontology/find", headers=admin, params={"q": phrase, **packs}).json()
        assert found["results"][0]["id"] == expect, (phrase, found["results"][:3])
    k = client.get("/api/v1/ontology/concepts/pc.policy/constraints", headers=admin, params=packs).json()
    ids = {c["id"] for c in k["constraints"]}
    assert {"PC-POLICY-TERM", "PC-RECONCILE-TO-CENT", "CORE-CONTRACT-PERIOD", "PSB-NO-DB-WRITES"} <= ids
    b = client.get("/api/v1/ontology/concepts/pc.policy/bindings", headers=admin,
                   params={**packs, "adapter": "conceptone-source"}).json()
    assert b["bindings"][0]["table_name"] == "dbo.Policy" and b["bindings"][0]["validated"] is False


def test_target_constraints_are_dated_rules_and_loads_are_blocked(client: Any, admin: H,
                                                                  reference: dict[str, Any]) -> None:
    c = client.get("/api/v1/adapters/prosuite-base-target/1.0.0/constraints", headers=admin).json()
    assert all(x["source"]["reference"] and x["recorded_on"] for x in c["constraints"])
    assert c["load"]["endpoints"] == [] and c["load"]["token_path"] is None
    comp = client.post("/api/v1/packs/compose", headers=admin, json={"packs": ["prosuite-base-target@1.0.0"]}).json()
    assert {r["id"] for r in comp["rules"]} >= {"TGT-PSB-NO-DB-WRITES", "TGT-PSB-PDF-ONLY-FORMS"}


def test_synthetic_baseline_can_be_stored_and_pinned(client: Any, admin: H, tenant_factory: Any,
                                                     reference: dict[str, Any]) -> None:
    text = (ROOT / "programmes" / "conceptone-prosuite" / "baselines" / "synthetic-prosuite-base-v1.yaml").read_text()
    existing = [b for b in client.get("/api/v1/target-baselines", headers=admin,
                                      params={"adapter": "prosuite-base-target"}).json()
                if b["name"] == "synthetic-1"]
    if existing:
        b = existing[0]
    else:
        r = client.post("/api/v1/target-baselines", headers=admin, json={
            "adapter_name": "prosuite-base-target", "name": "synthetic-1", "baseline_yaml": text, "synthetic": True})
        assert r.status_code == 201, r.text
        b = r.json()
    assert b["synthetic"] is True and b["object_count"] == len(yaml.safe_load(text)["objects"])
    t = tenant_factory()
    p = client.post(f"/api/v1/tenants/{t['id']}/projects", headers=admin, json={"name": "Reference upgrade"}).json()
    pin = client.put(f"/api/v1/projects/{p['id']}/baseline", headers=admin,
                     json={"baseline_id": b["id"], "reason": "rehearsal against the synthetic baseline"})
    assert pin.status_code == 200 and pin.json()["pinned"]["name"] == "synthetic-1"
