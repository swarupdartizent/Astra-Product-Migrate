"""I2: pack registry (E04), control types (E07.F1.S1) and blueprints (E03).

Packs here are test fixtures with generic names. Packs are global and immutable, so every test
uses a unique name suffix.
"""

from __future__ import annotations

import base64
import uuid
from collections.abc import Callable
from typing import Any

import pytest
import yaml
from sqlalchemy import create_engine, text

from astra_migrate.config import get_settings

pytestmark = pytest.mark.integration
H = dict[str, str]


def _b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


def manifest(name: str, ptype: str, version: str = "1.0.0", **kw: Any) -> dict[str, Any]:
    m: dict[str, Any] = {
        "apiVersion": "astra.packs/v1",
        "type": ptype,
        "name": name,
        "version": version,
        "title": f"Fixture {name}",
        "publisher": "Test fixtures",
    }
    if ptype == "compliance":
        m["disclaimer"] = "Supports, but does not certify, compliance. Test fixture."
    m.update(kw)
    return m


def control(cid: str, ctype: str = "evidence", **kw: Any) -> dict[str, Any]:
    c = {
        "id": cid,
        "type": ctype,
        "title": f"Control {cid}",
        "rule": "Something must hold",
        "evidence_required": "A record that proves it",
        "sources": [{"reference": "Fixture clause 1"}],
    }
    c.update(kw)
    return c


def setting(key: str, value: Any, stricter: str, **kw: Any) -> dict[str, Any]:
    return {"key": key, "value": value, "stricter": stricter, **kw}


@pytest.fixture
def publish(client: Any, admin: H) -> Callable[..., dict[str, Any]]:
    def go(m: dict[str, Any], *, review: bool = True, expect: int = 200) -> dict[str, Any]:
        r = client.post("/api/v1/packs", headers=admin, json={"files": {"pack.yaml": _b64(yaml.safe_dump(m))}})
        assert r.status_code == 201, r.text
        if review and m["type"] == "compliance":
            rv = client.post(
                f"/api/v1/packs/{m['name']}/{m['version']}/review",
                headers=admin,
                json={"reviewer_name": "Pat Example", "reviewer_role": "Compliance specialist (test)"},
            )
            assert rv.status_code == 200, rv.text
        p = client.post(f"/api/v1/packs/{m['name']}/{m['version']}/publish", headers=admin)
        assert p.status_code == expect, p.text
        return dict(p.json())

    return go


@pytest.fixture
def stack(publish: Callable[..., dict[str, Any]]) -> dict[str, str]:
    """A published set of fixture packs, unique to the test."""
    sfx = uuid.uuid4().hex[:6]
    n = {k: f"fx-{k}-{sfx}" for k in ("core", "src", "tgt", "ca", "cb")}
    publish(manifest(n["core"], "domain", adds={"rules": [{"id": "CORE-R1", "statement": "Terms end after start"}]}))
    publish(manifest(n["src"], "source_adapter"))
    publish(manifest(n["tgt"], "target_adapter"))
    publish(
        manifest(
            n["ca"],
            "compliance",
            requires=[{"name": n["core"], "versions": ">=1.0,<2"}],
            adds={
                "controls": [
                    control("CA-EV-01"),
                    control("CA-GT-01", "gate", gate="cutover"),
                    control("CA-DH-01", "data_handling"),
                    control("CA-RT-01", "retention"),
                    control(
                        "CA-AP-01",
                        "approval",
                        parameters={"applies_to": "financial_mapping"},
                        compliance_critical=True,
                        two_person_approval=True,
                    ),
                ],
                "settings": [
                    setting("retention.records.years", 7, "higher", unit="years"),
                    setting("masking.non_production", True, "true"),
                ],
            },
        )
    )
    publish(
        manifest(
            n["cb"],
            "compliance",
            adds={
                "controls": [control("CB-EV-01")],
                "settings": [setting("retention.records.years", 10, "higher", unit="years")],
            },
        )
    )
    return n


