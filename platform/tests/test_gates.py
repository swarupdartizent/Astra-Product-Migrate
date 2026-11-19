"""I11 gates and proof packs: checklists with platform evidence, compliance-pack conditions attested by people, gates
approved by a different person per role (enforced in the database), and proof packs signed with the vault key and
verifiable offline with the published public key."""

from __future__ import annotations

import base64
import hashlib
import json
import uuid
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import create_engine, text

from astra_migrate.config import get_settings
from tests.test_adapters_ontology import bundle
from tests.test_planning_api import _blueprint, compliance_manifest, setup  # noqa: F401

pytestmark = pytest.mark.integration
H = dict[str, str]
GCOMP = f"fixture-gate-controls-{uuid.uuid4().hex[:6]}"


def _published_controls(client: Any, admin: H) -> str:
    """A compliance pack reviewed by a named specialist and published, as a blueprint needs to be approved."""
    m = compliance_manifest()
    m["name"] = GCOMP
    assert client.post("/api/v1/packs", headers=admin, json=bundle(m)).status_code == 201
    rv = client.post(f"/api/v1/packs/{GCOMP}/1.0.0/review", headers=admin,
                     json={"reviewer_name": "Pat Example", "reviewer_role": "Compliance specialist (test)"})
    assert rv.status_code == 200, rv.text
    assert client.post(f"/api/v1/packs/{GCOMP}/1.0.0/publish", headers=admin).status_code == 200
    return f"{GCOMP}@1.0.0"


def _gate(g: dict[str, Any], key: str) -> dict[str, Any]:
    return next(x for x in g["gates"] if x["key"] == key)


