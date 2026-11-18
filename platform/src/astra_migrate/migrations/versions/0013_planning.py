"""Plan baselines, gaps and pre-sales estimates (I7).

Revision ID: 0013
Revises: 0012
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def _ts(name: str, nullable: bool = True) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "plan_baselines",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("summary", JSONB, nullable=False),
        sa.Column("changes", JSONB, nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("proposed_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("decided_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        _ts("decided_at"),
        sa.Column("decision_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("project_id", "number", name="uq_plan_baseline_number"),
        sa.CheckConstraint("status in ('proposed', 'approved', 'rejected', 'superseded')",
                           name="ck_plan_baseline_status"),
    )
    op.create_table(
        "gaps",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("scope_key", sa.String(400), nullable=True),
        sa.Column("route", sa.String(30), nullable=True),
        sa.Column("owner_user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("product", sa.String(100), nullable=True),
        sa.Column("vendor_ref", sa.String(100), nullable=True),
        sa.Column("blocks_waves", JSONB, nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("close_note", sa.Text(), nullable=True),
        sa.Column("closed_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        _ts("closed_at"),
        sa.Column("created_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("route is null or route in ('configuration', 'customer_extension', "
                           "'vendor_product_change', 'process_change')", name="ck_gap_route"),
        sa.CheckConstraint("status in ('open', 'closed')", name="ck_gap_status"),
        # A gap cannot close without a route and an owner (E19.F1.S1), whatever path writes it.
        sa.CheckConstraint("status <> 'closed' or (route is not null and owner_user_id is not null)",
                           name="ck_gap_close_needs_route_and_owner"),
    )
    op.create_index("ix_gap_project", "gaps", ["project_id", "status"])
    op.create_table(
        "presales_estimates",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("programme_id", sa.UUID(), sa.ForeignKey("programmes.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("estimation_packs", JSONB, nullable=False),
        sa.Column("questionnaire", JSONB, nullable=False),
        sa.Column("sample", JSONB, nullable=True),
        sa.Column("result", JSONB, nullable=False),
        sa.Column("created_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.execute("""
CREATE TRIGGER plan_baselines_no_agent_decider BEFORE INSERT OR UPDATE ON plan_baselines
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('decided_by');
CREATE TRIGGER gaps_no_agent_closer BEFORE INSERT OR UPDATE ON gaps
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('closed_by');
GRANT SELECT, INSERT, UPDATE ON plan_baselines, gaps TO astra_control_app;
GRANT SELECT, INSERT ON presales_estimates TO astra_control_app;
""")


def downgrade() -> None:
    op.drop_table("presales_estimates")
    op.drop_index("ix_gap_project", "gaps")
    op.drop_table("gaps")
    op.drop_table("plan_baselines")
