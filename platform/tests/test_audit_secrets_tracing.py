"""E01.F3.S1 write-once audit, E01.F2.S3 vault secrets, E01.F3.S2 tracing."""

from __future__ import annotations

import io
import json
import logging
import os
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from astra_migrate import audit, connector_secrets
from astra_migrate.config import get_settings
from astra_migrate.db.models import Tenant
from astra_migrate.logging import JsonFormatter
from astra_migrate.vault import get_vault

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------- audit

@pytest.mark.parametrize("stmt", [
    "update audit_events set actor_name = 'mallory' where seq = (select max(seq) from audit_events)",
    "delete from audit_events where seq = (select max(seq) from audit_events)",
    "truncate audit_events",
])
def test_runtime_role_cannot_change_audit(client: Any, admin: dict[str, str], stmt: str) -> None:
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    with pytest.raises(DBAPIError), eng.begin() as c:
        c.execute(text(stmt))
    eng.dispose()


def test_even_database_superuser_cannot_change_audit_through_sql(client: Any, admin: dict[str, str]) -> None:
    eng = create_engine(os.environ["ASTRA_TEST_ROOT_DB_URL"])
    with pytest.raises(DBAPIError, match="write-once"), eng.begin() as c:
        c.execute(text("update audit_events set outcome='success' where seq = (select max(seq) from audit_events)"))
    eng.dispose()


def test_hash_chain_detects_tampering(client: Any, admin: dict[str, str]) -> None:
    ok = client.post("/api/v1/audit/verify", headers=admin).json()
    assert ok["ok"] is True, ok["problems"]
    assert ok["anchored_seq"] == ok["head_seq"]

    # A database superuser bypasses the triggers inside a transaction that is rolled back.
    eng = create_engine(os.environ["ASTRA_TEST_ROOT_DB_URL"])
    with eng.connect() as c:
        tx = c.begin()
        c.execute(text("alter table audit_events disable trigger audit_events_no_update"))
        c.execute(text("update audit_events set actor_name = 'mallory' where seq = 2"))
        res = audit.verify_chain(Session(bind=c), get_vault())
        tx.rollback()
    eng.dispose()
    assert res.ok is False
    assert any("Record 2" in p and "altered" in p for p in res.problems)


def test_forged_hash_values_are_overwritten_by_database(client: Any, admin: dict[str, str]) -> None:
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    with eng.begin() as c:
        c.execute(text("insert into audit_events(seq, occurred_at, actor_type, actor_id, actor_name, action, outcome,"
                       " details, prev_hash, hash) values (999999999, '2000-01-01', 'user', 'x', 'x', 'forge.test',"
                       " 'success', '{}', 'forged', 'forged-hash')"))
        row = c.execute(text("select seq, prev_hash, hash, occurred_at from audit_events "
                             "where action='forge.test' order by seq desc limit 1")).one()
    eng.dispose()
    assert row.seq != 999999999 and row.hash != "forged-hash" and row.prev_hash != "forged"
    assert row.occurred_at.year > 2000


def test_audit_filters_and_export(client: Any, admin: dict[str, str], tenant_factory: Any) -> None:
    t = tenant_factory()
    me = client.get("/api/v1/me", headers=admin).json()
    page = client.get("/api/v1/audit", headers=admin, params={"tenant_id": t["id"], "actor_id": me["id"]}).json()
    assert page["items"] and all(e["tenant_id"] == t["id"] and e["actor_id"] == me["id"] for e in page["items"])
    sys_events = client.get("/api/v1/audit", headers=admin, params={"actor_type": "system"}).json()["items"]
    assert all(e["actor_type"] == "system" for e in sys_events)

    csv_r = client.get("/api/v1/audit/export", headers=admin, params={"format": "csv", "tenant_id": t["id"]})
    assert csv_r.status_code == 200 and csv_r.headers["content-type"].startswith("text/csv")
    lines = csv_r.text.strip().splitlines()
    assert lines[0].startswith("seq,occurred_at") and len(lines) >= 3
    jl = client.get("/api/v1/audit/export", headers=admin, params={"format": "jsonl", "tenant_id": t["id"]})
    rows = [json.loads(x) for x in jl.text.strip().splitlines()]
    assert all(r["tenant_id"] == t["id"] for r in rows)
    exported = client.get("/api/v1/audit", headers=admin, params={"action": "audit.exported"}).json()["items"]
    assert exported, "exports are themselves audited"


