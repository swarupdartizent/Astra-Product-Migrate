"""Control-plane data model.

The control plane holds platform metadata only: tenants, identities, role assignments,
secret references (never values), the audit log and trace summaries. Customer estate data
lives in each tenant's own database (see `tenancy`).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, ClassVar

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    type_annotation_map: ClassVar[dict[Any, Any]] = {dict[str, Any]: JSONB, uuid.UUID: UUID(as_uuid=True)}


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("issuer", "subject", name="uq_users_identity"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    display_name: Mapped[str] = mapped_column(String(200))
    issuer: Mapped[str | None] = mapped_column(String(500))
    subject: Mapped[str | None] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Programme(Base):
    __tablename__ = "programmes"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Partner(Base):
    __tablename__ = "partners"
    __table_args__ = (UniqueConstraint("programme_id", "name", name="uq_partner_name"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    programme_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("programmes.id", ondelete="RESTRICT"))
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


TENANT_STATUSES = ("provisioning", "active", "migrating", "deleting", "deleted", "failed")


class Tenant(Base):
    """One customer estate: isolated database, own role and own encryption key."""

    __tablename__ = "tenants"
    __table_args__ = (
        CheckConstraint(f"status in {TENANT_STATUSES!r}", name="ck_tenant_status"),
        CheckConstraint("session_timeout_minutes between 5 and 1440", name="ck_tenant_session_timeout"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    slug: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    region_code: Mapped[str] = mapped_column(String(40))
    programme_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("programmes.id", ondelete="RESTRICT"))
    partner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("partners.id", ondelete="RESTRICT"))
    status: Mapped[str] = mapped_column(String(20), default="provisioning")
    status_detail: Mapped[str | None] = mapped_column(Text)
    db_name: Mapped[str] = mapped_column(String(63))
    db_role: Mapped[str] = mapped_column(String(63))
    key_name: Mapped[str] = mapped_column(String(100))
    mfa_required: Mapped[bool] = mapped_column(Boolean, default=True)
    session_timeout_minutes: Mapped[int] = mapped_column(Integer, default=480)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RegionMigration(Base):
    """The only way a tenant's region can change (E01.F1.S2)."""

    __tablename__ = "region_migrations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="RESTRICT"))
    from_region: Mapped[str] = mapped_column(String(40))
    to_region: Mapped[str] = mapped_column(String(40))
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="running")
    detail: Mapped[dict[str, Any]] = mapped_column(default=dict)
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


SCOPE_TYPES = ("platform", "programme", "partner", "tenant", "project")


class RoleAssignment(Base):
    __tablename__ = "role_assignments"
    __table_args__ = (
        CheckConstraint(f"scope_type in {SCOPE_TYPES!r}", name="ck_role_scope_type"),
        CheckConstraint("(scope_type = 'platform') = (scope_id is null)", name="ck_role_scope_id"),
        Index("uq_role_assignment", "user_id", "role", "scope_type", "scope_id", unique=True,
              postgresql_nulls_not_distinct=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(60))
    scope_type: Mapped[str] = mapped_column(String(20))
    scope_id: Mapped[uuid.UUID | None] = mapped_column()
    granted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ConnectorSecret(Base):
    """Reference to a secret held in the vault. The value is never stored here."""

    __tablename__ = "connector_secrets"
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_connector_secret_name"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    vault_path: Mapped[str] = mapped_column(String(300))
    current_version: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    rotated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_read_by: Mapped[str | None] = mapped_column(String(200))


class AuditEvent(Base):
    """Write-once, hash-chained audit log (E01.F3.S1). UPDATE/DELETE/TRUNCATE are blocked in the database."""

    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_ts", "occurred_at"),
        Index("ix_audit_tenant", "tenant_id", "occurred_at"),
        Index("ix_audit_actor", "actor_id", "occurred_at"),
        Index("ix_audit_project", "project_id", "occurred_at"),
    )

    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    actor_type: Mapped[str] = mapped_column(String(10))  # user | agent | system
    actor_id: Mapped[str] = mapped_column(String(200))
    actor_name: Mapped[str] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(100))
    outcome: Mapped[str] = mapped_column(String(20))  # success | denied | failure
    tenant_id: Mapped[uuid.UUID | None] = mapped_column()
    project_id: Mapped[uuid.UUID | None] = mapped_column()
    target_type: Mapped[str | None] = mapped_column(String(60))
    target_id: Mapped[str | None] = mapped_column(String(200))
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)
    trace_id: Mapped[str | None] = mapped_column(String(32))
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64), unique=True)


class AuditAnchor(Base):
    """Chain head signed with a vault-held key. A rewrite of history by anyone with database
    access but without the signing key is detected at verification."""

    __tablename__ = "audit_anchors"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    anchored_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    head_seq: Mapped[int] = mapped_column(BigInteger)
    head_hash: Mapped[str] = mapped_column(String(64))
    signature: Mapped[str] = mapped_column(Text)
    key_name: Mapped[str] = mapped_column(String(100))
    key_version: Mapped[int] = mapped_column(Integer)


class TraceSpan(Base):
    """Summary of every finished span, for cost and time reporting (E01.F3.S2)."""

    __tablename__ = "trace_spans"
    __table_args__ = (
        Index("ix_span_trace", "trace_id"),
        Index("ix_span_started", "started_at"),
        Index("ix_span_project", "project_id", "started_at"),
    )

    span_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    trace_id: Mapped[str] = mapped_column(String(32))
    parent_span_id: Mapped[str | None] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20))
    category: Mapped[str] = mapped_column(String(20))  # http | db | agent | tool | load | job | other
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_ms: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(10))
    tenant_id: Mapped[str | None] = mapped_column(String(36))
    project_id: Mapped[str | None] = mapped_column(String(36))
    stage: Mapped[str | None] = mapped_column(String(40))
    agent: Mapped[str | None] = mapped_column(String(100))
    model: Mapped[str | None] = mapped_column(String(100))
    cost_usd: Mapped[float | None] = mapped_column(Float)
    attributes: Mapped[dict[str, Any]] = mapped_column(default=dict)
