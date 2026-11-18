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
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    type_annotation_map: ClassVar[dict[Any, Any]] = {dict[str, Any]: JSONB, uuid.UUID: UUID(as_uuid=True)}


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class User(Base):
    """A person, or the identity of a registered agent (kind 'agent'). Agent identities never sign in,
    never hold roles and can never approve, decide or release anything (enforced in the database)."""

    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("issuer", "subject", name="uq_users_identity"),
                      CheckConstraint("kind in ('person', 'agent')", name="ck_user_kind"))

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(10), default="person", server_default="person")
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


PACK_STATUSES = ("draft", "published", "deprecated")


class Pack(Base):
    """One version of a pack. Published versions are immutable (enforced in the database)."""

    __tablename__ = "packs"
    __table_args__ = (
        UniqueConstraint("name", "version", name="uq_pack_version"),
        CheckConstraint(f"status in {PACK_STATUSES!r}", name="ck_pack_status"),
        Index("ix_pack_name", "name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(64))
    version: Mapped[str] = mapped_column(String(32))
    version_sort: Mapped[list[int]] = mapped_column(ARRAY(Integer))
    type: Mapped[str] = mapped_column(String(30))
    title: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="draft")
    manifest: Mapped[dict[str, Any]] = mapped_column()
    digest: Mapped[str] = mapped_column(String(64))
    test_report: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    tests_passed: Mapped[bool | None] = mapped_column(Boolean)
    reviewed_by_name: Mapped[str | None] = mapped_column(String(200))
    reviewed_by_role: Mapped[str | None] = mapped_column(String(200))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    published_by: Mapped[str | None] = mapped_column(String(200))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PackFile(Base):
    __tablename__ = "pack_files"

    pack_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("packs.id", ondelete="CASCADE"), primary_key=True)
    path: Mapped[str] = mapped_column(String(300), primary_key=True)
    sha256: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer)
    content: Mapped[bytes] = mapped_column(LargeBinary)


class Project(Base):
    """A migration project inside a tenant (customer estate)."""

    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_project_name"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="RESTRICT"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="configuring")
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


BLUEPRINT_STATUSES = ("draft", "approved", "superseded", "rejected")


