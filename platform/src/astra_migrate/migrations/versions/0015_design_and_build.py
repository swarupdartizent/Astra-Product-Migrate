"""Design and build (I9): design runs and versioned build artifacts.

Rules enforced in the database:
- A build artifact (transformation code or modernized customer code) is approved only when the tests of exactly its
  current version passed, and only by a person (forbid_agent_decider).
- An artifact's digest never changes after it is created: a change is a new version.
- Approval comes only from the tests-passed state, and approved or superseded artifacts are not reopened.

Revision ID: 0015
Revises: 0014
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())
RUN_STATUSES = "status in ('queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')"


def upgrade() -> None:
    op.create_table(
        "design_runs",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("connection_id", sa.UUID(), sa.ForeignKey("source_connections.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("summary", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("job_id", sa.UUID(), nullable=True),
        sa.Column("requested_by", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(RUN_STATUSES, name="ck_design_run_status"),
    )
    op.create_index("ix_design_run_project", "design_runs", ["project_id", "created_at"])
    op.create_table(
        "build_artifacts",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("inputs_digest", sa.String(64), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("tests_digest", sa.String(64), nullable=True),
        sa.Column("test_summary", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_by", JSONB, nullable=False),
        sa.Column("approved_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approval_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("project_id", "kind", "name", "version", name="uq_build_artifact_version"),
        sa.CheckConstraint("kind in ('transformation', 'code_object')", name="ck_build_kind"),
        sa.CheckConstraint("status in ('generated', 'tests_failed', 'tests_passed', 'approved', 'superseded')",
                           name="ck_build_status"),
        sa.CheckConstraint("status <> 'approved' OR (tests_digest = digest AND approved_by IS NOT NULL)",
                           name="ck_build_approved_needs_passing_tests"),
        sa.CheckConstraint("status not in ('tests_passed', 'approved') OR tests_digest = digest",
                           name="ck_build_passed_is_this_version"),
    )
    op.create_index("ix_build_project", "build_artifacts", ["project_id", "kind", "name"])
    op.execute(r"""
CREATE TRIGGER build_artifacts_no_agent_approver BEFORE INSERT OR UPDATE ON build_artifacts
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('approved_by');

CREATE OR REPLACE FUNCTION build_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.digest IS DISTINCT FROM OLD.digest OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.name IS DISTINCT FROM OLD.name OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'build artifact % version % is immutable; generate a new version', OLD.name, OLD.version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'approved' AND OLD.status <> 'approved' AND OLD.status <> 'tests_passed' THEN
    RAISE EXCEPTION 'build artifact % version % can be approved only after its tests pass', OLD.name, OLD.version
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('approved', 'superseded') AND NEW.status NOT IN ('approved', 'superseded') THEN
    RAISE EXCEPTION 'build artifact % version % is %; it cannot be reopened', OLD.name, OLD.version, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER build_artifact_guard BEFORE UPDATE ON build_artifacts
  FOR EACH ROW EXECUTE FUNCTION build_artifact_guard();

GRANT SELECT, INSERT, UPDATE ON design_runs, build_artifacts TO astra_control_app;
""")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS build_artifact_guard ON build_artifacts; "
               "DROP FUNCTION IF EXISTS build_artifact_guard();")
    op.drop_index("ix_build_project", "build_artifacts")
    op.drop_table("build_artifacts")
    op.drop_index("ix_design_run_project", "design_runs")
    op.drop_table("design_runs")
