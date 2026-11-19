"""Gates and proof packs (I11).

Rules enforced in the database:
- Gate evidence is attested and gates are approved only by people (forbid_agent_decider).
- A person approves a gate once per checklist digest.
- A gate passes only when every required role has an approval for exactly that checklist digest, from as many
  different people as there are roles.
- A proof pack is immutable once signed.

Revision ID: 0017
Revises: 0016
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "gate_evidence",
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("gate", sa.String(30), primary_key=True),
        sa.Column("item_key", sa.String(200), primary_key=True),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("reference", sa.String(1000), nullable=True),
        sa.Column("attested_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("attested_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("length(note) >= 10", name="ck_gate_evidence_note"),
    )
    op.create_table(
        "gate_approvals",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("gate", sa.String(30), nullable=False),
        sa.Column("role", sa.String(60), nullable=False),
        sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("checklist_digest", sa.String(64), nullable=False),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("project_id", "gate", "checklist_digest", "user_id", name="uq_gate_approval_person"),
        sa.UniqueConstraint("project_id", "gate", "checklist_digest", "role", name="uq_gate_approval_role"),
    )
    op.create_table(
        "gate_passes",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("gate", sa.String(30), nullable=False),
        sa.Column("checklist_digest", sa.String(64), nullable=False),
        sa.Column("required_roles", postgresql.ARRAY(sa.String(60)), nullable=False),
        sa.Column("checklist", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("project_id", "gate", "checklist_digest", name="uq_gate_pass"),
    )
    op.create_index("ix_gate_pass_project", "gate_passes", ["project_id", "gate", "created_at"])
    op.create_table(
        "proof_packs",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("project_id", sa.UUID(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("scope", sa.String(10), nullable=False),
        sa.Column("wave", sa.String(40), nullable=True),
        sa.Column("json_sha256", sa.String(64), nullable=False),
        sa.Column("pdf_sha256", sa.String(64), nullable=False),
        sa.Column("signature", sa.Text(), nullable=False),
        sa.Column("signing_key", sa.String(100), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("summary", JSONB, nullable=False),
        sa.Column("created_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("project_id", "number", name="uq_proof_pack_number"),
        sa.CheckConstraint("scope in ('project', 'wave')", name="ck_proof_scope"),
        sa.CheckConstraint("(scope = 'wave') = (wave IS NOT NULL)", name="ck_proof_wave"),
    )
    op.execute(r"""
CREATE TRIGGER gate_evidence_no_agent BEFORE INSERT OR UPDATE ON gate_evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('attested_by');
CREATE TRIGGER gate_approvals_no_agent BEFORE INSERT OR UPDATE ON gate_approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('user_id');

CREATE OR REPLACE FUNCTION gate_pass_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text; people int;
BEGIN
  FOREACH r IN ARRAY NEW.required_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM gate_approvals a WHERE a.project_id = NEW.project_id AND a.gate = NEW.gate
                   AND a.checklist_digest = NEW.checklist_digest AND a.role = r) THEN
      RAISE EXCEPTION 'gate % cannot pass: no % approval for this checklist', NEW.gate, r
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  SELECT count(DISTINCT user_id) INTO people FROM gate_approvals a WHERE a.project_id = NEW.project_id
    AND a.gate = NEW.gate AND a.checklist_digest = NEW.checklist_digest AND a.role = ANY(NEW.required_roles);
  IF people < cardinality(NEW.required_roles) THEN
    RAISE EXCEPTION 'gate % needs % different people to approve; it has %', NEW.gate,
      cardinality(NEW.required_roles), people USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gate_pass_guard BEFORE INSERT ON gate_passes FOR EACH ROW EXECUTE FUNCTION gate_pass_guard();

CREATE OR REPLACE FUNCTION proof_pack_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'proof pack % is signed and cannot change; produce a new one', OLD.number
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER proof_pack_immutable BEFORE UPDATE ON proof_packs FOR EACH ROW EXECUTE FUNCTION proof_pack_immutable();

GRANT SELECT, INSERT, UPDATE, DELETE ON gate_evidence TO astra_control_app;
GRANT SELECT, INSERT ON gate_approvals, gate_passes, proof_packs TO astra_control_app;
""")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS gate_pass_guard ON gate_passes; DROP FUNCTION IF EXISTS gate_pass_guard(); "
               "DROP TRIGGER IF EXISTS proof_pack_immutable ON proof_packs; "
               "DROP FUNCTION IF EXISTS proof_pack_immutable();")
    op.drop_table("proof_packs")
    op.drop_index("ix_gate_pass_project", "gate_passes")
    op.drop_table("gate_passes")
    op.drop_table("gate_approvals")
    op.drop_table("gate_evidence")
