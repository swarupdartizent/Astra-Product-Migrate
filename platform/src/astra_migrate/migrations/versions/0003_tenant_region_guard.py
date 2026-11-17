"""A tenant's region can change only while a recorded region migration task is running (E01.F1.S2).

Revision ID: 0003
Revises: 0002
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(r"""
CREATE OR REPLACE FUNCTION tenants_region_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.region_code IS DISTINCT FROM OLD.region_code THEN
    IF NOT EXISTS (
      SELECT 1 FROM region_migrations m
      WHERE m.tenant_id = NEW.id AND m.to_region = NEW.region_code
        AND m.from_region = OLD.region_code AND m.status = 'running'
    ) THEN
      RAISE EXCEPTION 'tenant region can only change through a recorded region migration task'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.db_name IS DISTINCT FROM OLD.db_name
     OR NEW.key_name IS DISTINCT FROM OLD.key_name THEN
    RAISE EXCEPTION 'tenant identity, database and key names are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenants_region_guard BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_region_guard();
""")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS tenants_region_guard ON tenants; DROP FUNCTION IF EXISTS tenants_region_guard();")
