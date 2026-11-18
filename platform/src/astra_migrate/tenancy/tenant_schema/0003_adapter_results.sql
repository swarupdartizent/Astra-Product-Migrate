-- Results of source adapter operations. Object names, code, rows and documents are customer data,
-- so they stay in the tenant's own database. The control plane keeps only run status and counts.

-- One metadata harvest: every object the adapter inventoried, with owner, last change and dependencies.
CREATE TABLE IF NOT EXISTS estate.metadata_objects (
    run_id            uuid NOT NULL,
    object_type       text NOT NULL,
    schema_name       text NOT NULL DEFAULT '',
    name              text NOT NULL,
    owner             text,
    modified_at       text,
    definition        text,
    definition_sha256 text,
    depends_on        jsonb NOT NULL DEFAULT '[]',
    detail            jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, object_type, schema_name, name)
);

CREATE TABLE IF NOT EXISTS estate.coverage (
    run_id        uuid NOT NULL,
    object_type   text NOT NULL,
    label         text NOT NULL,
    required      boolean NOT NULL,
    status        text NOT NULL,
    object_count  integer NOT NULL,
    error         text,
    dependencies  text NOT NULL,
    code_missing  integer NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, object_type)
);

CREATE TABLE IF NOT EXISTS estate.trap_findings (
    run_id    uuid NOT NULL,
    trap_id   text NOT NULL,
    origin    text NOT NULL,
    title     text NOT NULL,
    severity  text NOT NULL,
    stream    text NOT NULL,
    advice    text NOT NULL,
    hits      jsonb NOT NULL,
    PRIMARY KEY (run_id, trap_id)
);

-- Extracted rows, by run and entity. Delta runs hold only rows changed since the previous watermark.
CREATE TABLE IF NOT EXISTS estate.extract_rows (
    run_id    uuid NOT NULL,
    entity    text NOT NULL,
    row_key   text NOT NULL,
    row_data  jsonb NOT NULL,
    PRIMARY KEY (run_id, entity, row_key)
);

CREATE TABLE IF NOT EXISTS estate.extract_counts (
    run_id        uuid NOT NULL,
    entity        text NOT NULL,
    mode          text NOT NULL,
    source_count  integer,
    extracted     integer NOT NULL,
    watermark     text,
    PRIMARY KEY (run_id, entity)
);

-- Documents with the link to the entity they belong to.
CREATE TABLE IF NOT EXISTS estate.documents (
    run_id         uuid NOT NULL,
    doc_key        text NOT NULL,
    name           text NOT NULL,
    link_type      text,
    link_entity    text,
    link_key       text,
    link_resolved  boolean NOT NULL,
    created_at     text,
    size_bytes     integer,
    sha256         text,
    content        bytea,
    PRIMARY KEY (run_id, doc_key)
);
