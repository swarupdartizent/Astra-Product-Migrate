"""Installed-base programmes (I12): programme set-up, segments, pods, programme waves, customer consent, fleet scans
and portfolio plans.

Rules enforced in the database:
- A customer's partner belongs to the customer's programme.
- A fleet scan needs a consent recorded for that customer and not revoked.
- A consent, once revoked, stays revoked (consents are never reinstated; a new one is recorded instead).

Revision ID: 0018
Revises: 0017
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())
RUN_STATUSES = "status in ('queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')"


def upgrade() -> None:
    op.add_column("programmes", sa.Column("source_adapter", sa.String(120), nullable=True))
    op.add_column("programmes", sa.Column("target_adapter", sa.String(120), nullable=True))
    op.add_column("programmes", sa.Column("blueprint_template", sa.String(100), nullable=True))
    op.add_column("programmes", sa.Column("packs", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")))
    op.add_column("programmes", sa.Column("segments", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")))
    op.add_column("programmes", sa.Column("mci_config", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")))
    op.add_column("programmes", sa.Column("band_effort_weeks", JSONB, nullable=False,
                                          server_default=sa.text("'{\"simple\": 8, \"medium\": 16, \"complex\": 26}'"
                                                                 "::jsonb")))
    op.add_column("tenants", sa.Column("segment", sa.String(100), nullable=True))
    op.create_table(
        "pods",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("partner_id", sa.UUID(), sa.ForeignKey("partners.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("partner_id", "name", name="uq_pod_name"),
        sa.CheckConstraint("capacity between 1 and 50", name="ck_pod_capacity"),
    )
    op.create_table(
        "programme_waves",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("programme_id", sa.UUID(), sa.ForeignKey("programmes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key", sa.String(40), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.UniqueConstraint("programme_id", "key", name="uq_programme_wave"),
        sa.CheckConstraint("end_date >= start_date", name="ck_programme_wave_dates"),
    )
    op.create_table(
        "customer_consents",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("signatory_name", sa.String(200), nullable=False),
        sa.Column("signatory_title", sa.String(200), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("reference", sa.String(1000), nullable=False),
        sa.Column("recorded_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("revoke_reason", sa.Text(), nullable=True),
    )
    op.create_table(
        "fleet_scans",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("programme_id", sa.UUID(), sa.ForeignKey("programmes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("connection_id", sa.UUID(), sa.ForeignKey("source_connections.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("consent_id", sa.UUID(), sa.ForeignKey("customer_consents.id"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("measures", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("mci", JSONB, nullable=True),
        sa.Column("job_id", sa.UUID(), nullable=True),
        sa.Column("requested_by", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(RUN_STATUSES, name="ck_fleet_scan_status"),
    )
    op.create_index("ix_fleet_scan_tenant", "fleet_scans", ["tenant_id", "created_at"])
    op.create_table(
        "portfolio_plans",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("programme_id", sa.UUID(), sa.ForeignKey("programmes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("result", JSONB, nullable=False),
        sa.Column("created_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("programme_id", "number", name="uq_portfolio_plan_number"),
    )
    op.execute(r"""
CREATE OR REPLACE FUNCTION tenant_partner_programme() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prog uuid;
BEGIN
  IF NEW.partner_id IS NOT NULL THEN
    SELECT programme_id INTO prog FROM partners WHERE id = NEW.partner_id;
    IF NEW.programme_id IS DISTINCT FROM prog THEN
      RAISE EXCEPTION 'a customer''s partner must belong to the customer''s programme'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_partner_programme BEFORE INSERT OR UPDATE OF partner_id, programme_id ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenant_partner_programme();

CREATE OR REPLACE FUNCTION fleet_scan_needs_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_consents c WHERE c.id = NEW.consent_id AND c.tenant_id = NEW.tenant_id
                 AND c.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a fleet scan needs the customer''s consent, recorded and not revoked'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_scan_needs_consent BEFORE INSERT ON fleet_scans
  FOR EACH ROW EXECUTE FUNCTION fleet_scan_needs_consent();

CREATE OR REPLACE FUNCTION consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked consent stays revoked; record a new consent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.signatory_name IS DISTINCT FROM OLD.signatory_name OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'a recorded consent cannot be edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_guard BEFORE UPDATE ON customer_consents FOR EACH ROW EXECUTE FUNCTION consent_guard();
CREATE TRIGGER consent_no_agent BEFORE INSERT OR UPDATE ON customer_consents
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('recorded_by');

GRANT SELECT, INSERT, UPDATE, DELETE ON pods, programme_waves TO astra_control_app;
GRANT SELECT, INSERT, UPDATE ON customer_consents, fleet_scans TO astra_control_app;
GRANT SELECT, INSERT ON portfolio_plans TO astra_control_app;
""")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS tenant_partner_programme ON tenants; "
               "DROP FUNCTION IF EXISTS tenant_partner_programme(); "
               "DROP FUNCTION IF EXISTS fleet_scan_needs_consent(); DROP FUNCTION IF EXISTS consent_guard();")
    op.drop_table("portfolio_plans")
    op.drop_index("ix_fleet_scan_tenant", "fleet_scans")
    op.drop_table("fleet_scans")
    op.drop_table("customer_consents")
    op.drop_table("programme_waves")
    op.drop_table("pods")
    op.drop_column("tenants", "segment")
    for c in ("band_effort_weeks", "mci_config", "segments", "packs", "blueprint_template", "target_adapter",
              "source_adapter"):
        op.drop_column("programmes", c)