def blueprint(n: dict[str, str], **over: Any) -> dict[str, Any]:
    bp: dict[str, Any] = {
        "apiVersion": "astra.blueprints/v1",
        "name": "fixture-estate",
        "pattern": "same_family_upgrade",
        "source": {"adapter": f"{n['src']}@1.0.0", "connection": "secret://legacy-reader"},
        "target": {"adapter": f"{n['tgt']}@1.0.0", "load_method": "vendor-api"},
        "domain_packs": [f"{n['core']}@1.0.0"],
        "compliance_packs": [f"{n['ca']}@1.0.0"],
        "constraints": {
            "cutover_window": "weekend, max 36h",
            "freeze_periods": [{"start": "2027-03-01", "end": "2027-03-15", "reason": "Quarter end"}],
        },
        "planning": {"max_task_hours": 40, "risk_appetite": "low"},
    }
    bp.update(over)
    return bp


@pytest.fixture
def project(client: Any, admin: H, tenant_factory: Any) -> dict[str, Any]:
    t = tenant_factory()
    r = client.post(f"/api/v1/tenants/{t['id']}/projects", headers=admin, json={"name": "Estate upgrade"})
    assert r.status_code == 201, r.text
    return {"tenant": t, **r.json()}


def save(client: Any, h: H, pid: str, content: dict[str, Any], msg: str = "Initial blueprint") -> Any:
    return client.post(
        f"/api/v1/projects/{pid}/blueprint/versions", headers=h, json={"content": content, "message": msg}
    )


# ===================================================================== packs


def test_pack_with_failing_tests_cannot_be_published(client: Any, admin: H, publish: Any) -> None:
    m = manifest(
        f"fx-fail-{uuid.uuid4().hex[:6]}",
        "domain",
        tests=[{"name": "has a control it does not have", "kind": "contains_control", "id": "NOPE-1"}],
    )
    r = publish(m, expect=422)
    assert r["type"] == "/problems/pack-invalid" and r["errors"]
    detail = client.get(f"/api/v1/packs/{m['name']}/1.0.0", headers=admin).json()
    assert detail["status"] == "draft" and detail["tests_passed"] is False
    refused = client.get("/api/v1/audit", headers=admin, params={"action": "pack.publish_refused"}).json()["items"]
    assert any(e["details"]["ref"] == f"{m['name']}@1.0.0" for e in refused)


def test_missing_dependency_fails_tests(publish: Any) -> None:
    m = manifest(f"fx-dep-{uuid.uuid4().hex[:6]}", "domain", requires=[{"name": "fx-does-not-exist"}])
    assert "fx-does-not-exist" in str(publish(m, expect=422))


def test_compliance_pack_needs_named_review_and_disclaimer(client: Any, admin: H, publish: Any) -> None:
    m = manifest(f"fx-rev-{uuid.uuid4().hex[:6]}", "compliance", adds={"controls": [control("RV-EV-01")]})
    r = publish(m, review=False, expect=422)
    assert "reviewed" in r["title"]
    no_disclaimer = {**m, "name": m["name"] + "-x", "disclaimer": "Nothing to see"}
    bad = client.post(
        "/api/v1/packs", headers=admin, json={"files": {"pack.yaml": _b64(yaml.safe_dump(no_disclaimer))}}
    )
    assert bad.status_code == 422 and "certify" in bad.text


def test_published_pack_is_immutable(client: Any, admin: H, publish: Any) -> None:
    m = manifest(f"fx-imm-{uuid.uuid4().hex[:6]}", "domain")
    publish(m)
    changed = {**m, "title": "Changed after publishing"}
    r = client.post("/api/v1/packs", headers=admin, json={"files": {"pack.yaml": _b64(yaml.safe_dump(changed))}})
    assert r.status_code == 422 and "cannot change" in r.text
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    with pytest.raises(Exception, match="immutable"), eng.begin() as c:
        c.execute(text("update packs set title='x', manifest='{}'::jsonb where name=:n"), {"n": m["name"]})
    eng.dispose()


