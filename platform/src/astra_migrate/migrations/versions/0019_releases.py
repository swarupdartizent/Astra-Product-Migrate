"""Release records (I13): each evaluated release with its scorecard and its comparison with the previous release.

A release is `released` only when it has no regressions (enforced in the database); otherwise it is recorded as
`blocked`, with what fell. Release records are append-only.

Revision ID: 0019
Revises: 0018
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "releases",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("scorecard", JSONB, nullable=False),
        sa.Column("baseline_release", sa.String(60), nullable=True),
        sa.Column("regressions", JSONB, nullable=False),
        sa.Column("improved", JSONB, nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("recorded_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("status in ('released', 'blocked')", name="ck_release_status"),
        sa.CheckConstraint("status <> 'released' OR regressions = '[]'::jsonb", name="ck_release_no_regressions"),
        sa.CheckConstraint("length(reason) >= 10", name="ck_release_reason"),
    )
    op.create_index("ix_release_created", "releases", ["created_at"])
    op.create_index("uq_release_name_released", "releases", ["name"], unique=True,
                    postgresql_where=sa.text("status = 'released'"))
    op.execute(r"""
CREATE OR REPLACE FUNCTION releases_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'release records are append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER releases_append_only BEFORE UPDATE OR DELETE ON releases
  FOR EACH ROW EXECUTE FUNCTION releases_append_only();
CREATE TRIGGER releases_no_agent BEFORE INSERT ON releases
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('recorded_by');
GRANT SELECT, INSERT ON releases TO astra_control_app;
""")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS releases_append_only ON releases; "
               "DROP FUNCTION IF EXISTS releases_append_only();")
    op.drop_index("uq_release_name_released", "releases")
    op.drop_index("ix_release_created", "releases")
    op.drop_table("releases")
