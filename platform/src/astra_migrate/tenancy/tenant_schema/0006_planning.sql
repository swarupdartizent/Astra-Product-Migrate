-- The migration plan (I7). Scope items, dependencies, tasks, waves, risks, cutover choices, runbook steps and
-- coexistence rules name customer elements, so they stay in the tenant database. Each is one row per
-- (project, kind, key) with its body, so baselines can snapshot and diff the whole plan generically.

CREATE TABLE IF NOT EXISTS estate.plan_items (
    project_id uuid NOT NULL,
    kind       text NOT NULL,
    key        text NOT NULL,
    body       jsonb NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, kind, key)
);

CREATE TABLE IF NOT EXISTS estate.plan_snapshots (
    baseline_id uuid PRIMARY KEY,
    project_id  uuid NOT NULL,
    items       jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Actual effort flowing back from the teams' own tools (E11.F5.S2); used to calibrate later estimates.
CREATE TABLE IF NOT EXISTS estate.plan_actuals (
    project_id  uuid NOT NULL,
    task_key    text NOT NULL,
    rule_id     text,
    estimate    numeric,
    hours       numeric NOT NULL,
    source      text NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, task_key)
);

-- Rehearsal timings per runbook step (E11.F4.S2), kept as history.
CREATE TABLE IF NOT EXISTS estate.rehearsal_timings (
    project_id  uuid NOT NULL,
    rehearsal   text NOT NULL,
    step_key    text NOT NULL,
    minutes     numeric NOT NULL,
    recorded_by text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, rehearsal, step_key)
);