def test_packs_can_only_add_never_remove(client: Any, admin: H) -> None:
    m = manifest(
        f"fx-rm-{uuid.uuid4().hex[:6]}",
        "compliance",
        adds={"controls": [control("RM-EV-01")]},
        removes={"controls": ["OTHER-1"]},
    )
    r = client.post("/api/v1/packs", headers=admin, json={"files": {"pack.yaml": _b64(yaml.safe_dump(m))}})
    assert r.status_code == 422 and any(e["field"] == "removes" for e in r.json()["errors"])
    d = manifest(f"fx-dc-{uuid.uuid4().hex[:6]}", "domain", adds={"controls": [control("DC-EV-01")]})
    r2 = client.post("/api/v1/packs", headers=admin, json={"files": {"pack.yaml": _b64(yaml.safe_dump(d))}})
    assert r2.status_code == 422 and "Only compliance packs" in r2.text


def test_composition_shows_stricter_value_and_placements(client: Any, admin: H, stack: dict[str, str]) -> None:
    comp = client.post(
        "/api/v1/packs/compose",
        headers=admin,
        json={"packs": [f"{stack['core']}@1.0.0", f"{stack['ca']}@1.0.0", f"{stack['cb']}@1.0.0"]},
    ).json()
    ret = next(s for s in comp["settings"] if s["key"] == "retention.records.years")
    assert ret["conflict"] is True and ret["strictest"] == 10
    keys = {c["key"] for c in comp["controls"]}
    assert {f"{stack['ca']}:CA-EV-01", f"{stack['cb']}:CB-EV-01"} <= keys  # both packs' controls kept
    placements = {c["type"]: c["placement"]["area"] for c in comp["controls"]}
    assert placements == {
        "evidence": "proof_pack",
        "gate": "lifecycle_gate",
        "data_handling": "tasks",
        "retention": "decommission",
        "approval": "review_rules",
    }
    types = client.get("/api/v1/packs/control-types", headers=admin).json()
    assert {t["type"] for t in types} == {"data_handling", "approval", "gate", "evidence", "residency", "retention"}


def test_pack_version_diff(client: Any, admin: H, publish: Any) -> None:
    name = f"fx-diff-{uuid.uuid4().hex[:6]}"
    base = {"controls": [control("DF-EV-01")], "settings": [setting("retention.records.years", 7, "higher")]}
    publish(manifest(name, "compliance", adds=base))
    publish(
        manifest(
            name,
            "compliance",
            version="1.1.0",
            adds={
                "controls": [control("DF-EV-01"), control("DF-GT-01", "gate", gate="plan")],
                "settings": [setting("retention.records.years", 8, "higher")],
            },
        )
    )
    d = client.get(
        f"/api/v1/packs/{name}/diff", headers=admin, params={"from_version": "1.0.0", "to_version": "1.1.0"}
    ).json()
    assert [c["id"] for c in d["controls"]["added"]] == ["DF-GT-01"]
    assert d["settings"]["changed"][0]["after"]["value"] == 8


# ===================================================================== blueprints


def test_form_and_file_stay_in_sync(client: Any, admin: H, stack: dict[str, str]) -> None:
    content = blueprint(stack)
    y = client.post("/api/v1/blueprints/convert", headers=admin, json={"content": content}).json()
    back = client.post("/api/v1/blueprints/convert", headers=admin, json={"yaml_text": y["yaml_text"]}).json()
    assert back["content"] == content


