# Release gate (I13)

A release is blocked when any measure on any golden suite falls below the previous release (E22.F1.S2).

## Golden suites

Each suite lives in `testkit/evaluation/<name>/suite.yaml`. It is a synthetic estate with the answers a careful
migration team would give: a test asset with known answers, never customer data. A suite has one section per
area, and each area is scored by running the platform's own engines, without a database:

| Area | Engine | Measures (0 to 1, higher is better) |
|---|---|---|
| mapping | mapping proposals | `top1_accuracy`; `auto_precision` (proposals that skip review are right); `review_recall` (wrong proposals go to review) |
| configuration | configuration translator | `accuracy` of target area, retirement or block |
| code | SQL Anywhere converter | `review_routing_accuracy`; `conversion_accuracy` (required text present, source text gone) |
| planning | scope proposals, dependency cycles | `disposition_accuracy`; `cycle_recall`; `cycle_precision` |
| compliance | compliance classification of review subjects | `level_accuracy`; `approvers_accuracy` |
| review | queue priority, precedent pattern keys | `order_agreement` (pairs in the expected order); `grouping_agreement` |

A scorecard holds every suite's measures with the suite's digest, and the digest of the engine code it ran
(`astra.evaluation/v1`).

## The gate

```
python -m astra_migrate.evaluation gate            # exit 1 when anything fell; CI runs this
python -m astra_migrate.evaluation run --out x.json
python -m astra_migrate.evaluation record --release R2 --reason "..."
```

`gate` compares the current scorecard with `testkit/releases/baseline.json`, the scorecard of the previous
release. It blocks the release when:
- a measure fell;
- a measure disappeared;
- a suite disappeared.

Improvements and suites that changed since the baseline are reported. CI runs the gate in the API job, and
`tests/test_releases.py` runs it too.

`record` makes the current scorecard the next baseline, with the release name and a reason. It refuses a
scorecard that regresses unless `--force` is given. That is for a suite made harder on purpose; the regressions
accepted and the reason are kept in the file.

## Release records

`POST /api/v1/releases {name, reason}` (platform golden-run permission) evaluates now, compares with the latest
released record, and records the release:
- `released` when nothing fell;
- `blocked` with each regression otherwise.

The database refuses a `released` record with regressions. Release records are append-only.

`GET /api/v1/releases` lists them, and `GET /api/v1/releases/evaluation` previews the comparison without recording.

## Baseline R1-I13

The first baseline scores 1.0 on every measure except `mapping.top1_accuracy` (0.867). Two columns of a renamed
customer table (ClientNote to CustomerNote) find no target table, because table matching does not yet use
earlier decisions. Both go to review (`review_recall` 1.0), so no wrong mapping skips a person. Raising that
measure is the next improvement; the gate keeps it from falling.
