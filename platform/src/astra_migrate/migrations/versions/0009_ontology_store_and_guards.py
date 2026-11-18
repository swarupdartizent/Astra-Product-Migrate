"""Ontology store (graph tables + pgvector index), append-only load calls, grants for I4 tables.

The vector extension is created by the platform bootstrap (it needs a superuser); this migration only
uses it.

Revision ID: 0009
Revises: 0008
"""

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

SQL = r"""
CREATE TABLE onto_concepts (
  pack_id     uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  pack_ref    varchar(100) NOT NULL,
  concept_id  varchar(120) NOT NULL,
  namespace   varchar(60) NOT NULL,
  label       varchar(120) NOT NULL,
  definition  text NOT NULL,
  synonyms    text[] NOT NULL DEFAULT '{}',
  parent      varchar(120),
  attributes  jsonb NOT NULL DEFAULT '[]',
  standards   text[] NOT NULL DEFAULT '{}',
  embedding   vector(384) NOT NULL,
  embedder    varchar(40) NOT NULL,
  PRIMARY KEY (pack_id, concept_id)
);
CREATE INDEX ix_onto_concept_id ON onto_concepts (concept_id);
CREATE INDEX ix_onto_concept_parent ON onto_concepts (parent);
CREATE INDEX ix_onto_concept_embedding ON onto_concepts USING hnsw (embedding vector_cosine_ops);

CREATE TABLE onto_relations (
  pack_id     uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  source      varchar(120) NOT NULL,
  name        varchar(60) NOT NULL,
  type        varchar(30) NOT NULL,
  target      varchar(120) NOT NULL,
  cardinality varchar(10) NOT NULL,
  description text NOT NULL DEFAULT '',
  PRIMARY KEY (pack_id, source, name)
);
CREATE INDEX ix_onto_relation_target ON onto_relations (target);

CREATE TABLE onto_code_lists (
  pack_id     uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  list_id     varchar(120) NOT NULL,
  title       text NOT NULL,
  standard    text NOT NULL,
  code_values jsonb NOT NULL,
  PRIMARY KEY (pack_id, list_id)
);

CREATE TABLE onto_bindings (
  pack_id     uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  adapter_ref varchar(100) NOT NULL,
  concept_id  varchar(120) NOT NULL,
  entity      varchar(64) NOT NULL,
  table_name  varchar(256) NOT NULL,
  attributes  jsonb NOT NULL,
  relations   jsonb NOT NULL,
  validated   boolean NOT NULL,
  PRIMARY KEY (pack_id, entity)
);
CREATE INDEX ix_onto_binding_concept ON onto_bindings (concept_id);

-- Mapping decisions people made, recorded by the review workbench (I8). Read by get_precedents.
CREATE TABLE onto_precedents (
  id             uuid PRIMARY KEY,
  concept_id     varchar(120) NOT NULL,
  adapter_ref    varchar(100) NOT NULL,
  legacy_element text NOT NULL,
  target_element text,
  decision       varchar(30) NOT NULL,
  rationale      text NOT NULL DEFAULT '',
  decided_by_name varchar(200) NOT NULL,
  project_id     uuid,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_onto_precedent_concept ON onto_precedents (concept_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION load_calls_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'load call records are append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER load_calls_no_update BEFORE UPDATE OR DELETE ON load_calls
  FOR EACH ROW EXECUTE FUNCTION load_calls_append_only();

CREATE TRIGGER curated_traps_no_agent_decider BEFORE INSERT OR UPDATE ON curated_traps
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('created_by');
CREATE TRIGGER project_baselines_no_agent_decider BEFORE INSERT OR UPDATE ON project_baselines
  FOR EACH ROW EXECUTE FUNCTION forbid_agent_decider('pinned_by');

GRANT SELECT, INSERT, UPDATE, DELETE ON onto_concepts, onto_relations, onto_code_lists, onto_bindings
  TO astra_control_app;
GRANT SELECT, INSERT ON onto_precedents TO astra_control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON source_connections, target_connections, curated_traps, project_baselines
  TO astra_control_app;
GRANT SELECT, INSERT, UPDATE ON adapter_runs, golden_runs TO astra_control_app;
-- Baselines are stored once and never change: the app role can only add and read them.
GRANT SELECT, INSERT ON target_baselines TO astra_control_app;
GRANT SELECT, INSERT ON load_calls TO astra_control_app;
"""


def upgrade() -> None:
    op.execute(SQL)


def downgrade() -> None:
    op.execute("""
DROP TRIGGER IF EXISTS project_baselines_no_agent_decider ON project_baselines;
DROP TRIGGER IF EXISTS curated_traps_no_agent_decider ON curated_traps;
DROP TRIGGER IF EXISTS load_calls_no_update ON load_calls; DROP FUNCTION IF EXISTS load_calls_append_only();
DROP TABLE IF EXISTS onto_precedents; DROP TABLE IF EXISTS onto_bindings; DROP TABLE IF EXISTS onto_code_lists;
DROP TABLE IF EXISTS onto_relations; DROP TABLE IF EXISTS onto_concepts;
""")