def test_blueprint_versions_are_in_git_with_reasons_and_diffs(
    client: Any, admin: H, project: dict[str, Any], stack: dict[str, str]
) -> None:
    pid = project["id"]
    v1 = save(client, admin, pid, blueprint(stack), "First draft from discovery workshop")
    assert v1.status_code == 201, v1.text
    assert v1.json()["git_verified"] is True and len(v1.json()["commit_sha"]) == 40
    v2 = save(
        client,
        admin,
        pid,
        blueprint(
            stack,
            compliance_packs=[f"{stack['ca']}@1.0.0", f"{stack['cb']}@1.0.0"],
            planning={"max_task_hours": 32, "risk_appetite": "low"},
        ),
        "Add second compliance pack after legal review",
    )
    assert v2.json()["number"] == 2
    d = client.get(
        f"/api/v1/projects/{pid}/blueprint/diff", headers=admin, params={"from_version": 1, "to_version": 2}
    ).json()
    assert any(a["path"] == f"compliance_packs[{stack['cb']}@1.0.0]" for a in d["added"])
    assert any(c["path"] == "planning.max_task_hours" and c["before"] == 40 and c["after"] == 32 for c in d["changed"])
    assert d["to"]["message"] == "Add second compliance pack after legal review" and d["to"]["author_name"]
    versions = client.get(f"/api/v1/projects/{pid}/blueprint/versions", headers=admin).json()
    assert [v["status"] for v in versions] == ["draft", "superseded"]
    same = save(
        client,
        admin,
        pid,
        blueprint(
            stack,
            compliance_packs=[f"{stack['ca']}@1.0.0", f"{stack['cb']}@1.0.0"],
            planning={"max_task_hours": 32, "risk_appetite": "low"},
        ),
        "no change",
    )
    assert same.status_code == 422


def test_validation_explains_problems_in_plain_language(
    client: Any, admin: H, project: dict[str, Any], stack: dict[str, str]
) -> None:
    bad = blueprint(
        stack,
        domain_packs=[f"{stack['src']}@1.0.0"],
        compliance_packs=["fx-nowhere@9.9.9"],
        planning={"max_task_hours": 80},
    )
    bad.pop("pattern")
    r = client.post(f"/api/v1/projects/{project['id']}/blueprint/validate", headers=admin, json={"content": bad})
    issues = r.json()["issues"]
    assert any(i["path"] == "pattern" for i in issues)
    assert any(i["path"] == "planning.max_task_hours" for i in issues)
    assert all(i["message"] and i["fix"] for i in issues)
    ok_shape = blueprint(
        stack, domain_packs=[f"{stack['src']}@1.0.0"], compliance_packs=[f"{stack['ca']}@1.0.0", "fx-nowhere@9.9.9"]
    )
    r2 = client.post(
        f"/api/v1/projects/{project['id']}/blueprint/validate", headers=admin, json={"content": ok_shape}
    ).json()
    codes = {i["code"] for i in r2["issues"]}
    # wrong slot, unpublished pack, the domain pack the compliance pack needs is missing, and the
    # source adapter is now pinned twice
    assert {"pack.wrong_type", "pack.not_published", "compose.missing_requirement", "compose.duplicate_pack"} <= codes
    assert any(i["code"] == "connection.missing_secret" and i["severity"] == "warning" for i in r2["issues"])
    gate = client.get(f"/api/v1/projects/{project['id']}/planning-gate", headers=admin).json()
    assert gate["ready"] is False


