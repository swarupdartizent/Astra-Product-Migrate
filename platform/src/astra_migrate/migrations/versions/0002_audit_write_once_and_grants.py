"""Write-once, hash-chained audit log and least-privilege grants for the runtime role.

- The runtime role `astra_control_app` may only SELECT and INSERT audit rows.
- Triggers reject UPDATE, DELETE and TRUNCATE on audit tables for every role.
- A BEFORE INSERT trigger assigns the sequence number, server timestamp, previous hash and hash,
  so application code cannot forge any of them.
- audit_hash() is the single definition of the hash, used both on insert and on verification.

Revision ID: 0002
Revises: 0001
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

APP_ROLE = "astra_control_app"

UPGRADE_SQL = r"""
ALTER TABLE audit_events ALTER COLUMN seq DROP DEFAULT;
DROP SEQUENCE IF EXISTS audit_events_seq_seq;

CREATE OR REPLACE FUNCTION audit_hash(e audit_events) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    e.seq::text || '|' || e.prev_hash || '|' ||
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
    e.actor_type || '|' || e.actor_id || '|' || e.actor_name || '|' || e.action || '|' || e.outcome || '|' ||
    coalesce(e.tenant_id::text, '') || '|' || coalesce(e.project_id::text, '') || '|' ||
    coalesce(e.target_type, '') || '|' || coalesce(e.target_id, '') || '|' ||
    e.details::text || '|' || coalesce(e.trace_id, ''),
  'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION audit_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  -- Serialise appends so the chain is strictly linear.
  PERFORM pg_advisory_xact_lock(hashtext('astra.audit_events'));
  SELECT seq, hash INTO last_seq, last_hash FROM audit_events ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.occurred_at := date_trunc('microseconds', clock_timestamp());
  NEW.details := coalesce(NEW.details, '{}'::jsonb);
  NEW.hash := audit_hash(NEW);
  RETURN NEW;
END $$;

CREATE TRIGGER audit_events_before_insert BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_before_insert();

CREATE OR REPLACE FUNCTION audit_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit records are write-once: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_reject_change();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_reject_change();
CREATE TRIGGER audit_anchors_no_update BEFORE UPDATE OR DELETE ON audit_anchors
  FOR EACH ROW EXECUTE FUNCTION audit_reject_change();
CREATE TRIGGER audit_anchors_no_truncate BEFORE TRUNCATE ON audit_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION audit_reject_change();

-- Runtime role: least privilege.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO {app};
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, programmes, partners, tenants, region_migrations, role_assignments, connector_secrets, trace_spans
  TO {app};
GRANT SELECT, INSERT ON audit_events, audit_anchors TO {app};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO {app};
GRANT SELECT ON alembic_version TO {app};
""".replace("{app}", APP_ROLE)

DOWNGRADE_SQL = """
DROP TRIGGER IF EXISTS audit_anchors_no_truncate ON audit_anchors;
DROP TRIGGER IF EXISTS audit_anchors_no_update ON audit_anchors;
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
DROP TRIGGER IF EXISTS audit_events_before_insert ON audit_events;
DROP FUNCTION IF EXISTS audit_reject_change();
DROP FUNCTION IF EXISTS audit_before_insert();
DROP FUNCTION IF EXISTS audit_hash(audit_events);
"""


def upgrade() -> None:
    op.execute(UPGRADE_SQL)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
