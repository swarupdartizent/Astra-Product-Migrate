"""I8 review workbench: risk-sorted queue with filters, evidence and precedents, approve / reject / change, named
reviewers and two-person approval for compliance-critical items (enforced in the database), and the Review Assistant
that cannot decide anything."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine, text

from astra_migrate.agents.registry import catalog_files, parse
from astra_migrate.agents.tools import CATALOGUE, Effect
from astra_migrate.config import get_settings
from astra_migrate.db.control import session_scope
from astra_migrate.review import service as reviews
from tests.test_adapters_ontology import bundle

pytestmark = pytest.mark.integration
H = dict[str, str]
RUN = uuid.uuid4().hex[:6]
COMP = f"fixture-review-controls-{RUN}"


def _compliance() -> dict[str, Any]:
    return {"apiVersion": "astra.packs/v1", "type": "compliance", "name": COMP, "version": "1.0.0",
            "title": "Fixture review controls", "publisher": "Test suite",
            "disclaimer": "Supports, but does not certify, compliance.",
            "adds": {"controls": [
                {"id": "FXR-SOD-01", "type": "approval", "title": "Two people approve agent decisions",
                 "rule": "Agent-requested decisions are approved by two people, one of them named.",
                 "evidence_required": "Approval records with two different people.",
                 "parameters": {"applies_to": ["decision"]}, "compliance_critical": True,
                 "two_person_approval": True, "sources": [{"reference": "fixture"}]},
                {"id": "FXR-MAP-01", "type": "approval", "title": "Mappings are approved",
                 "rule": "Mappings are approved by someone other than the author.",
                 "evidence_required": "Approval records.", "parameters": {"applies_to": ["mapping"]},
                 "sources": [{"reference": "fixture"}]}]}}


@pytest.fixture(scope="module")
def agent_identity(client: Any, admin: H) -> str:
    r = client.post("/api/v1/agents/catalog/import", headers=admin)
    assert r.status_code == 200, r.text
    names = {a["name"]: a for a in r.json()}
    assert "review-assistant" in names
    return str(names["orchestrator"]["identity_user_id"])


@pytest.fixture(scope="module")
def pack(client: Any, admin: H) -> str:
    r = client.post("/api/v1/packs", headers=admin, json=bundle(_compliance()))
    assert r.status_code == 201, r.text
    return f"{COMP}@1.0.0"


def _project(client: Any, admin: H, tenant: dict[str, Any], pack: str, name: str) -> str:
    p = client.post(f"/api/v1/tenants/{tenant['id']}/projects", headers=admin, json={"name": name}).json()
    bp = {"apiVersion": "astra.blueprints/v1", "name": "review-fixture", "pattern": "same_family_upgrade",
          "source": {"adapter": "fixture-src@1.0.0"}, "target": {"adapter": "fixture-tgt@1.0.0"},
          "compliance_packs": [pack]}
    r = client.post(f"/api/v1/projects/{p['id']}/blueprint/versions", headers=admin,
                    json={"content": bp, "message": "Review fixture"})
    assert r.status_code in (200, 201), r.text
    return str(p["id"])


def _new(tenant_id: str, project_id: str, **kw: Any) -> str:
    base: dict[str, Any] = {"kind": "proposal", "title": "Item", "question": "Which way?",
                            "options": ["Yes", "No"], "owner_role": "customer_data_owner",
                            "requested_by": {"type": "system", "id": "system:test", "name": "test"},
                            "context": {}}
    base.update(kw)
    with session_scope() as s:
        item = reviews.new_item(s, tenant_id=uuid.UUID(tenant_id), project_id=uuid.UUID(project_id), **base)
        s.flush()
        return str(item.id)


def test_review_workbench(client: Any, admin: H, tenant_factory: Any, user_factory: Any, pack: str,
                          agent_identity: str) -> None:
    tenant = tenant_factory()
    pid = _project(client, admin, tenant, pack, "Review A")
    lead_h, _ = user_factory(("migration_lead", "project", pid))
    o1_h, o1 = user_factory(("customer_data_owner", "project", pid))
    o2_h, _ = user_factory(("customer_data_owner", "project", pid))
    sme_h, _ = user_factory(("data_sme", "project", pid))
    agent = {"type": "agent", "id": agent_identity, "name": "Orchestrator 1.0.0"}

    crit = _new(tenant["id"], pid, kind="decision", title="Archive closed records", subject_type="decision",
                options=["Migrate", "Archive"], requested_by=agent, agent_run_id=uuid.uuid4(),
                pattern=reviews.pattern_key("decision:orchestrator", "Archive closed records"),
                context={"why_needed": "Scope cannot be finished without it."})
    mapping = _new(tenant["id"], pid, title="Map premium code 7", subject_type="mapping", risk="low",
                   stream="data", segment="premium", pattern="test:mapping-premium")
    retire = _new(tenant["id"], pid, title="Retire 12 unused tables", subject_type="retirement", risk="high",
                  stream="data", confidence=0.9, pattern="test:retire",
                  evidence=[{"label": "Discovery run", "kind": "discovery_run", "ref": {"run_id": str(uuid.uuid4())}}])

    # ---- the queue: risk, then compliance impact, then low confidence; filters and facets
    q = client.get(f"/api/v1/projects/{pid}/review-queue", headers=o1_h).json()
    order = [i["id"] for i in q["items"]]
    assert order == [retire, crit, mapping] and q["total"] == 3
    by_id = {i["id"]: i for i in q["items"]}
    assert by_id[crit]["compliance"] == "critical" and by_id[crit]["compliance_controls"] == ["FXR-SOD-01"]
    assert by_id[crit]["required_approvals"] == 2 and by_id[mapping]["compliance"] == "relevant"
    assert by_id[retire]["compliance"] == "none" and by_id[retire]["priority_reasons"][0] == "high risk"
    assert q["facets"]["stream"] == {"data": 2} and q["facets"]["agent"] == {"Orchestrator 1.0.0": 1}
    only = client.get(f"/api/v1/projects/{pid}/review-queue", headers=o1_h,
                      params={"stream": "data", "segment": "premium"}).json()
    assert [i["id"] for i in only["items"]] == [mapping]
    by_agent = client.get(f"/api/v1/projects/{pid}/review-queue", headers=o1_h,
                          params={"agent": "Orchestrator 1.0.0"}).json()
    assert [i["id"] for i in by_agent["items"]] == [crit]
    assert client.get(f"/api/v1/projects/{pid}/review-queue", headers=sme_h, params={"mine": True}).json()["total"] == 0

    # ---- evidence panel: why, evidence links, assistant state, reviewers
    wb = client.get(f"/api/v1/review-items/{crit}/workbench", headers=o1_h).json()
    assert any("Scope cannot be finished" in w for w in wb["why"])
    assert any("FXR-SOD-01" in w for w in wb["why"])
    assert wb["assistant"]["pinned_version"] is None and wb["assistant"]["unavailable_reason"]
    assert {r["name"] for r in wb["reviewers"]} and all(r["id"] != agent_identity for r in wb["reviewers"])
    ask = client.post(f"/api/v1/review-items/{crit}/ask", headers=o1_h, json={"question": "Why was this raised?"})
    assert ask.status_code == 409 and "not pinned" in ask.json()["detail"]
    ev = client.get(f"/api/v1/review-items/{retire}/workbench", headers=o1_h).json()
    assert ev["item"]["evidence"][0]["kind"] == "discovery_run"

    # ---- compliance-critical: a named reviewer first, then two different people
    first = client.post(f"/api/v1/review-items/{crit}/decide", headers=o1_h, json={"action": "approve",
                                                                                    "option": "Archive"})
    assert first.status_code == 403 and "named reviewer" in first.json()["detail"]
    assert client.put(f"/api/v1/review-items/{crit}/reviewer", headers=o1_h,
                      json={"user_id": o1}).status_code == 403  # only a migration lead names reviewers
    bad = client.put(f"/api/v1/review-items/{crit}/reviewer", headers=lead_h, json={"user_id": agent_identity})
    assert bad.status_code == 422
    named = client.put(f"/api/v1/review-items/{crit}/reviewer", headers=lead_h, json={"user_id": o1})
    assert named.status_code == 200 and named.json()["owner_user_id"] == o1
    a1 = client.post(f"/api/v1/review-items/{crit}/decide", headers=o1_h,
                     json={"action": "approve", "option": "Archive", "note": "Retention allows it."}).json()
    assert a1["recorded"] == "approval_recorded" and a1["item"]["status"] == "open"
    assert len(a1["item"]["approvals"]) == 1
    again = client.post(f"/api/v1/review-items/{crit}/decide", headers=o1_h, json={"action": "approve",
                                                                                    "option": "Archive"})
    assert again.status_code == 403 and "second person" in again.json()["detail"]
    other = client.post(f"/api/v1/review-items/{crit}/decide", headers=o2_h, json={"action": "approve",
                                                                                    "option": "Migrate"})
    assert other.status_code == 409 and "first approver" in other.json()["detail"]
    a2 = client.post(f"/api/v1/review-items/{crit}/decide", headers=o2_h,
                     json={"action": "approve", "option": "Archive"}).json()
    assert a2["recorded"] == "approved" and a2["item"]["status"] == "resolved"
    assert a2["item"]["outcome"] == "approved" and len(a2["item"]["approvals"]) == 2

    # ---- reject needs a reason; a change to a rule-raised item needs the changed answer
    short = client.post(f"/api/v1/review-items/{mapping}/decide", headers=o1_h, json={"action": "reject",
                                                                                       "note": "no"})
    assert short.status_code == 422
    rej = client.post(f"/api/v1/review-items/{mapping}/decide", headers=o1_h,
                      json={"action": "reject", "note": "The code list is wrong; fix it at source."}).json()
    assert rej["item"]["status"] == "rejected" and rej["item"]["outcome"] == "rejected"
    no_value = client.post(f"/api/v1/review-items/{retire}/decide", headers=o1_h,
                           json={"action": "change", "note": "Keep two of them for audit."})
    assert no_value.status_code == 422
    ch = client.post(f"/api/v1/review-items/{retire}/decide", headers=o1_h, json={
        "action": "change", "note": "Keep two of them for audit.", "changed_value": "Retire 10, archive 2"}).json()
    assert ch["recorded"] == "changed" and ch["item"]["resolution"] == "Retire 10, archive 2"

    # ---- a change goes back to the agent with the note; here the agent is not pinned, which is reported
    agent_item = _new(tenant["id"], pid, kind="decision", title="Choose the cutover weekend",
                      subject_type="scope", requested_by=agent, agent_run_id=uuid.uuid4())
    back = client.post(f"/api/v1/review-items/{agent_item}/decide", headers=o1_h,
                       json={"action": "change", "note": "Avoid quarter end; propose April."}).json()
    assert back["recorded"] == "changes_requested" and back["item"]["status"] == "changes_requested"
    assert back["follow_up_error"]

    # ---- the requester cannot decide their own item
    own = _new(tenant["id"], pid, title="Own item", requested_by={"type": "user", "id": o1, "name": "Owner"})
    r = client.post(f"/api/v1/review-items/{own}/decide", headers=o1_h, json={"action": "approve", "option": "Yes"})
    assert r.status_code == 403 and "someone else" in r.json()["detail"]

    # ---- precedents: the same pattern in another project of the tenant shows source project and outcome
    pid2 = _project(client, admin, tenant, pack, "Review B")
    later = _new(tenant["id"], pid2, title="Map premium code 9", subject_type="mapping", pattern="test:mapping-premium")
    prec = client.get(f"/api/v1/review-items/{later}/workbench", headers=admin).json()["precedents"]
    assert prec["outcomes"] == {"rejected": 1}
    assert prec["items"][0]["project_name"] == "Review A" and prec["items"][0]["outcome"] == "rejected"
    assert prec["items"][0]["same_project"] is False

    # ---- audit trail
    acts = {e["action"] for e in client.get("/api/v1/audit", headers=admin,
                                            params={"project_id": pid, "action": "review."}).json()["items"]}
    assert {"review.approval_recorded", "review.approved", "review.rejected", "review.changed",
            "review.changes_requested", "review.reviewer_assigned"} <= acts


def test_database_enforces_approval_rules(client: Any, admin: H, tenant_factory: Any, user_factory: Any, pack: str,
                                          agent_identity: str) -> None:
    tenant = tenant_factory()
    pid = _project(client, admin, tenant, pack, "Review DB")
    _, person = user_factory(("customer_data_owner", "project", pid))
    item = _new(tenant["id"], pid, kind="decision", title="Two-person item", subject_type="decision",
                requested_by={"type": "user", "id": person, "name": "Requester"})
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    with eng.begin() as c:
        c.execute(text("UPDATE review_items SET owner_user_id = :u WHERE id = :i"), {"u": person, "i": item})
    for sql, params, needle in (
        ("UPDATE review_items SET status = 'resolved', outcome = 'approved' WHERE id = :i", {"i": item},
         "from different people"),
        ("INSERT INTO review_approvals(item_id, user_id, option, note) VALUES (:i, :u, 'Yes', '')",
         {"i": item, "u": agent_identity}, "agents propose, people decide"),
        ("INSERT INTO review_approvals(item_id, user_id, option, note) VALUES (:i, :u, 'Yes', '')",
         {"i": item, "u": person}, "cannot approve it"),
    ):
        with pytest.raises(Exception, match=needle), eng.begin() as c:
            c.execute(text(sql), params)
    crit = _new(tenant["id"], pid, kind="decision", title="Unnamed critical", subject_type="decision")
    with pytest.raises(Exception, match="named reviewer"), eng.begin() as c:
        c.execute(text("UPDATE review_items SET status = 'rejected', outcome = 'rejected' WHERE id = :i"),
                  {"i": crit})
    eng.dispose()


def test_review_assistant_can_only_read() -> None:
    m = parse(dict(catalog_files())["review-assistant.yaml"])
    assert m.tools == ["get_review_item", "get_review_precedents"] and m.data_access == "metadata_only"
    assert all(CATALOGUE[t].effect == Effect.READ_METADATA for t in m.tools)
    assert m.oversight.autonomy == "propose_only" and m.guardrails.max_delegation_depth == 0


def test_pattern_keys_ignore_names_and_numbers() -> None:
    a = reviews.pattern_key("conversion:trigger", "BEFORE trigger 'dbo.t1' has no equivalent at line 12")
    b = reviews.pattern_key("conversion:trigger", "BEFORE trigger 'dbo.other' has no equivalent at line 40")
    c = reviews.pattern_key("conversion:procedure", "BEFORE trigger 'dbo.t1' has no equivalent at line 12")
    assert a == b != c
