"""Loads, validation, reconciliation and parity (I10).

Rules enforced in the database:
- A load run pins its transformation code; every pinned artifact must be an approved version with that digest when
  the run is created (only approved, tested code runs).
- Load runs are numbered per project, and their pinned inputs never change after creation.
- A reconciliation break or a parity difference closes only with an owner and a reason, and never by an agent.

Revision ID: 0016
Revises: 0015
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())
RUN_STATUSES = "status in ('queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')"


def _ts(name: str) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(name, sa.DateTime(timezone=True), nullable=True)


def upgrade() -> None:
    op.create_table(
        "load_runs",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("parent_run_id", sa.UUID(), sa.ForeignKey("load_runs.id"), nullable=True),
        sa.Column("extract_run_id", sa.UUID(), nullable=True),
        sa.Column("target_connection_id", sa.UUID(), sa.ForeignKey("target_connections.id"), nullable=True),
        sa.Column("segment", JSONB, nullable=True),
        sa.Column("artifacts", JSONB, nullable=False),
        sa.Column("packs", JSONB, nullable=False),
        sa.Column("input_digest", sa.String(64), nullable=False),
        sa.Column("result_digest", sa.String(64), nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("summary", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("job_id", sa.UUID(), nullable=True),
        sa.Column("requested_by", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        _ts("finished_at"),
        sa.UniqueConstraint("project_id", "number", name="uq_load_run_number"),
        sa.CheckConstraint("kind in ('rehearsal', 'load', 'delta', 'reload')", name="ck_load_run_kind"),
        sa.CheckConstraint(RUN_STATUSES, name="ck_load_run_status"),
        sa.CheckConstraint("kind = 'rehearsal' OR target_connection_id IS NOT NULL", name="ck_load_needs_target"),
    )
    op.create_index("ix_load_run_project", "load_runs", ["project_id", "number"])
    op.create_table(
        "recon_breaks",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("origin", sa.String(20), nullable=False),
        sa.Column("load_run_id", sa.UUID(), sa.ForeignKey("load_runs.id", ondelete="CASCADE"), nullable=True),
        sa.Column("scope", sa.String(300), nullable=False),
        sa.Column("measure", sa.String(200), nullable=False),
        sa.Column("source_value", sa.Numeric(24, 2), nullable=True),
        sa.Column("target_value", sa.Numeric(24, 2), nullable=True),
        sa.Column("difference", sa.Numeric(24, 2), nullable=True),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("owner_role", sa.String(60), nullable=False),
        sa.Column("owner_user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("close_reason", sa.Text(), nullable=True),
        sa.Column("closed_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        _ts("closed_at"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("origin in ('load', 'coexistence')", name="ck_break_origin"),
        sa.CheckConstraint("status in ('open', 'closed')", name="ck_break_status"),
        sa.CheckConstraint("status <> 'closed' OR (owner_user_id IS NOT NULL AND closed_by IS NOT NULL AND "
                           "length(coalesce(close_reason, '')) >= 10)", name="ck_break_close_needs_owner_and_reason"),
    )
    op.create_index("ix_break_project", "recon_breaks", ["project_id", "status", "origin"])
    op.create_table(
        "parity_runs",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("spec", JSONB, nullable=False),
        sa.Column("summary", JSONB, nullable=False),
        sa.Column("source_sha256", sa.String(64), nullable=False),
        sa.Column("target_sha256", sa.String(64), nullable=False),
        sa.Column("created_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("kind in ('rating', 'report', 'workflow', 'period_close')", name="ck_parity_kind"),
    )
    op.create_index("ix_parity_project", "parity_runs", ["project_id", "created_at"])
    op.create_table(
        "coexistence_schedules",
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("connection_id", sa.UUID(), sa.ForeignKey("source_connections.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("hour_utc", sa.SmallInteger(), nullable=False),
        sa.Column("owner_user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        _ts("last_run_at"),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.CheckConstraint("hour_utc between 0 and 23", name="ck_coexistence_hour"),
    )
    op.execute(r"""
CREATE OR REPLACE FUNCTION load_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a jsonb; st text; dg text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF jsonb_array_length(NEW.artifacts) = 0 THEN
      RAISE EXCEPTION 'a load run needs approved transformation code' USING ERRCODE = 'check_violation';
    END IF;
    FOR a IN SELECT * FROM jsonb_array_elements(NEW.artifacts) LOOP
      SELECT status, digest INTO st, dg FROM build_artifacts WHERE id = (a ->> 'id')::uuid;
      IF st IS DISTINCT FROM 'approved' OR dg IS DISTINCT FROM (a ->> 'digest') THEN
        RAISE EXCEPTION 'load runs use only approved code: artifact % is %', a ->> 'id', coalesce(st, 'missing')
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  IF NEW.artifacts IS DISTINCT FROM OLD.artifacts OR NEW.packs IS DISTINCT FROM OLD.packs
     OR NEW.input_digest IS DISTINCT FROM OLD.input_digest OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.extract_run_id IS DISTINCT FROM OLD.extract_run_id OR NEW.segment IS DISTINCT FROM OLD.segment THEN
    RAISE EXCEPTION 'load run % pins its inputs; start a new run instead', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER load_run_guard BEFORE INSERT OR UPDATE ON load_runs FOR EACH ROW EXECUTE FUNCTION load_run_guard();
CREATE TRIGGER recon_breaks_no_agent_closer BEFORE INSERT OR UPDATE ON recon_breaks
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('closed_by');
GRANT SELECT, INSERT, UPDATE ON load_runs, recon_breaks, coexistence_schedules TO astra_control_app;
GRANT SELECT, INSERT, UPDATE ON parity_runs TO astra_control_app;
""")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS load_run_guard ON load_runs; DROP FUNCTION IF EXISTS load_run_guard();")
    op.drop_table("coexistence_schedules")
    op.drop_index("ix_parity_project", "parity_runs")
    op.drop_table("parity_runs")
    op.drop_index("ix_break_project", "recon_breaks")
    op.drop_table("recon_breaks")
    op.drop_index("ix_load_run_project", "load_runs")
    op.drop_table("load_runs")