def test_conflicts_need_a_person_and_no_default_is_applied(
    client: Any, admin: H, project: dict[str, Any], stack: dict[str, str], user_factory: Any
) -> None:
    pid = project["id"]
    content = blueprint(stack, compliance_packs=[f"{stack['ca']}@1.0.0", f"{stack['cb']}@1.0.0"])
    v = save(client, admin, pid, content).json()
    assert any(i["code"] == "conflict.undecided" for i in v["validation"]["issues"])
    dec = client.get(f"/api/v1/projects/{pid}/decisions", headers=admin).json()
    conflict = next(d for d in dec if d["kind"] == "setting_conflict")
    assert conflict["status"] == "open" and conflict["context"]["strictest"] == 10
    assert {x["pack"].split("@")[0] for x in conflict["context"]["values"]} == {stack["ca"], stack["cb"]}

    curator, _ = user_factory(("compliance_curator", "tenant", project["tenant"]["id"]))
    r = client.post(
        f"/api/v1/decisions/{conflict['id']}",
        headers=curator,
        json={"chosen_value": 10, "reason": "Take the longer retention required by the stricter pack"},
    )
    assert r.status_code == 200 and r.json()["status"] == "decided"
    again = client.get(f"/api/v1/projects/{pid}/blueprint/versions/1", headers=admin).json()
    assert not any(i["code"] == "conflict.undecided" for i in again["validation"]["issues"])
    ev = client.get("/api/v1/audit", headers=admin, params={"project_id": pid, "action": "decision."}).json()["items"]
    assert ev[0]["details"]["chosen"] == 10 and ev[0]["details"]["reason"].startswith("Take the longer")


def test_loosening_needs_a_named_approver_other_than_the_requester(
    client: Any, admin: H, project: dict[str, Any], stack: dict[str, str], user_factory: Any
) -> None:
    pid, tid = project["id"], project["tenant"]["id"]
    lead, _ = user_factory(("migration_lead", "tenant", tid), ("compliance_curator", "tenant", tid))
    tighten = blueprint(
        stack,
        overrides=[
            {"setting": "retention.records.years", "value": 9, "reason": "Customer policy keeps records longer"}
        ],
    )
    v1 = save(client, lead, pid, tighten).json()
    assert not any(i["code"].startswith("override.") for i in v1["validation"]["issues"])

    loosen = blueprint(
        stack,
        overrides=[
            {
                "setting": "retention.records.years",
                "value": 5,
                "reason": "Records older than five years are archived elsewhere",
            }
        ],
    )
    v2 = save(client, lead, pid, loosen, "Loosen retention per customer archive").json()
    assert any(i["code"] == "override.loosening_unapproved" for i in v2["validation"]["issues"])
    d = next(
        x for x in client.get(f"/api/v1/projects/{pid}/decisions", headers=lead).json() if x["kind"] == "loosening"
    )
    own = client.post(
        f"/api/v1/decisions/{d['id']}",
        headers=lead,
        json={"approve": True, "reason": "Approving my own request should fail"},
    )
    assert own.status_code == 422 and "someone other" in own.text
    sec, _ = user_factory(("customer_it_security_lead", "tenant", tid))
    ok = client.post(
        f"/api/v1/decisions/{d['id']}",
        headers=sec,
        json={"approve": True, "reason": "Archive system keeps older records under legal hold"},
    )
    assert ok.status_code == 200
    after = client.get(f"/api/v1/projects/{pid}/blueprint/versions/2", headers=lead).json()
    assert not any(i["code"] == "override.loosening_unapproved" for i in after["validation"]["issues"])


def test_residency_control_blocks_project_in_non_compliant_region(
    client: Any, admin: H, project: dict[str, Any], publish: Any, stack: dict[str, str]
) -> None:
    res = f"fx-res-{uuid.uuid4().hex[:6]}"
    publish(
        manifest(
            res,
            "compliance",
            adds={
                "controls": [
                    control("RS-RS-01", "residency", parameters={"allowed_jurisdictions": ["eu"]}),
                    control("RS-RS-02", "residency", parameters={"model_calls_in_region": True}),
                ]
            },
        )
    )
    r = client.post(
        f"/api/v1/projects/{project['id']}/blueprint/validate",
        headers=admin,
        json={"content": blueprint(stack, compliance_packs=[f"{stack['ca']}@1.0.0", f"{res}@1.0.0"])},
    ).json()
    codes = {i["code"] for i in r["issues"] if i["severity"] == "blocking"}
    assert {"residency.region", "residency.model_endpoint"} <= codes


