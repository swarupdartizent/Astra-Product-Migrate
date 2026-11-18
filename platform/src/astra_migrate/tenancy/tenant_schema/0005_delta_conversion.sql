-- Version delta differences, converted code and recorded test cases. Object names, code and test rows are
-- customer data, so they stay in the tenant database.

CREATE TABLE IF NOT EXISTS estate.delta_differences (
    run_id   uuid NOT NULL,
    seq      integer NOT NULL,
    grp      text NOT NULL,
    type     text NOT NULL,
    source   text NOT NULL,
    target   text,
    origin   text NOT NULL,
    details  jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_delta_grp ON estate.delta_differences (run_id, grp);

CREATE TABLE IF NOT EXISTS estate.delta_lists (
    run_id   uuid NOT NULL,
    section  text NOT NULL,   -- not_in_scope | new_in_target
    payload  jsonb NOT NULL,
    PRIMARY KEY (run_id, section)
);

CREATE TABLE IF NOT EXISTS estate.conversions (
    run_id      uuid NOT NULL,
    object_type text NOT NULL,
    name        text NOT NULL,
    status      text NOT NULL,   -- compiled | compile_failed | review
    source      text NOT NULL,
    converted   text,
    rules       jsonb NOT NULL DEFAULT '[]',
    warnings    jsonb NOT NULL DEFAULT '[]',
    review      jsonb NOT NULL DEFAULT '[]',
    compile     jsonb NOT NULL DEFAULT '{}',
    tests       jsonb NOT NULL DEFAULT '[]',
    PRIMARY KEY (run_id, object_type, name)
);

CREATE TABLE IF NOT EXISTS estate.conversion_tests (
    id          uuid PRIMARY KEY,
    project_id  uuid NOT NULL,
    object_name text NOT NULL,
    name        text NOT NULL,
    body        jsonb NOT NULL,
    created_by  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, object_name, name)
);
