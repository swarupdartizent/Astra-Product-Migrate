"""E01.F2.S1 sign-in and tenant policy, E01.F2.S2 roles and partner isolation."""

from __future__ import annotations

import time
import uuid
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from tests.conftest import make_token

pytestmark = pytest.mark.integration


def _programme(client: Any, admin: dict[str, str]) -> dict[str, Any]:
    p = client.post("/api/v1/programmes", headers=admin, json={"name": f"Programme {uuid.uuid4().hex[:6]}"}).json()
    p1 = client.post(f"/api/v1/programmes/{p['id']}/partners", headers=admin, json={"name": "Partner One"}).json()
    p2 = client.post(f"/api/v1/programmes/{p['id']}/partners", headers=admin, json={"name": "Partner Two"}).json()
    return {"programme": p, "p1": p1, "p2": p2}


# ---------------------------------------------------------------- tokens

@pytest.mark.parametrize("case", ["wrong_audience", "untrusted_issuer", "expired", "wrong_key", "garbage"])
def test_invalid_tokens_are_rejected(client: Any, case: str) -> None:
    email = "nobody@example.com"
    token = {
        "wrong_audience": lambda: make_token(email, audience="other-api"),
        "untrusted_issuer": lambda: make_token(email, issuer="http://evil.example"),
        "expired": lambda: make_token(email, expires_in=-120),
        "wrong_key": lambda: make_token(email, key=rsa.generate_private_key(public_exponent=65537, key_size=2048)),
        "garbage": lambda: "not-a-token",
    }[case]()
    r = client.get("/api/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
    assert r.json()["type"] == "/problems/invalid-token"


def test_unsigned_token_is_rejected(client: Any) -> None:
    now = int(time.time())
    t = jwt.encode({"iss": "x", "sub": "s", "aud": "astra-api", "iat": now, "exp": now + 60}, key=None,
                   algorithm="none")
    assert client.get("/api/v1/me", headers={"Authorization": f"Bearer {t}"}).status_code == 401


def test_no_token_is_401(client: Any) -> None:
    r = client.get("/api/v1/me")
    assert r.status_code == 401 and r.headers["www-authenticate"].startswith("Bearer")


# ---------------------------------------------------------------- tenant policy

def test_tenant_requires_mfa_when_policy_says_so(tenant_factory: Any, user_factory: Any, client: Any) -> None:
    t = tenant_factory(mfa_required=True)
    no_mfa, _ = user_factory(("migration_lead", "tenant", t["id"]), mfa=False)
    with_mfa, _ = user_factory(("migration_lead", "tenant", t["id"]), mfa=True)
    r = client.get(f"/api/v1/tenants/{t['id']}", headers=no_mfa)
    assert r.status_code == 403 and r.json()["type"] == "/problems/mfa-required"
    assert client.get(f"/api/v1/tenants/{t['id']}", headers=with_mfa).status_code == 200


def test_session_timeout_is_per_tenant(tenant_factory: Any, user_factory: Any, client: Any) -> None:
    strict = tenant_factory(session_timeout_minutes=15)
    relaxed = tenant_factory(session_timeout_minutes=480)
    h, _ = user_factory(("migration_lead", "tenant", strict["id"]), ("migration_lead", "tenant", relaxed["id"]),
                        auth_age_s=30 * 60)
    r = client.get(f"/api/v1/tenants/{strict['id']}", headers=h)
    assert r.status_code == 401 and r.json()["type"] == "/problems/session-expired"
    assert client.get(f"/api/v1/tenants/{relaxed['id']}", headers=h).status_code == 200


def test_loosening_policy_needs_reason_and_is_audited(tenant_factory: Any, client: Any,
                                                      admin: dict[str, str]) -> None:
    t = tenant_factory()
    r = client.put(f"/api/v1/tenants/{t['id']}/policy", headers=admin,
                   json={"mfa_required": False, "session_timeout_minutes": 480})
    assert r.status_code == 422 and r.json()["type"] == "/problems/reason-required"
    r = client.put(f"/api/v1/tenants/{t['id']}/policy", headers=admin,
                   json={"mfa_required": False, "session_timeout_minutes": 480,
                         "reason": "customer IdP enforces MFA upstream"})
    assert r.status_code == 200 and r.json()["mfa_required"] is False
    ev = client.get("/api/v1/audit", headers=admin, params={"tenant_id": t["id"], "action": "tenant.policy"}).json()
    assert ev["items"][0]["details"]["loosened"] is True


# ---------------------------------------------------------------- roles and partner isolation

def test_partner_sees_only_its_own_customers(client: Any, admin: dict[str, str], tenant_factory: Any,
                                             user_factory: Any) -> None:
    prog = _programme(client, admin)
    t1 = tenant_factory(partner_id=prog["p1"]["id"])
    t2 = tenant_factory(partner_id=prog["p2"]["id"])
    lead1, _ = user_factory(("partner_delivery_lead", "partner", prog["p1"]["id"]))
    owner, _ = user_factory(("programme_owner", "programme", prog["programme"]["id"]))

    ids = {t["id"] for t in client.get("/api/v1/tenants", headers=lead1).json()}
    assert t1["id"] in ids and t2["id"] not in ids
    assert client.get(f"/api/v1/tenants/{t2['id']}", headers=lead1).status_code == 404  # existence not disclosed
    owner_ids = {t["id"] for t in client.get("/api/v1/tenants", headers=owner).json()}
    assert {t1["id"], t2["id"]} <= owner_ids

    audit_lead1 = client.get("/api/v1/audit", headers=lead1).json()["items"]
    assert all(e["tenant_id"] in (None, t1["id"]) for e in audit_lead1)
    assert not any(e["tenant_id"] == t2["id"] for e in audit_lead1)
    assert client.get("/api/v1/audit", headers=lead1, params={"tenant_id": t2["id"]}).status_code == 404


def test_grants_stay_inside_managed_scope_and_are_audited(client: Any, admin: dict[str, str],
                                                          user_factory: Any) -> None:
    prog = _programme(client, admin)
    lead1, _ = user_factory(("partner_delivery_lead", "partner", prog["p1"]["id"]))
    _, target = user_factory()
    ok = client.post("/api/v1/role-assignments", headers=lead1,
                     json={"user_id": target, "role": "data_sme", "scope_type": "partner",
                           "scope_id": prog["p1"]["id"]})
    assert ok.status_code == 201, ok.text
    denied = client.post("/api/v1/role-assignments", headers=lead1,
                         json={"user_id": target, "role": "data_sme", "scope_type": "partner",
                               "scope_id": prog["p2"]["id"]})
    assert denied.status_code == 403
    escalate = client.post("/api/v1/role-assignments", headers=lead1,
                           json={"user_id": target, "role": "platform_admin", "scope_type": "platform",
                                 "scope_id": None})
    assert escalate.status_code in (403, 422)

    events = client.get("/api/v1/audit", headers=admin, params={"action": "access.role_gr"}).json()["items"]
    mine = [e for e in events if e["target_id"] == target]
    assert {e["action"] for e in mine} >= {"access.role_granted", "access.role_grant_denied"}

    revoke = client.delete(f"/api/v1/role-assignments/{ok.json()['id']}", headers=lead1)
    assert revoke.status_code == 204
    revoked = client.get("/api/v1/audit", headers=admin, params={"action": "access.role_revoked"}).json()["items"]
    assert any(e["target_id"] == target for e in revoked)


def test_role_scope_rules_are_enforced(client: Any, admin: dict[str, str], user_factory: Any) -> None:
    _, uid = user_factory()
    r = client.post("/api/v1/role-assignments", headers=admin,
                    json={"user_id": uid, "role": "customer_data_owner", "scope_type": "platform", "scope_id": None})
    assert r.status_code == 422


def test_every_backlog_role_exists(client: Any, admin: dict[str, str]) -> None:
    keys = {r["key"] for r in client.get("/api/v1/roles", headers=admin).json()}
    assert keys >= {"migration_lead", "data_sme", "solution_architect", "customer_data_owner", "programme_owner",
                    "partner_delivery_lead", "ontology_curator", "compliance_curator", "sales_engineer",
                    "commercial_manager", "reviewer", "test_engineer", "auditor", "platform_admin",
                    "platform_engineer", "pack_developer", "customer_it_security_lead",
                    "customer_operations_manager"}


def test_invited_user_is_linked_only_with_verified_email(client: Any, admin: dict[str, str]) -> None:
    email = f"invitee-{uuid.uuid4().hex[:8]}@example.com"
    inv = client.post("/api/v1/users", headers=admin, json={"email": email, "display_name": "Invitee"})
    assert inv.status_code == 201 and inv.json()["status"] == "invited"
    unverified = make_token(email, email_verified=False, sub="s-" + uuid.uuid4().hex)
    r = client.get("/api/v1/me", headers={"Authorization": f"Bearer {unverified}"})
    assert r.status_code == 403 and r.json()["type"] == "/problems/email-unverified"
    verified = make_token(email, sub="s-" + uuid.uuid4().hex)
    me = client.get("/api/v1/me", headers={"Authorization": f"Bearer {verified}"})
    assert me.status_code == 200 and me.json()["id"] == inv.json()["id"]