def test_pagination(client: Any, admin: dict[str, str]) -> None:
    first = client.get("/api/v1/audit", headers=admin, params={"limit": 2}).json()
    assert len(first["items"]) == 2 and first["next_before_seq"]
    second = client.get("/api/v1/audit", headers=admin, params={"limit": 2, "before_seq": first["next_before_seq"]})
    assert second.json()["items"][0]["seq"] < first["items"][-1]["seq"]


# ---------------------------------------------------------------- secrets

def test_secrets_are_write_only_rotatable_and_never_logged(client: Any, admin: dict[str, str],
                                                           tenant_factory: Any) -> None:
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)
    old_level = root.level
    root.setLevel(logging.DEBUG)
    try:
        t = tenant_factory()
        v1, v2 = "Sup3r-" + uuid.uuid4().hex, "R0tated-" + uuid.uuid4().hex
        r = client.post(f"/api/v1/tenants/{t['id']}/secrets", headers=admin,
                        json={"name": "legacy-db-reader", "description": "read-only source login", "value": v1})
        assert r.status_code == 201, r.text
        sec = r.json()
        assert v1 not in r.text and sec["reference"] == "secret://legacy-db-reader" and sec["current_version"] == 1
        listing = client.get(f"/api/v1/tenants/{t['id']}/secrets", headers=admin)
        assert v1 not in listing.text

        rot = client.post(f"/api/v1/tenants/{t['id']}/secrets/{sec['id']}/rotate", headers=admin, json={"value": v2})
        assert rot.status_code == 200 and rot.json()["current_version"] == 2 and v2 not in rot.text

        from astra_migrate.db.control import session_scope
        with session_scope() as s:
            tenant = s.get(Tenant, uuid.UUID(t["id"]))
            assert tenant is not None
            value = connector_secrets.read_for_connector(s, get_vault(), tenant, "secret://legacy-db-reader",
                                                         "test-connector")
        assert value == v2  # the blueprint reference did not change; rotation took effect
        logging.getLogger("probe").info("connecting with password=%s and token %s", v2, v1)

        events = client.get("/api/v1/audit", headers=admin, params={"tenant_id": t["id"], "action": "secret."})
        assert {e["action"] for e in events.json()["items"]} >= {"secret.created", "secret.rotated", "secret.read"}
        assert v1 not in events.text and v2 not in events.text
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)
    logs = buf.getvalue()
    assert logs, "expected log output to scan"
    assert v1 not in logs and v2 not in logs
    assert get_settings().vault_token.get_secret_value() not in logs


def test_secret_api_requires_permission(client: Any, tenant_factory: Any, user_factory: Any) -> None:
    t = tenant_factory()
    sme, _ = user_factory(("data_sme", "tenant", t["id"]))
    r = client.post(f"/api/v1/tenants/{t['id']}/secrets", headers=sme,
                    json={"name": "nope-secret", "value": "x" * 10})
    assert r.status_code == 403


# ---------------------------------------------------------------- tracing

def test_requests_are_traced_with_tenant_and_reported(client: Any, admin: dict[str, str],
                                                      tenant_factory: Any) -> None:
    # only this test's window: the shared test database keeps every earlier tenant, and the summary returns the
    # 200 groups with the most time
    since = (datetime.now(UTC) - timedelta(minutes=2)).isoformat()
    t = tenant_factory()
    client.get(f"/api/v1/tenants/{t['id']}", headers=admin)
    deadline = time.time() + 10
    rows: list[dict[str, Any]] = []
    while time.time() < deadline:
        rows = client.get("/api/v1/observability/summary", headers=admin,
                          params={"group_by": "tenant", "since": since}).json()
        if any(r["key"] == t["id"] for r in rows):
            break
        time.sleep(0.5)
    assert any(r["key"] == t["id"] and r["spans"] >= 1 and r["total_ms"] > 0 for r in rows)

    traces = client.get("/api/v1/observability/traces", headers=admin).json()
    assert traces
    detail = client.get(f"/api/v1/observability/traces/{traces[0]['trace_id']}", headers=admin).json()
    assert detail["spans"] and all(sp["span_id"] for sp in detail["spans"])


def test_audit_records_carry_trace_ids(client: Any, admin: dict[str, str], tenant_factory: Any) -> None:
    t = tenant_factory()
    ev = client.get("/api/v1/audit", headers=admin, params={"tenant_id": t["id"]}).json()["items"]
    assert any(e["trace_id"] for e in ev)
