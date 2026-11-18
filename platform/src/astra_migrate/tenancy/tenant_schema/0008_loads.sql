-- Loads, validation and parity (I10). Records, their payloads, validation failures and parity cases are customer
-- data, so they stay in the tenant database. The control plane keeps run numbers, digests, counts and breaks.

CREATE TABLE IF NOT EXISTS estate.load_records (
    run_id         uuid NOT NULL,
    target_table   text NOT NULL,
    record_key     text NOT NULL,
    source_key     text,
    segment        text,
    payload        jsonb NOT NULL,
    payload_digest text NOT NULL,
    status         text NOT NULL,   -- rehearsed | loaded | unchanged | rejected | invalid | blocked
    http_status    integer,
    reason         text,
    failures       jsonb NOT NULL DEFAULT '[]',
    -- error queue
    owner          text,
    triage         text NOT NULL DEFAULT 'open',   -- open | fixed | wont_fix | reloaded
    fixed_payload  jsonb,
    note           text,
    PRIMARY KEY (run_id, target_table, record_key)
);
CREATE INDEX IF NOT EXISTS ix_load_records_status ON estate.load_records (run_id, status);

CREATE TABLE IF NOT EXISTS estate.parity_cases (
    run_id       uuid NOT NULL,
    case_key     text NOT NULL,
    kind         text NOT NULL,     -- difference | missing_in_target | missing_in_source
    field        text NOT NULL,
    source_value text,
    target_value text,
    inputs       jsonb NOT NULL DEFAULT '{}',
    status       text NOT NULL DEFAULT 'open',   -- open | approved | fixed
    decided_by   text,
    decided_at   timestamptz,
    note         text,
    PRIMARY KEY (run_id, case_key, field)
);

CREATE TABLE IF NOT EXISTS estate.document_checks (
    run_id      uuid NOT NULL,
    doc_key     text NOT NULL,
    link_entity text,
    link_key    text,
    status      text NOT NULL,      -- linked | broken | match | mismatch | missing | blocked
    detail      text,
    PRIMARY KEY (run_id, doc_key, status)
);
