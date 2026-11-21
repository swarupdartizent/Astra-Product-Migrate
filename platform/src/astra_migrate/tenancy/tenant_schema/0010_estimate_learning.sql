-- Estimates that learn from actual effort (I14, E21.F3.S2). Each imported actual keeps what the team was shown
-- (the planned range, after any calibration), the rule's uncalibrated estimate and the factor applied, the wave
-- the task was planned in, and whether a person overrode the hours. Calibration uses the uncalibrated estimate, so
-- factors do not compound; the per-wave error report uses the planned range.

ALTER TABLE estate.plan_actuals ADD COLUMN IF NOT EXISTS planned_low    numeric;
ALTER TABLE estate.plan_actuals ADD COLUMN IF NOT EXISTS planned_likely numeric;
ALTER TABLE estate.plan_actuals ADD COLUMN IF NOT EXISTS planned_high   numeric;
ALTER TABLE estate.plan_actuals ADD COLUMN IF NOT EXISTS factor         numeric;
ALTER TABLE estate.plan_actuals ADD COLUMN IF NOT EXISTS wave           text;
ALTER TABLE estate.plan_actuals ADD COLUMN IF NOT EXISTS overridden     boolean NOT NULL DEFAULT false;

-- Rows imported before I14 recorded the planned likely hours as `estimate`.
UPDATE estate.plan_actuals SET planned_likely = estimate WHERE planned_likely IS NULL;
