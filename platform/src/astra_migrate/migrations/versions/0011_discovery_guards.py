"""Grants for discovery tables; only people accept coverage reports.

Revision ID: 0011
Revises: 0010
"""

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
CREATE TRIGGER coverage_reports_no_agent_decider BEFORE INSERT OR UPDATE ON coverage_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('decided_by');
GRANT SELECT, INSERT ON activity_imports TO astra_control_app;
GRANT SELECT, INSERT, UPDATE ON discovery_runs, coverage_reports TO astra_control_app;
""")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS coverage_reports_no_agent_decider ON coverage_reports")