def test_gates_and_signed_proof_packs(client: Any, admin: H, tenant_factory: Any, user_factory: Any,
                                      setup: dict[str, Any]) -> None:  # noqa: F811
    tenant = tenant_factory()
    pid = client.post(f"/api/v1/tenants/{tenant['id']}/projects", headers=admin, json={"name": "Gates"}).json()["id"]
    lead, lead_id = user_factory(("migration_lead", "project", pid))
    owner, _ = user_factory(("customer_data_owner", "project", pid))
    bp = _blueprint("whole_estate")
    bp["compliance_packs"] = [_published_controls(client, admin)]
    bp["gates"] = [{"key": "configure", "label": "G0"}, {"key": "cutover", "label": "G3"}]
    assert client.post(f"/api/v1/projects/{pid}/blueprint/versions", headers=lead,
                       json={"content": bp, "message": "Gate fixture"}).status_code in (200, 201)
    base = f"/api/v1/projects/{pid}"

    g = client.get(f"{base}/gates", headers=lead).json()
    assert [x["key"] for x in g["gates"]] == ["configure", "discover", "plan", "design", "build_rehearse",
                                              "cutover", "stabilise", "decommission"]
    g0 = _gate(g, "configure")
    assert g0["label"] == "G0" and not g0["all_met"] and g0["status"] == "open"
    early = client.post(f"{base}/gates/configure/approvals", headers=lead, json={"role": "migration_lead"})
    assert early.status_code == 409 and "Blueprint approved" in early.json()["detail"]

    for h in (lead, owner):
        r = client.post(f"{base}/blueprint/versions/1/decision", headers=h,
                        json={"approve": True, "reason": "Gate test approval."})
        assert r.status_code == 200, r.text
    g = client.get(f"{base}/gates", headers=lead).json()
    g0 = _gate(g, "configure")
    assert g0["all_met"] and g0["items"][0]["source"]["href"].endswith("/blueprint/versions/1")
    # compliance-pack conditions: the fixture's approval control applies at design, its gate control at cutover
    design = _gate(g, "design")
    ctl = next(i for i in design["items"] if i["key"] == "control:FXC-APP-01")
    assert ctl["kind"] == "control" and not ctl["met"] and ctl["control"]["pack"] == f"{GCOMP}@1.0.0"
    assert any(i["key"] == "control:FXC-REC-01" for i in _gate(g, "cutover")["items"])
    assert _gate(g, "cutover")["label"] == "G3"
    assert any(i["kind"] == "attestation" for i in _gate(g, "decommission")["items"])

    # evidence items come from records and cannot be attested by hand
    bad = client.put(f"{base}/gates/design/evidence", headers=lead,
                     json={"item_key": "mappings-decided", "note": "We checked them all, honestly."})
    assert bad.status_code == 422
    ok = client.put(f"{base}/gates/design/evidence", headers=lead, json={
        "item_key": "control:FXC-APP-01", "note": "Approval records exported from the review queue.",
        "reference": "https://example.org/evidence/approvals-2026-11"})
    assert ok.status_code == 200 and next(i for i in ok.json()["items"] if i["key"] == "control:FXC-APP-01")["met"]

    # G0: one person per role; it passes on the second approval
    a1 = client.post(f"{base}/gates/configure/approvals", headers=lead,
                     json={"role": "migration_lead", "note": "Blueprint approved by both parties."})
    assert a1.status_code == 200 and a1.json()["status"] == "open" and len(a1.json()["approvals"]) == 1
    twice = client.post(f"{base}/gates/configure/approvals", headers=lead, json={"role": "customer_data_owner"})
    assert twice.status_code == 403
    a2 = client.post(f"{base}/gates/configure/approvals", headers=owner, json={"role": "customer_data_owner"})
    assert a2.status_code == 200 and a2.json()["status"] == "passed"

    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        with pytest.raises(Exception, match="cannot pass"), eng.begin() as c:
            c.execute(text("INSERT INTO gate_passes(id, project_id, gate, checklist_digest, required_roles, checklist) "
                           "VALUES (:i, :p, 'discover', 'x', ARRAY['migration_lead'], '{}')"),
                      {"i": str(uuid.uuid4()), "p": pid})
    finally:
        eng.dispose()

    # ---- proof pack: structured data and PDF, signed together, every item linked to its source
    assert client.post(f"{base}/proof-packs", headers=lead, json={"wave": "NOPE"}).status_code == 422
    pk = client.post(f"{base}/proof-packs", headers=lead, json={})
    assert pk.status_code == 201, pk.text
    pack = pk.json()
    assert pack["number"] == 1 and pack["scope"] == "project" and pack["signature"].startswith("vault:v")
    doc_r = client.get(f"/api/v1/proof-packs/{pack['id']}/document", headers=lead)
    pdf_r = client.get(f"/api/v1/proof-packs/{pack['id']}/pdf", headers=lead)
    assert pdf_r.content.startswith(b"%PDF-") and pdf_r.headers["content-type"] == "application/pdf"
    assert hashlib.sha256(doc_r.content).hexdigest() == pack["json_sha256"]
    assert hashlib.sha256(pdf_r.content).hexdigest() == pack["pdf_sha256"]
    doc = json.loads(doc_r.content)
    assert doc["format"] == "astra.proofpack/v1" and [s["key"] for s in doc["sections"]] == [
        "configuration", "scope", "lineage", "decisions", "controls", "tests", "agents", "cutover", "decommission"]
    items = [i for s in doc["sections"] for i in s["items"]]
    assert items and all(i["source"]["type"] and i["source"]["id"] for i in items)
    cfg = next(s for s in doc["sections"] if s["key"] == "configuration")["items"]
    assert any(i["source"]["href"].endswith("/blueprint/versions/1") for i in cfg)
    controls = next(s for s in doc["sections"] if s["key"] == "controls")["items"]
    assert any(i["title"] == "Gate G0: passed" for i in controls)
    assert client.get(f"/api/v1/proof-packs/{pack['id']}/verify", headers=lead).json()["valid"] is True

    # an auditor verifies offline with the published public key
    key = client.get("/api/v1/proof-packs/signing-key", headers=lead).json()
    pub = key["versions"][str(pack["key_version"])]
    sig = base64.b64decode(pack["signature"].split(":", 2)[2])
    Ed25519PublicKey.from_public_bytes(base64.b64decode(pub)).verify(
        sig, f"{pack['json_sha256']}:{pack['pdf_sha256']}".encode())

    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        # the app role has no UPDATE right on proof packs, and a trigger refuses any change for every other role
        with pytest.raises(Exception, match="cannot change|permission denied"), eng.begin() as c:
            c.execute(text("UPDATE proof_packs SET summary = '{}' WHERE id = :i"), {"i": pack["id"]})
    finally:
        eng.dispose()
    acts = {e["action"] for e in client.get("/api/v1/audit", headers=admin,
                                            params={"project_id": pid, "action": "gate."}).json()["items"]}
    assert {"gate.approved", "gate.passed", "gate.evidence_attested"} <= acts
    assert lead_id
