"""Connector credentials (E01.F2.S3).

Values live only in the vault. The control plane keeps a reference and metadata. Blueprints refer
to a secret by name (`secret://<name>`), so rotating a secret never changes a blueprint. Only a
connector reads the value, at run time, through `read_for_connector`; every read is audited.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.db.models import ConnectorSecret, Tenant
from astra_migrate.vault import VaultClient

NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,62}[a-z0-9]$")
REF_RE = re.compile(r"^secret://([a-z][a-z0-9-]{1,62}[a-z0-9])$")


class SecretError(ValueError):
    pass


def vault_path(t: Tenant, name: str) -> str:
    return f"tenants/{t.id}/connectors/{name}"


def create(session: Session, vault: VaultClient, t: Tenant, actor: audit.Actor, user_id: object, name: str,
           description: str, value: str) -> ConnectorSecret:
    if not NAME_RE.match(name):
        raise SecretError("Name must be 3–64 characters: lowercase letters, digits and hyphens.")
    if not value:
        raise SecretError("The secret value cannot be empty.")
    if session.scalar(select(ConnectorSecret).where(ConnectorSecret.tenant_id == t.id,
                                                    ConnectorSecret.name == name)):
        raise SecretError("A secret with this name already exists in this tenant.")
    path = vault_path(t, name)
    version = vault.put_secret(path, value)
    cs = ConnectorSecret(tenant_id=t.id, name=name, description=description, vault_path=path,
                         current_version=version, created_by=user_id)
    session.add(cs)
    session.flush()
    audit.record(session, actor, "secret.created", tenant_id=t.id, target_type="connector_secret",
                 target_id=str(cs.id), details={"name": name, "version": version})
    return cs


def rotate(session: Session, vault: VaultClient, cs: ConnectorSecret, actor: audit.Actor, user_id: object,
           value: str) -> ConnectorSecret:
    if not value:
        raise SecretError("The secret value cannot be empty.")
    cs.current_version = vault.put_secret(cs.vault_path, value)
    cs.rotated_at, cs.rotated_by = datetime.now(UTC), user_id  # type: ignore[assignment]
    audit.record(session, actor, "secret.rotated", tenant_id=cs.tenant_id, target_type="connector_secret",
                 target_id=str(cs.id), details={"name": cs.name, "version": cs.current_version})
    return cs


def delete(session: Session, vault: VaultClient, cs: ConnectorSecret, actor: audit.Actor) -> None:
    vault.delete_secret(cs.vault_path)
    audit.record(session, actor, "secret.deleted", tenant_id=cs.tenant_id, target_type="connector_secret",
                 target_id=str(cs.id), details={"name": cs.name})
    session.delete(cs)


def read_for_connector(session: Session, vault: VaultClient, t: Tenant, reference: str, connector: str) -> str:
    """Resolve `secret://name` for a connector at run time. The value is never returned by any API."""
    m = REF_RE.match(reference)
    if not m:
        raise SecretError("Secret references look like secret://name")
    cs = session.scalar(select(ConnectorSecret).where(ConnectorSecret.tenant_id == t.id,
                                                      ConnectorSecret.name == m.group(1)))
    if cs is None:
        raise SecretError(f"No secret named '{m.group(1)}' in this tenant")
    value = vault.get_secret(cs.vault_path).value
    cs.last_read_at, cs.last_read_by = datetime.now(UTC), connector
    audit.record(session, audit.Actor.system(f"connector:{connector}"), "secret.read", tenant_id=t.id,
                 target_type="connector_secret", target_id=str(cs.id),
                 details={"name": cs.name, "version": cs.current_version})
    return value