def test_dual_approval_locks_version_and_changes_need_new_approval(
    client: Any, admin: H, project: dict[str, Any], stack: dict[str, str], user_factory: Any
) -> None:
    pid, tid = project["id"], project["tenant"]["id"]
    lead, _ = user_factory(("migration_lead", "tenant", tid))
    owner, _ = user_factory(("customer_data_owner", "project", pid))
    assert save(client, lead, pid, blueprint(stack)).status_code == 201

    denied = client.post(f"/api/v1/projects/{pid}/blueprint/versions/1/decision", headers=admin, json={"approve": True})
    assert denied.status_code == 422 and "approver role" in denied.text  # admins are not implicit approvers

    a1 = client.post(f"/api/v1/projects/{pid}/blueprint/versions/1/decision", headers=lead, json={"approve": True})
    assert a1.status_code == 200 and a1.json()["status"] == "draft"
    a2 = client.post(
        f"/api/v1/projects/{pid}/blueprint/versions/1/decision",
        headers=owner,
        json={"approve": True, "reason": "Matches our data decisions"},
    )
    assert a2.status_code == 200 and a2.json()["status"] == "approved"
    assert {a["role"] for a in a2.json()["approvals"]} == {"migration_lead", "customer_data_owner"}
    assert client.get(f"/api/v1/projects/{pid}/planning-gate", headers=lead).json()["ready"] is True

    eng = create_engine(get_settings().control_db_url.get_secret_value())
    with pytest.raises(Exception, match="cannot be changed"), eng.begin() as c:
        c.execute(text("update blueprint_versions set yaml_text='x' where project_id=:p and number=1"), {"p": pid})
    eng.dispose()

    v2 = save(client, lead, pid, blueprint(stack, cutover_strategy="whole_estate"), "Choose whole-estate cutover")
    assert v2.json()["status"] == "draft"
    statuses = {
        v["number"]: v["status"] for v in client.get(f"/api/v1/projects/{pid}/blueprint/versions", headers=lead).json()
    }
    assert statuses == {1: "approved", 2: "draft"}
    for h in (lead, owner):
        client.post(f"/api/v1/projects/{pid}/blueprint/versions/2/decision", headers=h, json={"approve": True})
    statuses = {
        v["number"]: v["status"] for v in client.get(f"/api/v1/projects/{pid}/blueprint/versions", headers=lead).json()
    }
    assert statuses == {1: "superseded", 2: "approved"}


def test_project_grant_is_limited_to_its_project(
    client: Any, admin: H, project: dict[str, Any], user_factory: Any
) -> None:
    tid = project["tenant"]["id"]
    other = client.post(f"/api/v1/tenants/{tid}/projects", headers=admin, json={"name": "Other project"}).json()
    owner, _ = user_factory(("customer_data_owner", "project", project["id"]))
    assert client.get(f"/api/v1/projects/{project['id']}", headers=owner).status_code == 200
    assert client.get(f"/api/v1/projects/{other['id']}", headers=owner).status_code == 404
    listed = {p["id"] for p in client.get(f"/api/v1/tenants/{tid}/projects", headers=owner).json()}
    assert listed == {project["id"]}


def test_template_creates_first_version(client: Any, admin: H, tenant_factory: Any, stack: dict[str, str]) -> None:
    name = f"tpl-{uuid.uuid4().hex[:6]}"
    r = client.post(
        "/api/v1/blueprint-templates",
        headers=admin,
        json={"name": name, "title": "Fixture template", "yaml_text": yaml.safe_dump(blueprint(stack))},
    )
    assert r.status_code == 201
    t = tenant_factory()
    p = client.post(
        f"/api/v1/tenants/{t['id']}/projects", headers=admin, json={"name": "From template", "template": name}
    ).json()
    assert p["latest_version"]["number"] == 1 and p["latest_version"]["template"] == name
