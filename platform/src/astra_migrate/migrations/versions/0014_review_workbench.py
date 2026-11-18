"""Review workbench (I8): risk, confidence, compliance impact, stream and segment on review items; named
reviewers; two-person approval; reject and change-request outcomes; precedent keys.

Rules enforced in the database, so no code path can skip them:
- An approval is recorded per person (review_approvals); an agent identity cannot approve (forbid_agent_decider),
  and the person who requested an item cannot approve it.
- An item is resolved as approved only when it holds as many distinct approvals as it requires.
- A compliance-critical item is decided only when it has a named reviewer.

Revision ID: 0014
Revises: 0013
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.add_column("review_items", sa.Column("stream", sa.String(30), nullable=True))
    op.add_column("review_items", sa.Column("segment", sa.String(100), nullable=True))
    op.add_column("review_items", sa.Column("subject_type", sa.String(40), nullable=False, server_default="decision"))
    op.add_column("review_items", sa.Column("risk", sa.String(10), nullable=False, server_default="medium"))
    op.add_column("review_items", sa.Column("confidence", sa.Float(), nullable=True))
    op.add_column("review_items", sa.Column("compliance", sa.String(10), nullable=False, server_default="none"))
    op.add_column("review_items", sa.Column("compliance_controls", JSONB, nullable=False,
                                            server_default=sa.text("'[]'::jsonb")))
    op.add_column("review_items", sa.Column("required_approvals", sa.SmallInteger(), nullable=False,
                                            server_default="1"))
    op.add_column("review_items", sa.Column("pattern_key", sa.String(200), nullable=True))
    op.add_column("review_items", sa.Column("evidence", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")))
    op.add_column("review_items", sa.Column("outcome", sa.String(20), nullable=True))
    op.add_column("review_items", sa.Column("changed_value", sa.Text(), nullable=True))
    op.add_column("review_items", sa.Column("follow_up_run_id", sa.UUID(), nullable=True))
    op.drop_constraint("ck_review_status", "review_items", type_="check")
    op.create_check_constraint("ck_review_status", "review_items",
                               "status in ('open', 'resolved', 'dismissed', 'rejected', 'changes_requested')")
    op.create_check_constraint("ck_review_risk", "review_items", "risk in ('low', 'medium', 'high', 'critical')")
    op.create_check_constraint("ck_review_compliance", "review_items", "compliance in ('none', 'relevant', 'critical')")
    op.create_check_constraint("ck_review_confidence", "review_items",
                               "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)")
    op.create_check_constraint("ck_review_required_approvals", "review_items", "required_approvals in (1, 2)")
    op.create_check_constraint("ck_review_outcome", "review_items",
                               "outcome IS NULL OR outcome in ('approved', 'rejected', 'changed', 'dismissed')")
    op.create_index("ix_review_pattern", "review_items", ["tenant_id", "pattern_key", "status"])
    op.create_table(
        "review_approvals",
        sa.Column("item_id", sa.UUID(), sa.ForeignKey("review_items.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("option", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.execute(r"""
CREATE TRIGGER review_approvals_no_agent BEFORE INSERT OR UPDATE ON review_approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('user_id');

CREATE OR REPLACE FUNCTION review_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester text; st text;
BEGIN
  SELECT requested_by ->> 'id', status INTO requester, st FROM review_items WHERE id = NEW.item_id;
  IF st <> 'open' THEN
    RAISE EXCEPTION 'review item % is %; approvals are recorded only on open items', NEW.item_id, st
      USING ERRCODE = 'check_violation';
  END IF;
  IF requester IS NOT NULL AND requester = NEW.user_id::text THEN
    RAISE EXCEPTION 'the person who requested a review item cannot approve it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_approval_guard BEFORE INSERT ON review_approvals
  FOR EACH ROW EXECUTE FUNCTION review_approval_guard();

CREATE OR REPLACE FUNCTION review_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'open' THEN
    IF NEW.compliance = 'critical' AND NEW.owner_user_id IS NULL THEN
      RAISE EXCEPTION 'a compliance-critical review item is decided only by a named reviewer'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.outcome = 'approved' THEN
      SELECT count(*) INTO n FROM review_approvals WHERE item_id = NEW.id;
      IF n < NEW.required_approvals THEN
        RAISE EXCEPTION 'review item % needs % approval(s) from different people; it has %',
          NEW.id, NEW.required_approvals, n USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_decision_guard BEFORE UPDATE ON review_items
  FOR EACH ROW EXECUTE FUNCTION review_decision_guard();

GRANT SELECT, INSERT, DELETE ON review_approvals TO astra_control_app;
""")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS review_decision_guard ON review_items; "
               "DROP FUNCTION IF EXISTS review_decision_guard(); DROP FUNCTION IF EXISTS review_approval_guard();")
    op.drop_table("review_approvals")
    op.drop_index("ix_review_pattern", "review_items")
    for c in ("ck_review_outcome", "ck_review_required_approvals", "ck_review_confidence", "ck_review_compliance",
              "ck_review_risk", "ck_review_status"):
        op.drop_constraint(c, "review_items", type_="check")
    op.execute("UPDATE review_items SET status = 'dismissed' WHERE status IN ('rejected', 'changes_requested')")
    op.create_check_constraint("ck_review_status", "review_items", "status in ('open', 'resolved', 'dismissed')")
    for c in ("follow_up_run_id", "changed_value", "outcome", "evidence", "pattern_key", "required_approvals",
              "compliance_controls", "compliance", "confidence", "risk", "subject_type", "segment", "stream"):
        op.drop_column("review_items", c)