class BlueprintVersion(Base):
    """One saved version of a project's blueprint. The text is also committed to the tenant's git repository."""

    __tablename__ = "blueprint_versions"
    __table_args__ = (
        UniqueConstraint("project_id", "number", name="uq_blueprint_version"),
        CheckConstraint(f"status in {BLUEPRINT_STATUSES!r}", name="ck_blueprint_status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    number: Mapped[int] = mapped_column(Integer)
    yaml_text: Mapped[str] = mapped_column(Text)
    content: Mapped[dict[str, Any]] = mapped_column()
    commit_sha: Mapped[str] = mapped_column(String(40))
    message: Mapped[str] = mapped_column(Text)
    template: Mapped[str | None] = mapped_column(String(200))
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    status: Mapped[str] = mapped_column(String(20), default="draft")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BlueprintApproval(Base):
    __tablename__ = "blueprint_approvals"
    __table_args__ = (UniqueConstraint("version_id", "user_id", name="uq_blueprint_approval"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("blueprint_versions.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    role: Mapped[str] = mapped_column(String(60))
    decision: Mapped[str] = mapped_column(String(10))  # approve | reject
    reason: Mapped[str] = mapped_column(Text, default="")
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Decision(Base):
    """A recorded human decision: a pack rule conflict (CF-04) or a loosening approval (CF-05)."""

    __tablename__ = "decisions"
    __table_args__ = (
        UniqueConstraint("project_id", "kind", "fingerprint", name="uq_decision"),
        CheckConstraint("kind in ('setting_conflict', 'loosening')", name="ck_decision_kind"),
        CheckConstraint("status in ('open', 'decided', 'rejected')", name="ck_decision_status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="RESTRICT"))
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(30))
    fingerprint: Mapped[str] = mapped_column(String(64))
    subject: Mapped[str] = mapped_column(String(200))  # setting key
    context: Mapped[dict[str, Any]] = mapped_column()  # values, packs, effective value, ...
    status: Mapped[str] = mapped_column(String(20), default="open")
    chosen_value: Mapped[dict[str, Any] | None] = mapped_column(JSONB)  # {"value": ...}
    reason: Mapped[str | None] = mapped_column(Text)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BlueprintTemplate(Base):
    __tablename__ = "blueprint_templates"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    yaml_text: Mapped[str] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


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


# ============================================================================ I3: runtime and AI governance

JOB_STATUSES = ("queued", "running", "succeeded", "failed", "cancelled")


class Job(Base):
    """Durable background work (tenant provisioning, region moves, agent runs, agent tests).
    Workers claim jobs with SELECT ... FOR UPDATE SKIP LOCKED, so any number of workers can run."""

    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(f"status in {JOB_STATUSES!r}", name="ck_job_status"),
        Index("ix_job_claim", "status", "run_after"),
        Index("ix_job_tenant", "tenant_id", "created_at"),
        Index("ix_job_project", "project_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(60))
    status: Mapped[str] = mapped_column(String(20), default="queued")
    title: Mapped[str] = mapped_column(String(300))
    payload: Mapped[dict[str, Any]] = mapped_column(default=dict)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    progress_message: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=1)
    run_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    locked_by: Mapped[str | None] = mapped_column(String(120))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("tenants.id", ondelete="RESTRICT"))
    project_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    actor: Mapped[dict[str, Any]] = mapped_column()  # {"type", "id", "name"} of whoever asked for the work
    trace_id: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


PROVIDER_KINDS = ("anthropic", "anthropic_foundry", "azure_openai")


class ModelProvider(Base):
    """An enterprise model endpoint. The credential is held in the vault; only its path is stored here.
    A provider can be enabled only when its terms say customer data is not used for training."""

    __tablename__ = "model_providers"
    __table_args__ = (CheckConstraint(f"kind in {PROVIDER_KINDS!r}", name="ck_provider_kind"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    kind: Mapped[str] = mapped_column(String(30))
    endpoint: Mapped[str | None] = mapped_column(String(500))
    api_version: Mapped[str | None] = mapped_column(String(40))
    secret_path: Mapped[str | None] = mapped_column(String(300))
    credential_version: Mapped[int | None] = mapped_column(Integer)
    no_training_terms: Mapped[bool] = mapped_column(Boolean, default=False)
    terms_reference: Mapped[str] = mapped_column(Text, default="")
    options: Mapped[dict[str, Any]] = mapped_column(default=dict)
    prices: Mapped[dict[str, Any]] = mapped_column(default=dict)  # model id -> USD per million tokens
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    check_status: Mapped[str] = mapped_column(String(20), default="unchecked")  # unchecked | ok | failed
    check_detail: Mapped[str | None] = mapped_column(Text)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ModelAlias(Base):
    """Agents name a model alias (for example 'reasoning'), never a provider. Changing the alias
    changes the model for every agent without changing any agent."""

    __tablename__ = "model_aliases"

    alias: Mapped[str] = mapped_column(String(60), primary_key=True)
    provider_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("model_providers.id", ondelete="RESTRICT"))
    model: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ModelCall(Base):
    """One call through the model gateway: which model and version answered, tokens, cost and time.
    Prompts and answers are not stored here (they may hold customer data). Append-only."""

    __tablename__ = "model_calls"
    __table_args__ = (
        Index("ix_model_call_ts", "created_at"),
        Index("ix_model_call_agent", "agent_name", "created_at"),
        Index("ix_model_call_run", "agent_run_id"),
        Index("ix_model_call_tenant", "tenant_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    provider_id: Mapped[uuid.UUID | None] = mapped_column()
    provider_name: Mapped[str] = mapped_column(String(100))
    provider_kind: Mapped[str] = mapped_column(String(30))
    alias: Mapped[str | None] = mapped_column(String(60))
    requested_model: Mapped[str] = mapped_column(String(120))
    served_model: Mapped[str | None] = mapped_column(String(120))
    api_version: Mapped[str | None] = mapped_column(String(40))
    sdk_version: Mapped[str | None] = mapped_column(String(40))
    request_id: Mapped[str | None] = mapped_column(String(120))
    agent_name: Mapped[str | None] = mapped_column(String(64))
    agent_version: Mapped[str | None] = mapped_column(String(32))
    agent_run_id: Mapped[uuid.UUID | None] = mapped_column()
    test_run_id: Mapped[uuid.UUID | None] = mapped_column()
    tenant_id: Mapped[uuid.UUID | None] = mapped_column()
    project_id: Mapped[uuid.UUID | None] = mapped_column()
    region_code: Mapped[str | None] = mapped_column(String(40))
    region_pinned: Mapped[bool | None] = mapped_column(Boolean)
    status: Mapped[str] = mapped_column(String(20))  # ok | refused | error
    stop_reason: Mapped[str | None] = mapped_column(String(40))
    error: Mapped[str | None] = mapped_column(Text)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float | None] = mapped_column(Float)
    latency_ms: Mapped[float] = mapped_column(Float, default=0)
    trace_id: Mapped[str | None] = mapped_column(String(32))


class Agent(Base):
    """A registered agent. Each agent has its own identity (a users row of kind 'agent') so every
    action it takes is attributable, and so the database can refuse it as an approver."""

    __tablename__ = "agents"

    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    team: Mapped[str] = mapped_column(String(30))
    identity_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


AGENT_VERSION_STATUSES = ("draft", "released", "deprecated")


class AgentVersion(Base):
    """One version of an agent: role, prompt, allowed tools, guardrails, oversight and test suite.
    Released versions are immutable (enforced in the database)."""

    __tablename__ = "agent_versions"
    __table_args__ = (
        UniqueConstraint("agent_name", "version", name="uq_agent_version"),
        CheckConstraint(f"status in {AGENT_VERSION_STATUSES!r}", name="ck_agent_version_status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    agent_name: Mapped[str] = mapped_column(ForeignKey("agents.name", ondelete="RESTRICT"))
    version: Mapped[str] = mapped_column(String(32))
    version_sort: Mapped[list[int]] = mapped_column(ARRAY(Integer))
    manifest: Mapped[dict[str, Any]] = mapped_column()
    digest: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(20), default="draft")
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    released_test_run_id: Mapped[uuid.UUID | None] = mapped_column()
    released_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    release_note: Mapped[str | None] = mapped_column(Text)


TEST_RUN_STATUSES = ("queued", "running", "passed", "failed", "blocked", "error")


class AgentTestRun(Base):
    __tablename__ = "agent_test_runs"
    __table_args__ = (
        CheckConstraint(f"status in {TEST_RUN_STATUSES!r}", name="ck_agent_test_status"),
        Index("ix_agent_test_version", "agent_version_id", "started_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    agent_version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agent_versions.id", ondelete="CASCADE"))
    digest: Mapped[str] = mapped_column(String(64))  # manifest digest the suite ran against
    status: Mapped[str] = mapped_column(String(20), default="queued")
    job_id: Mapped[uuid.UUID | None] = mapped_column()
    started_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    summary: Mapped[dict[str, Any]] = mapped_column(default=dict)
    results: Mapped[dict[str, Any]] = mapped_column(default=dict)  # {"cases": [...]}
    cost_usd: Mapped[float] = mapped_column(Float, default=0)


class ProjectAgentPin(Base):
    """A project runs exactly the agent versions it is pinned to (E02.F1.S1)."""

    __tablename__ = "project_agent_pins"

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    agent_name: Mapped[str] = mapped_column(ForeignKey("agents.name", ondelete="RESTRICT"), primary_key=True)
    version: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str] = mapped_column(Text, default="")
    pinned_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    pinned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


AGENT_RUN_STATUSES = ("queued", "running", "succeeded", "failed", "blocked", "cancelled")


class AgentRun(Base):
    """Metadata of one agent run. The objective, transcript and output live in the tenant's own
    database, because they may contain customer data."""

    __tablename__ = "agent_runs"
    __table_args__ = (
        CheckConstraint(f"status in {AGENT_RUN_STATUSES!r}", name="ck_agent_run_status"),
        Index("ix_agent_run_project", "project_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="RESTRICT"))
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    agent_name: Mapped[str] = mapped_column(ForeignKey("agents.name", ondelete="RESTRICT"))
    agent_version: Mapped[str] = mapped_column(String(32))
    parent_run_id: Mapped[uuid.UUID | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(20), default="queued")
    status_detail: Mapped[str | None] = mapped_column(Text)
    requested_by: Mapped[dict[str, Any]] = mapped_column()  # actor
    job_id: Mapped[uuid.UUID | None] = mapped_column()
    model_calls: Mapped[int] = mapped_column(Integer, default=0)
    tool_calls: Mapped[int] = mapped_column(Integer, default=0)
    denied_tool_calls: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0)
    trace_id: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


REVIEW_KINDS = ("decision", "screening_flag", "proposal")
REVIEW_STATUSES = ("open", "resolved", "dismissed")


class ReviewItem(Base):
    """The review queue: every decision an agent asks for, every screening flag and every proposal,
    each with an owner. Only people resolve items (enforced in the database)."""

    __tablename__ = "review_items"
    __table_args__ = (
        CheckConstraint(f"kind in {REVIEW_KINDS!r}", name="ck_review_kind"),
        CheckConstraint(f"status in {REVIEW_STATUSES!r}", name="ck_review_status"),
        Index("ix_review_project", "project_id", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id", ondelete="RESTRICT"))
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(300))
    question: Mapped[str] = mapped_column(Text)
    options: Mapped[list[str]] = mapped_column(JSONB, default=list)
    context: Mapped[dict[str, Any]] = mapped_column(default=dict)
    owner_role: Mapped[str] = mapped_column(String(60))
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    requested_by: Mapped[dict[str, Any]] = mapped_column()  # actor
    agent_run_id: Mapped[uuid.UUID | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(20), default="open")
    resolution: Mapped[str | None] = mapped_column(Text)
    resolution_note: Mapped[str | None] = mapped_column(Text)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


STAGE_STATUSES = ("not_started", "blocked", "in_progress", "done")


class ProjectStage(Base):
    __tablename__ = "project_stages"
    __table_args__ = (CheckConstraint(f"status in {STAGE_STATUSES!r}", name="ck_stage_status"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    stage: Mapped[str] = mapped_column(String(40), primary_key=True)
    status: Mapped[str] = mapped_column(String(20), default="not_started")
    note: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[dict[str, Any]] = mapped_column()  # actor
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
