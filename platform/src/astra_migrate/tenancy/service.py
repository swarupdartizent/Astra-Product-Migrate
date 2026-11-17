"""Tenant lifecycle (E01.F1.S1, E01.F1.S2).

Each tenant (customer estate) gets:
- its own database on the regional database server chosen at creation,
- its own login role, which can connect only to that database,
- its own non-exportable encryption key in the key service,
- its own secret namespace in the vault.

Deleting a tenant drops its database and role, destroys its secrets and crypto-shreds its key.
The region can change only through a recorded region migration task, enforced in the database.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from importlib import resources
from typing import Any

import psycopg
from psycopg import sql
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.config import get_settings
from astra_migrate.db.models import ConnectorSecret, RegionMigration, Tenant
from astra_migrate.logging import register_secret
from astra_migrate.tenancy.regions import Region, get_region
from astra_migrate.vault import VaultClient

log = logging.getLogger(__name__)
SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{2,30}[a-z0-9]$")


class TenantError(ValueError):
    pass


def _ident(name: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9_]{2,62}", name):
        raise TenantError(f"unsafe identifier: {name}")
    return name


def db_password_path(tenant_id: uuid.UUID) -> str:
    return f"tenants/{tenant_id}/system/db-password"


def secrets_prefix(tenant_id: uuid.UUID) -> str:
    return f"tenants/{tenant_id}"


# --------------------------------------------------------------------- connections

def _provisioner_conn(region: Region, dbname: str = "postgres") -> psycopg.Connection[Any]:
    s = get_settings()
    pw = s.provisioner_password.get_secret_value()
    register_secret(pw)
    return psycopg.connect(host=region.tenant_db.host, port=region.tenant_db.port, dbname=dbname,
                           user=s.provisioner_user, password=pw, autocommit=True, connect_timeout=5)


@contextmanager
def tenant_connection(t: Tenant, vault: VaultClient, region_code: str | None = None
                      ) -> Iterator[psycopg.Connection[Any]]:
    """Connect as the tenant's own role. This role cannot open any other tenant's database."""
    region = get_region(region_code or t.region_code)
    pw = vault.get_secret(db_password_path(t.id)).value
    with psycopg.connect(host=region.tenant_db.host, port=region.tenant_db.port, dbname=t.db_name,
                         user=t.db_role, password=pw, connect_timeout=5,
                         application_name=f"astra-tenant-{t.slug}") as conn:
        yield conn


def _schema_files() -> list[tuple[str, str]]:
    pkg = resources.files("astra_migrate.tenancy") / "tenant_schema"
    files = sorted((f.name, f.read_text(encoding="utf-8")) for f in pkg.iterdir() if f.name.endswith(".sql"))
    return files


def migrate_tenant_schema(conn: psycopg.Connection[Any]) -> list[str]:
    applied: list[str] = []
    with conn.transaction():
        conn.execute("CREATE SCHEMA IF NOT EXISTS estate")
        conn.execute("CREATE TABLE IF NOT EXISTS estate.schema_migrations "
                     "(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        done = {r[0] for r in conn.execute("SELECT version FROM estate.schema_migrations")}
        for name, body in _schema_files():
            if name in done:
                continue
            conn.execute(body)  # trusted file shipped with the platform
            conn.execute("INSERT INTO estate.schema_migrations(version) VALUES (%s)", (name,))
            applied.append(name)
    return applied


# --------------------------------------------------------------------- create

def new_tenant(session: Session, actor: audit.Actor, *, slug: str, name: str, region_code: str,
               programme_id: uuid.UUID | None, partner_id: uuid.UUID | None, mfa_required: bool,
               session_timeout_minutes: int, created_by: uuid.UUID) -> Tenant:
    if not SLUG_RE.match(slug):
        raise TenantError("The short name must be 4–32 characters: lowercase letters, digits and hyphens, "
                          "starting with a letter.")
    get_region(region_code)
    tid = uuid.uuid4()
    base = "t_" + slug.replace("-", "_")[:40] + "_" + tid.hex[:6]
    t = Tenant(id=tid, slug=slug, name=name, region_code=region_code, programme_id=programme_id,
               partner_id=partner_id, status="provisioning", db_name=_ident(base), db_role=_ident(base + "_rw"),
               key_name=f"tenant-{tid}", mfa_required=mfa_required,
               session_timeout_minutes=session_timeout_minutes, created_by=created_by)
    session.add(t)
    session.flush()
    audit.record(session, actor, "tenant.create_requested", tenant_id=t.id, target_type="tenant",
                 target_id=str(t.id), details={"slug": slug, "name": name, "region": region_code})
    return t


def _create_storage(t: Tenant, region: Region, vault: VaultClient, password: str) -> None:
    with _provisioner_conn(region) as c:
        exists = c.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (t.db_role,)).fetchone()
        stmt = "ALTER ROLE {} LOGIN PASSWORD {}" if exists else "CREATE ROLE {} LOGIN PASSWORD {} NOINHERIT"
        c.execute(sql.SQL(stmt).format(sql.Identifier(t.db_role), sql.Literal(password)))
        if not c.execute("SELECT 1 FROM pg_database WHERE datname = %s", (t.db_name,)).fetchone():
            c.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(t.db_name)))
        c.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(t.db_name)))
        c.execute(sql.SQL("GRANT CONNECT, CREATE, TEMPORARY ON DATABASE {} TO {}").format(
            sql.Identifier(t.db_name), sql.Identifier(t.db_role)))


def _drop_storage(t: Tenant, region: Region) -> None:
    with _provisioner_conn(region) as c:
        c.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(t.db_name)))
        c.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(t.db_role)))


def provision(session: Session, t: Tenant, vault: VaultClient, actor: audit.Actor) -> Tenant:
    """Create the tenant's storage, key and schema. On failure the tenant is marked failed and
    partial resources are removed."""
    region = get_region(t.region_code)
    try:
        if vault.key_info(t.key_name) is None:
            vault.create_key(t.key_name)
        password = secrets.token_urlsafe(32)
        register_secret(password)
        vault.put_secret(db_password_path(t.id), password)
        _create_storage(t, region, vault, password)
        with tenant_connection(t, vault) as conn:
            applied = migrate_tenant_schema(conn)
            with conn.transaction():
                for k, v in (("tenant_id", str(t.id)), ("slug", t.slug), ("region", t.region_code)):
                    conn.execute("INSERT INTO estate.tenant_info(key, value) VALUES (%s, %s) "
                                 "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()",
                                 (k, json.dumps(v)))
        t.status, t.status_detail = "active", None
        audit.record(session, actor, "tenant.created", tenant_id=t.id, target_type="tenant", target_id=str(t.id),
                     details={"region": t.region_code, "database": t.db_name, "key": t.key_name,
                              "schema_versions": applied})
    except Exception as e:
        log.exception("tenant provisioning failed for %s", t.id)
        t.status, t.status_detail = "failed", f"Provisioning failed: {type(e).__name__}"
        audit.record(session, actor, "tenant.created", outcome="failure", tenant_id=t.id, target_type="tenant",
                     target_id=str(t.id), details={"error": type(e).__name__})
        try:
            _drop_storage(t, region)
        except Exception:
            log.exception("cleanup after failed provisioning also failed for %s", t.id)
    session.flush()
    return t


# --------------------------------------------------------------------- delete

def delete_tenant(session: Session, t: Tenant, vault: VaultClient, actor: audit.Actor, reason: str) -> Tenant:
    if t.status in ("deleted", "deleting", "migrating"):
        raise TenantError(f"Tenant is {t.status}; it cannot be deleted now.")
    t.status = "deleting"
    session.flush()
    region = get_region(t.region_code)
    _drop_storage(t, region)
    vault.delete_secret_tree(secrets_prefix(t.id))
    vault.destroy_key(t.key_name)
    from astra_migrate.blueprints.repo import delete_tenant_repo  # local import: blueprints depends on tenancy

    delete_tenant_repo(t.id)
    session.query(ConnectorSecret).filter(ConnectorSecret.tenant_id == t.id).delete()
    t.status, t.deleted_at = "deleted", datetime.now(UTC)
    audit.record(session, actor, "tenant.deleted", tenant_id=t.id, target_type="tenant", target_id=str(t.id),
                 details={"reason": reason, "database_dropped": t.db_name, "key_destroyed": t.key_name})
    session.flush()
    return t


# --------------------------------------------------------------------- region migration

def _tables(conn: psycopg.Connection[Any]) -> list[str]:
    rows = conn.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'estate' "
                        "AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name")
    return [r[0] for r in rows]


def migrate_region(session: Session, t: Tenant, to_region: str, reason: str, vault: VaultClient,
                   actor: audit.Actor, requested_by: uuid.UUID) -> RegionMigration:
    """Move a tenant to another region: build storage there, copy and verify every table, switch,
    then remove the old storage. The switch is accepted by the database only while this recorded
    task is running."""
    if t.status != "active":
        raise TenantError(f"Tenant is {t.status}; only active tenants can move region.")
    if to_region == t.region_code:
        raise TenantError("The tenant is already in that region.")
    src_region, dst_region = get_region(t.region_code), get_region(to_region)
    task = RegionMigration(tenant_id=t.id, from_region=t.region_code, to_region=to_region, reason=reason,
                           status="running", requested_by=requested_by, detail={})
    session.add(task)
    t.status = "migrating"
    session.flush()
    audit.record(session, actor, "tenant.region_migration_started", tenant_id=t.id, target_type="region_migration",
                 target_id=str(task.id), details={"from": t.region_code, "to": to_region, "reason": reason})
    session.commit()

    counts: dict[str, dict[str, int]] = {}
    try:
        password = vault.get_secret(db_password_path(t.id)).value
        _create_storage(t, dst_region, vault, password)
        with tenant_connection(t, vault) as src, tenant_connection(t, vault, to_region) as dst:
            migrate_tenant_schema(dst)
            with dst.transaction():
                for table in _tables(src):
                    ident = sql.Identifier("estate", table)
                    dst.execute(sql.SQL("TRUNCATE {}").format(ident))
                    with src.cursor().copy(sql.SQL("COPY {} TO STDOUT (FORMAT BINARY)").format(ident)) as out, \
                         dst.cursor().copy(sql.SQL("COPY {} FROM STDIN (FORMAT BINARY)").format(ident)) as into:
                        for chunk in out:
                            into.write(chunk)
                    n_src = src.execute(sql.SQL("SELECT count(*) FROM {}").format(ident)).fetchone()[0]  # type: ignore[index]
                    n_dst = dst.execute(sql.SQL("SELECT count(*) FROM {}").format(ident)).fetchone()[0]  # type: ignore[index]
                    counts[table] = {"source": n_src, "target": n_dst}
                    if n_src != n_dst:
                        raise TenantError(f"Row count mismatch in {table}: {n_src} vs {n_dst}")
                dst.execute("UPDATE estate.tenant_info SET value = %s, updated_at = now() WHERE key = 'region'",
                            (json.dumps(to_region),))
        t.region_code = to_region
        t.status = "active"
        session.flush()  # the database trigger checks the running task here
        task.status, task.completed_at, task.detail = "completed", datetime.now(UTC), {"tables": counts}
        audit.record(session, actor, "tenant.region_migration_completed", tenant_id=t.id,
                     target_type="region_migration", target_id=str(task.id), details={"tables": counts})
        session.commit()
        try:
            _drop_storage(t, src_region)
        except Exception:
            log.exception("old region storage cleanup failed for tenant %s", t.id)
    except Exception as e:
        session.rollback()
        t2 = session.get(Tenant, t.id)
        task2 = session.get(RegionMigration, task.id)
        assert t2 is not None and task2 is not None
        t2.status = "active"
        task2.status, task2.completed_at = "failed", datetime.now(UTC)
        task2.detail = {"tables": counts, "error": str(e)[:500]}
        audit.record(session, actor, "tenant.region_migration_completed", outcome="failure", tenant_id=t.id,
                     target_type="region_migration", target_id=str(task.id), details={"error": type(e).__name__})
        session.commit()
        try:
            if t2.region_code != to_region:
                _drop_storage(t2, dst_region)
        except Exception:
            log.exception("destination cleanup failed for tenant %s", t.id)
        return task2
    return task
