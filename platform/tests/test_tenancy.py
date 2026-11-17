"""E01.F1.S1 tenant isolation and E01.F1.S2 region rules."""

from __future__ import annotations

import uuid
from typing import Any

import psycopg
import pytest
from sqlalchemy import create_engine, text

from astra_migrate.config import get_settings
from astra_migrate.tenancy.regions import get_region
from astra_migrate.tenancy.service import db_password_path
from astra_migrate.vault import VaultError, get_vault

pytestmark = pytest.mark.integration


def _tenant_conn(t: dict[str, Any], *, as_tenant: dict[str, Any] | None = None,
                 region: str | None = None) -> psycopg.Connection[Any]:
    """Connect to tenant `t`'s database using the credentials of `as_tenant` (default: t itself)."""
    who = as_tenant or t
    vault = get_vault()
    pw = vault.get_secret(db_password_path(uuid.UUID(who["id"]))).value
    reg = get_region(region or t["region_code"])
    db_name, role = _names(t), _names(who, role=True)
    return psycopg.connect(host=reg.tenant_db.host, port=reg.tenant_db.port, dbname=db_name, user=role,
                           password=pw, connect_timeout=5)


def _names(t: dict[str, Any], role: bool = False) -> str:
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    with eng.connect() as c:
        row = c.execute(text("select db_name, db_role from tenants where id = :i"), {"i": t["id"]}).one()
    eng.dispose()
    return str(row.db_role if role else row.db_name)


def test_each_tenant_has_own_storage_and_key(tenant_factory: Any) -> None:
    a = tenant_factory("local-a")
    b = tenant_factory("local-b")
    vault = get_vault()
    assert a["key_name"] != b["key_name"]
    assert vault.key_info(a["key_name"]) is not None
    assert vault.key_info(b["key_name"])["exportable"] is False  # type: ignore[index]

    with _tenant_conn(a) as c:
        assert c.execute("select value #>> '{}' from estate.tenant_info where key='tenant_id'").fetchone()[0] == a["id"]  # type: ignore[index]
    with _tenant_conn(b) as c:
        assert c.execute("select value #>> '{}' from estate.tenant_info where key='region'").fetchone()[0] == "local-b"  # type: ignore[index]


def test_tenant_role_cannot_open_another_tenants_database(tenant_factory: Any) -> None:
    a = tenant_factory("local-a")
    b = tenant_factory("local-a")  # same server: the strongest case
    with pytest.raises(psycopg.OperationalError, match="permission denied"):
        _tenant_conn(b, as_tenant=a)
    with pytest.raises(psycopg.OperationalError, match="permission denied"):
        _tenant_conn(a, as_tenant=b)


def test_tenant_role_cannot_read_control_plane(tenant_factory: Any) -> None:
    a = tenant_factory("local-a")
    reg = get_region("local-a")
    pw = get_vault().get_secret(db_password_path(uuid.UUID(a["id"]))).value
    with pytest.raises(psycopg.OperationalError, match="permission denied"):
        psycopg.connect(host=reg.tenant_db.host, port=reg.tenant_db.port, dbname="astra_control_test",
                        user=_names(a, role=True), password=pw, connect_timeout=5)


def test_tenant_keys_are_not_interchangeable(tenant_factory: Any) -> None:
    a = tenant_factory()
    b = tenant_factory()
    vault = get_vault()
    ct = vault.encrypt(a["key_name"], b"policy holder data", context=a["id"].encode())
    assert vault.decrypt(a["key_name"], ct, context=a["id"].encode()) == b"policy holder data"
    with pytest.raises(VaultError):
        vault.decrypt(b["key_name"], ct, context=b["id"].encode())


def test_create_and_delete_are_audited_and_delete_crypto_shreds(client: Any, admin: dict[str, str]) -> None:
    slug = "t-" + uuid.uuid4().hex[:10]
    r = client.post("/api/v1/tenants", headers=admin, json={"slug": slug, "name": "Audit me", "region_code": "local-a"})
    assert r.status_code == 201
    t = r.json()
    db_name = _names(t)

    bad = client.post(f"/api/v1/tenants/{t['id']}/delete", headers=admin,
                      json={"confirm_slug": "wrong", "reason": "testing deletion"})
    assert bad.status_code == 422 and bad.json()["type"] == "/problems/confirmation-mismatch"

    d = client.post(f"/api/v1/tenants/{t['id']}/delete", headers=admin,
                    json={"confirm_slug": slug, "reason": "testing deletion"})
    assert d.status_code == 200 and d.json()["status"] == "deleted"
    assert get_vault().key_info(t["key_name"]) is None
    with pytest.raises(VaultError):
        get_vault().get_secret(db_password_path(uuid.UUID(t["id"])))
    reg = get_region("local-a")
    with psycopg.connect(host=reg.tenant_db.host, port=reg.tenant_db.port, dbname="postgres",
                         user=get_settings().provisioner_user,
                         password=get_settings().provisioner_password.get_secret_value()) as c:
        assert c.execute("select 1 from pg_database where datname=%s", (db_name,)).fetchone() is None

    events = client.get("/api/v1/audit", headers=admin, params={"tenant_id": t["id"]}).json()["items"]
    actions = [e["action"] for e in events]
    assert {"tenant.create_requested", "tenant.created", "tenant.deleted"} <= set(actions)


def test_region_is_fixed_except_through_a_recorded_migration(client: Any, admin: dict[str, str],
                                                             tenant_factory: Any) -> None:
    t = tenant_factory("local-a")
    # Direct change is refused by the database itself.
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    with pytest.raises(Exception, match="recorded region migration task"), eng.begin() as c:
        c.execute(text("update tenants set region_code='local-b' where id=:i"), {"i": t["id"]})
    eng.dispose()

    with _tenant_conn(t) as c:
        c.execute("insert into estate.tenant_info(key, value) values ('marker', '\"moved-with-tenant\"')")
        c.commit()

    r = client.post(f"/api/v1/tenants/{t['id']}/region-migrations", headers=admin,
                    json={"to_region": "local-b", "reason": "customer requested EU-to-other move (test)"})
    assert r.status_code == 201, r.text
    move = r.json()
    assert move["status"] == "completed", move
    assert move["detail"]["tables"]["tenant_info"]["source"] == move["detail"]["tables"]["tenant_info"]["target"]

    after = client.get(f"/api/v1/tenants/{t['id']}", headers=admin).json()
    assert after["region_code"] == "local-b"
    with _tenant_conn(after) as c:
        row = c.execute("select value #>> '{}' from estate.tenant_info where key='marker'").fetchone()
        assert row is not None and row[0] == "moved-with-tenant"
    with pytest.raises(psycopg.OperationalError):
        _tenant_conn(after, region="local-a")  # old storage removed
    history = client.get(f"/api/v1/tenants/{t['id']}/region-migrations", headers=admin).json()
    assert len(history) == 1 and history[0]["reason"].startswith("customer requested")


def test_unknown_region_is_rejected(client: Any, admin: dict[str, str]) -> None:
    r = client.post("/api/v1/tenants", headers=admin,
                    json={"slug": "t-" + uuid.uuid4().hex[:8], "name": "x region", "region_code": "mars-1"})
    assert r.status_code == 422
    assert r.json()["errors"][0]["field"] == "region_code"
    bad_slug = client.post("/api/v1/tenants", headers=admin,
                           json={"slug": "Bad_Slug!", "name": "x slug", "region_code": "local-a"})
    assert bad_slug.status_code == 422 and bad_slug.json()["errors"][0]["field"] == "slug"

