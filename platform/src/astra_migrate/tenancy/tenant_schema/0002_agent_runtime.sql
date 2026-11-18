-- Agent run content. It may contain customer data, so it lives in the tenant's own database;
-- the control plane keeps only run metadata (status, tokens, cost, timing).
CREATE TABLE IF NOT EXISTS estate.agent_run_content (
    run_id      uuid PRIMARY KEY,
    objective   text NOT NULL,
    output      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every message and tool call of a run, in order.
CREATE TABLE IF NOT EXISTS estate.agent_run_events (
    run_id      uuid NOT NULL,
    seq         integer NOT NULL,
    kind        text NOT NULL,          -- model_request | model_response | tool_call | tool_result | guardrail
    payload     jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq)
);

-- Text from legacy data that the screening step flagged as instruction-like (E02.F2.S1).
-- The control-plane review item points here by id and never holds the text itself.
CREATE TABLE IF NOT EXISTS estate.screening_flags (
    id          uuid PRIMARY KEY,
    source      text NOT NULL,          -- where the text came from, for example table.column#key
    excerpt     text NOT NULL,
    sha256      text NOT NULL,
    findings    jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
