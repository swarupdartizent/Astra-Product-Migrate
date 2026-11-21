"""Learning from delivered work (I14).

- Bulk approval (E16.F1.S5): a reviewer approves the open items that share one evidence pattern in one batch. Each
  item still gets its own approval row, linked to the batch. The database refuses a bulk approval of a
  compliance-critical item, or of an item whose pattern is not the batch's.
- Complexity Index versions (E18.F2.S3): every set of weights a programme uses is stored, numbered and dated
  (append-only). Contracted bands are stored once per customer and never change (append-only).

Revision ID: 0020
Revises: 0019
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "review_bulk_batches",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("pattern_key", sa.String(200), nullable=False),
        sa.Column("option", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("item_ids", JSONB, nullable=False),
        sa.Column("decided_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("length(note) >= 10", name="ck_bulk_note"),
        sa.CheckConstraint("jsonb_array_length(item_ids) between 2 and 200", name="ck_bulk_size"),
    )
    op.create_index("ix_bulk_project", "review_bulk_batches", ["project_id", "created_at"])
    op.add_column("review_approvals", sa.Column("bulk_batch_id", sa.UUID(),
                                                sa.ForeignKey("review_bulk_batches.id"), nullable=True))

    op.create_table(
        "mci_weight_versions",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("programme_id", sa.UUID(), sa.ForeignKey("programmes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("weights", JSONB, nullable=False),
        sa.Column("ranges", JSONB, nullable=False),
        sa.Column("bands", JSONB, nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("after_wave", sa.String(40), nullable=True),
        sa.Column("basis", JSONB, nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("programme_id", "number", name="uq_mci_version"),
        sa.CheckConstraint("source in ('starting', 'manual', 'recalibration')", name="ck_mci_version_source"),
        sa.CheckConstraint("source <> 'recalibration' OR after_wave IS NOT NULL", name="ck_mci_version_wave"),
        sa.CheckConstraint("length(reason) >= 10", name="ck_mci_version_reason"),
    )
    op.create_table(
        "band_contracts",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("programme_id", sa.UUID(), sa.ForeignKey("programmes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False,
                  unique=True),
        sa.Column("band", sa.String(20), nullable=False),
        sa.Column("score", sa.Numeric(), nullable=False),
        sa.Column("weights_version", sa.Integer(), nullable=False),
        sa.Column("scan_id", sa.UUID(), sa.ForeignKey("fleet_scans.id"), nullable=False),
        sa.Column("reference", sa.String(300), nullable=False),
        sa.Column("contracted_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("contracted_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("band in ('simple', 'medium', 'complex')", name="ck_band_contract_band"),
        sa.CheckConstraint("length(reference) >= 3", name="ck_band_contract_reference"),
    )
    op.execute(r"""
CREATE OR REPLACE FUNCTION learning_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER review_bulk_batches_append_only BEFORE UPDATE OR DELETE ON review_bulk_batches
  FOR EACH ROW EXECUTE FUNCTION learning_append_only();
CREATE TRIGGER mci_weight_versions_append_only BEFORE UPDATE OR DELETE ON mci_weight_versions
  FOR EACH ROW EXECUTE FUNCTION learning_append_only();
CREATE TRIGGER band_contracts_append_only BEFORE UPDATE OR DELETE ON band_contracts
  FOR EACH ROW EXECUTE FUNCTION learning_append_only();
CREATE TRIGGER review_bulk_batches_no_agent BEFORE INSERT ON review_bulk_batches
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('decided_by');
CREATE TRIGGER mci_weight_versions_no_agent BEFORE INSERT ON mci_weight_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('created_by');
CREATE TRIGGER band_contracts_no_agent BEFORE INSERT ON band_contracts
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('contracted_by');

-- A bulk approval: never of a compliance-critical item, only of an item with the batch's pattern, by the batch's
-- reviewer.
CREATE OR REPLACE FUNCTION review_bulk_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b review_bulk_batches%ROWTYPE; i review_items%ROWTYPE;
BEGIN
  IF NEW.bulk_batch_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO b FROM review_bulk_batches WHERE id = NEW.bulk_batch_id;
  SELECT * INTO i FROM review_items WHERE id = NEW.item_id;
  IF i.compliance = 'critical' THEN
    RAISE EXCEPTION 'compliance-critical items cannot be approved in bulk' USING ERRCODE = 'check_violation';
  END IF;
  IF i.pattern_key IS DISTINCT FROM b.pattern_key OR i.project_id <> b.project_id THEN
    RAISE EXCEPTION 'a bulk approval covers only items with the batch''s evidence pattern'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.user_id <> b.decided_by OR NEW.option <> b.option THEN
    RAISE EXCEPTION 'a bulk approval records the batch''s reviewer and option' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_bulk_guard BEFORE INSERT OR UPDATE ON review_approvals
  FOR EACH ROW EXECUTE FUNCTION review_bulk_guard();

GRANT SELECT, INSERT ON review_bulk_batches, mci_weight_versions, band_contracts TO astra_control_app;
""")


def downgrade() -> None:
    op.execute("""
DROP TRIGGER IF EXISTS review_bulk_guard ON review_approvals;
DROP FUNCTION IF EXISTS review_bulk_guard();
""")
    op.drop_column("review_approvals", "bulk_batch_id")
    op.drop_table("band_contracts")
    op.drop_table("mci_weight_versions")
    op.drop_index("ix_bulk_project", "review_bulk_batches")
    op.drop_table("review_bulk_batches")
    op.execute("DROP FUNCTION IF EXISTS learning_append_only();")
