-- Discovery results and the Migration Knowledge Graph. Customer metadata, so it stays in the tenant DB.

CREATE TABLE IF NOT EXISTS estate.activity_events (
    import_id   uuid NOT NULL,
    seq         integer NOT NULL,
    occurred_at timestamptz NOT NULL,
    login       text NOT NULL,
    host        text NOT NULL,
    program     text NOT NULL,
    statement   text,
    reads       jsonb NOT NULL DEFAULT '[]',
    writes      jsonb NOT NULL DEFAULT '[]',
    executes    jsonb NOT NULL DEFAULT '[]',
    PRIMARY KEY (import_id, seq)
);

CREATE TABLE IF NOT EXISTS estate.kg_nodes (
    run_id   uuid NOT NULL,
    node_id  text NOT NULL,
    kind     text NOT NULL,
    stream   text NOT NULL,
    element  text NOT NULL,
    usage    jsonb NOT NULL DEFAULT '{}',
    concept  text,
    target   text,
    props    jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, node_id)
);
CREATE INDEX IF NOT EXISTS ix_kg_nodes_kind ON estate.kg_nodes (run_id, kind);

CREATE TABLE IF NOT EXISTS estate.kg_edges (
    run_id  uuid NOT NULL,
    src     text NOT NULL,
    dst     text NOT NULL,
    kind    text NOT NULL,
    props   jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_kg_edges_src ON estate.kg_edges (run_id, src);
CREATE INDEX IF NOT EXISTS ix_kg_edges_dst ON estate.kg_edges (run_id, dst);

CREATE TABLE IF NOT EXISTS estate.discovery_results (
    run_id   uuid NOT NULL,
    section  text NOT NULL,   -- profile | rules | interfaces | configuration | config_diff | documents | usage | gaps
    payload  jsonb NOT NULL,
    PRIMARY KEY (run_id, section)
);
