"""Published packs and approved blueprint versions are immutable; grants for the new tables.

- A published pack's manifest, files, digest and version can never change. Its status may only move
  from published to deprecated (E04.F1.S1).
- An approved blueprint version's content can never change; changes create a new version (E03.F2.S4).

Revision ID: 0005
Revises: 0004
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

SQL = r"""
CREATE OR REPLACE FUNCTION packs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'published pack % @ % cannot be deleted', OLD.name, OLD.version USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.digest IS DISTINCT FROM OLD.digest
       OR NEW.name IS DISTINCT FROM OLD.name OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.type IS DISTINCT FROM OLD.type OR NEW.test_report IS DISTINCT FROM OLD.test_report
       OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'published pack % @ % is immutable; publish a new version', OLD.name, OLD.version
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW.status = OLD.status OR (OLD.status = 'published' AND NEW.status = 'deprecated')) THEN
      RAISE EXCEPTION 'pack status can only move from published to deprecated' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER packs_guard BEFORE UPDATE OR DELETE ON packs FOR EACH ROW EXECUTE FUNCTION packs_guard();

CREATE OR REPLACE FUNCTION pack_files_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM packs WHERE id = coalesce(NEW.pack_id, OLD.pack_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'files of a published pack are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER pack_files_guard BEFORE INSERT OR UPDATE OR DELETE ON pack_files
  FOR EACH ROW EXECUTE FUNCTION pack_files_guard();

CREATE OR REPLACE FUNCTION blueprint_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'blueprint versions are kept for traceability and cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.yaml_text IS DISTINCT FROM OLD.yaml_text OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.commit_sha IS DISTINCT FROM OLD.commit_sha OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.message IS DISTINCT FROM OLD.message THEN
    RAISE EXCEPTION 'a saved blueprint version cannot be changed; save a new version' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND NEW.status NOT IN ('approved', 'superseded') THEN
    RAISE EXCEPTION 'an approved blueprint version can only be superseded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER blueprint_versions_guard BEFORE UPDATE OR DELETE ON blueprint_versions
  FOR EACH ROW EXECUTE FUNCTION blueprint_versions_guard();

GRANT SELECT, INSERT, UPDATE, DELETE ON packs, pack_files, projects, blueprint_templates TO astra_control_app;
GRANT SELECT, INSERT, UPDATE ON blueprint_versions, blueprint_approvals, decisions TO astra_control_app;
"""


def upgrade() -> None:
    op.execute(SQL)


def downgrade() -> None:
    op.execute("""
DROP TRIGGER IF EXISTS blueprint_versions_guard ON blueprint_versions;
DROP TRIGGER IF EXISTS pack_files_guard ON pack_files;
DROP TRIGGER IF EXISTS packs_guard ON packs;
DROP FUNCTION IF EXISTS blueprint_versions_guard(); DROP FUNCTION IF EXISTS pack_files_guard();
DROP FUNCTION IF EXISTS packs_guard();
""")
