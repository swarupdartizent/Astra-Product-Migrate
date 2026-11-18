"""Version delta runs, conversion runs and the hosting checklist (I6).

Revision ID: 0012
Revises: 0011
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

RUN_STATUSES = "status in ('queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')"
JSONB = postgresql.JSONB(astext_type=sa.Text())


def _run_columns() -> list[sa.Column]:  # type: ignore[type-arg]
    return [
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("connection_id", sa.UUID(), sa.ForeignKey("source_connections.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("baseline_id", sa.UUID(), sa.ForeignKey("target_baselines.id", ondelete="RESTRICT"),
                  nullable=False),
    ]


def _tail() -> list[sa.Column]:  # type: ignore[type-arg]
    return [
        sa.Column("job_id", sa.UUID(), nullable=True),
        sa.Column("requested_by", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    ]


def upgrade() -> None:
    op.create_table(
        "delta_runs", *_run_columns(),
        sa.Column("standard_baseline_id", sa.UUID(), sa.ForeignKey("target_baselines.id", ondelete="RESTRICT"),
                  nullable=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("counts", JSONB, nullable=False),
        sa.Column("origin_counts", JSONB, nullable=False),
        sa.Column("not_in_scope", sa.Integer(), nullable=False),
        sa.Column("new_in_target", sa.Integer(), nullable=False),
        sa.Column("input_digest", sa.String(64), nullable=True),
        sa.Column("result_digest", sa.String(64), nullable=True),
        sa.Column("advice", JSONB, nullable=False),
        *_tail(),
        sa.CheckConstraint(RUN_STATUSES, name="ck_delta_status"),
    )
    op.create_index("ix_delta_project", "delta_runs", ["project_id", "created_at"])
    op.create_table(
        "conversion_runs", *_run_columns(),
        sa.Column("source_dialect", sa.String(30), nullable=False),
        sa.Column("target_dialect", sa.String(30), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("summary", JSONB, nullable=False),
        *_tail(),
        sa.CheckConstraint(RUN_STATUSES, name="ck_conversion_status"),
    )
    op.create_index("ix_conversion_project", "conversion_runs", ["project_id", "created_at"])
    op.create_table(
        "checklist_items",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("category", sa.String(40), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("source", JSONB, nullable=False),
        sa.Column("owner_user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("owner_role", sa.String(60), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("project_id", "key", name="uq_checklist_key"),
        sa.CheckConstraint("status in ('open', 'in_progress', 'done', 'not_applicable')", name="ck_checklist_status"),
    )
    op.execute("""
CREATE TRIGGER checklist_items_no_agent_updater BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('updated_by');
GRANT SELECT, INSERT, UPDATE ON delta_runs, conversion_runs, checklist_items TO astra_control_app;
""")


def downgrade() -> None:
    op.drop_table("checklist_items")
    op.drop_index("ix_conversion_project", "conversion_runs")
    op.drop_table("conversion_runs")
    op.drop_index("ix_delta_project", "delta_runs")
    op.drop_table("delta_runs")
