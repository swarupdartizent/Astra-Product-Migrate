# Learning from delivered work (I14)

Four loops turn decisions and delivered effort into better numbers. Each change is recorded, and none of them
rewrites something already agreed.

## Bulk approval (E16.F1.S5)

The review queue groups open items by evidence pattern. For one pattern:

- `GET /api/v1/projects/{id}/review-bulk?pattern_key=…` lists the items the caller can approve together. It also
  lists the items left out, each with the reason, and the options every eligible item shares.
- `POST /api/v1/projects/{id}/review-bulk` with `pattern_key`, `option`, `note` (at least 10 characters) and
  `item_ids` (exactly the items the reviewer saw, 2 to 200).

Rules:

- **Never compliance-critical.** Critical items are decided one by one, with their named reviewer. The database
  refuses a bulk approval of a critical item, or of an item with another pattern.
- **All or nothing.** If any listed item changed since the preview (decided, reassigned, or its first approver chose
  another option), nothing is recorded and the items are named.
- **Each item is approved on its own record.** Every item gets its own approval and audit event, linked to the
  batch. A batch event records the pattern, option, reason and outcome. Two-person items get this reviewer's
  approval and wait for a second person.

## Confidence calibration (E22.F1.S3)

`GET /api/v1/evaluation/calibration` (optional `tenant_id`, `since`) reports, for each agent or platform rule that
states a confidence:

- **ECE.** The expected calibration error: the item-weighted mean gap between confidence and accuracy, over ten
  bins.
- **Brier score.**
- **Mean confidence and accuracy,** and whether the source is over- or underconfident (a gap above 5 points).
- **Reliability bins** and **accuracy at or above each threshold** (0.5 to 0.95), for setting review thresholds on
  evidence.

Scoring:

- **Right:** the reviewer approved exactly the suggested option.
- **Wrong:** the reviewer rejected it, changed it or chose another option.
- **Not scored:** dismissed items.
- **Unscored:** items without a recorded suggestion, counted separately and never guessed.

Agents must give `suggested_option` with any confidence (`request_decision`). Design proposals record their
suggestion, which is always their first option. Fewer than 20 items is marked as too few to trust. Only counts and
rates are reported.

## Estimates that learn (E21.F3.S2)

When actual effort is imported (`POST /projects/{id}/plan/actuals`), each task keeps:

- the planned low, likely and high hours
- the rule's uncalibrated estimate and the factor that was applied
- the wave it was planned in
- whether a person overrode its hours

Calibration factors compare actual hours with the **uncalibrated** estimate, so a new factor replaces the old one
instead of multiplying it. Overridden tasks are left out.

`GET /projects/{id}/plan/estimate-accuracy` reports, per wave in wave order:

- **Planned and actual hours.**
- **Error:** (actual − planned) ÷ planned.
- **Mean absolute error per task.**
- **Within range:** the share of tasks that landed inside the planned range.
- **Calibrated and overridden task counts.**

It also reports the trend from the first wave to the last, and the factors later estimates will use. A rule is
calibrated once it has three past tasks.

## Complexity Index recalibration (E18.F2.S3)

- **Versions.** Every set of weights, ranges and band limits is a numbered, dated, append-only version
  (`GET /programmes/{id}/mci/versions`). The starting assumptions are recorded as version 1 before the first change.
  A change by hand in set-up is a new version too.
- **Recalibration.** `POST /programmes/{id}/mci/recalibration` with `after_wave` previews a proposal. With
  `"apply": true` and a `reason`, it stores the proposal as a new version.
  - **Which customers.** Customers placed in that wave or earlier by the latest portfolio plan, with a scan and
    actual effort; at least 3 are needed.
  - **The fit.** Actual hours are fitted to the normalised measures by non-negative least squares with an intercept.
    The weights are scaled to add up to 1, then blended with the current ones by n ÷ (n + 10), so a small fleet
    moves them only a little.
  - **What the proposal shows.** The fitted and proposed weights, the correlation between score and effort before
    and after, and every band that would change.
- **Contracted bands.** `POST /programmes/{id}/customers/{tid}/band-contract` with a contract reference fixes the
  customer's band, score and weights version, once. Planning, the programme view, the fleet and metering use the
  contracted band from then on. Later versions never change it, and the database keeps contracts append-only.
- **Partner visibility.** Partners see versions and dates, but not which customers informed a recalibration.
