-- Design and build (I9). Design items name customer elements (columns, configuration, forms, code, interfaces,
-- reports, pages, security profiles), so they stay in the tenant database, one row per (project, stream, key).
-- Build code and test results also stay here; the control plane keeps versions, digests and approvals.

CREATE TABLE IF NOT EXISTS estate.design_items (
    project_id uuid NOT NULL,
    stream     text NOT NULL,
    key        text NOT NULL,
    run_id     uuid NOT NULL,
    status     text NOT NULL,
    body       jsonb NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, stream, key)
);
CREATE INDEX IF NOT EXISTS ix_design_items_status ON estate.design_items (project_id, stream, status);

CREATE TABLE IF NOT EXISTS estate.design_files (
    project_id  uuid NOT NULL,
    item_key    text NOT NULL,
    role        text NOT NULL,      -- converted | golden
    name        text NOT NULL,
    content     bytea NOT NULL,
    sha256      text NOT NULL,
    uploaded_by text NOT NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, item_key, role)
);

CREATE TABLE IF NOT EXISTS estate.build_code (
    artifact_id uuid PRIMARY KEY,
    code        text NOT NULL,
    tests       jsonb NOT NULL,
    results     jsonb NOT NULL DEFAULT '[]',
    inputs      jsonb NOT NULL DEFAULT '{}'
);
