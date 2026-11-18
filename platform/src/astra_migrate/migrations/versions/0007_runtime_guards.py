"""Hard rules for the agent runtime, enforced in the database (E02.F2.S2, E02.F1.S1, E02.F1.S2).

- An agent identity can never approve, decide, resolve a review item, release an agent, pin a version
  or hold a role. Every column that records who approved or decided is checked here, so no code path
  (and no bug) can make an agent an approver.
- A user's kind (person or agent) never changes after creation.
- A released agent version is immutable; its status can only move from released to deprecated.
- A finished agent test run cannot be rewritten.
- Model call records are append-only.
- New jobs wake idle workers through NOTIFY.

Revision ID: 0007
Revises: 0006
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

# (table, column holding the deciding user's id)
DECIDER_COLUMNS = [
    ("blueprint_approvals", "user_id"),
    ("decisions", "decided_by"),
    ("review_items", "resolved_by"),
    ("agent_versions", "released_by"),
    ("role_assignments", "user_id"),
    ("project_agent_pins", "pinned_by"),
    ("model_aliases", "updated_by"),
    ("model_providers", "created_by"),
]

SQL = r"""
ALTER TABLE users ADD CONSTRAINT ck_user_kind CHECK (kind in ('person', 'agent'));

CREATE OR REPLACE FUNCTION users_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'a user''s kind (person or agent) cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind = 'agent' AND (NEW.issuer IS NOT NULL OR NEW.subject IS NOT NULL) THEN
    RAISE EXCEPTION 'an agent identity cannot be linked to a sign-in' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_kind_guard BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_kind_guard();

-- TG_ARGV[0] names the column that holds the deciding user's id.
CREATE OR REPLACE FUNCTION forbid_agent_decider() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE uid uuid; k text;
BEGIN
  uid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF uid IS NOT NULL THEN
    SELECT kind INTO k FROM users WHERE id = uid;
    IF k = 'agent' THEN
      RAISE EXCEPTION 'an agent identity cannot be recorded as %.% (agents propose, people decide)',
        TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION agent_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'released agent version % @ % cannot be deleted', OLD.agent_name, OLD.version
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.digest IS DISTINCT FROM OLD.digest
       OR NEW.agent_name IS DISTINCT FROM OLD.agent_name OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.released_by IS DISTINCT FROM OLD.released_by OR NEW.released_at IS DISTINCT FROM OLD.released_at
       OR NEW.released_test_run_id IS DISTINCT FROM OLD.released_test_run_id THEN
      RAISE EXCEPTION 'released agent version % @ % is immutable; register a new version', OLD.agent_name, OLD.version
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW.status = OLD.status OR (OLD.status = 'released' AND NEW.status = 'deprecated')) THEN
      RAISE EXCEPTION 'agent version status can only move from released to deprecated' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_versions_guard BEFORE UPDATE OR DELETE ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION agent_versions_guard();

CREATE OR REPLACE FUNCTION agent_test_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent test runs are kept as test history and cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('passed', 'failed', 'blocked', 'error') THEN
    RAISE EXCEPTION 'a finished agent test run cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_test_runs_guard BEFORE UPDATE OR DELETE ON agent_test_runs
  FOR EACH ROW EXECUTE FUNCTION agent_test_runs_guard();

CREATE OR REPLACE FUNCTION model_calls_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'model call records are append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER model_calls_no_update BEFORE UPDATE OR DELETE ON model_calls
  FOR EACH ROW EXECUTE FUNCTION model_calls_append_only();
CREATE TRIGGER model_calls_no_truncate BEFORE TRUNCATE ON model_calls
  FOR EACH STATEMENT EXECUTE FUNCTION model_calls_append_only();

CREATE OR REPLACE FUNCTION jobs_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('astra_jobs', NEW.kind);
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_notify AFTER INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_notify();

GRANT SELECT, INSERT, UPDATE ON jobs, model_providers, model_aliases, agents, agent_versions, agent_test_runs,
  agent_runs, review_items, project_stages TO astra_control_app;
GRANT DELETE ON model_providers, model_aliases, project_agent_pins, agent_versions TO astra_control_app;
GRANT SELECT, INSERT, UPDATE ON project_agent_pins TO astra_control_app;
GRANT SELECT, INSERT ON model_calls TO astra_control_app;
"""


def upgrade() -> None:
    op.execute(SQL)
    for table, column in DECIDER_COLUMNS:
        op.execute(f"CREATE TRIGGER {table}_no_agent_decider BEFORE INSERT OR UPDATE ON {table} "
                   f"FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('{column}')")


def downgrade() -> None:
    for table, _ in DECIDER_COLUMNS:
        op.execute(f"DROP TRIGGER IF EXISTS {table}_no_agent_decider ON {table}")
    op.execute("""
DROP TRIGGER IF EXISTS jobs_notify ON jobs; DROP FUNCTION IF EXISTS jobs_notify();
DROP TRIGGER IF EXISTS model_calls_no_update ON model_calls; DROP TRIGGER IF EXISTS model_calls_no_truncate ON model_calls;
DROP FUNCTION IF EXISTS model_calls_append_only();
DROP TRIGGER IF EXISTS agent_test_runs_guard ON agent_test_runs; DROP FUNCTION IF EXISTS agent_test_runs_guard();
DROP TRIGGER IF EXISTS agent_versions_guard ON agent_versions; DROP FUNCTION IF EXISTS agent_versions_guard();
DROP FUNCTION IF EXISTS forbid_agent_decider();
DROP TRIGGER IF EXISTS users_kind_guard ON users; DROP FUNCTION IF EXISTS users_kind_guard();
ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_user_kind;
""")
