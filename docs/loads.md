# Loads, validation, reconciliation and parity (I10)

## Load runs (E13.F1)

`POST /api/v1/projects/{id}/load-runs {kind, extract_run_id, target_connection_id?, segment?}`

| Kind | What it does |
|---|---|
| `rehearsal` | Transforms, validates and reconciles; sends nothing (no target connection) |
| `load` | Sends records that pass validation through the target's load endpoints; records whose payload is unchanged since they were last loaded are skipped |
| `delta` | Like `load`, from a delta extract (only rows changed since the previous extract) |
| `reload` | `POST /load-runs/{id}/reload {records}`: only chosen failed records, with their fixed payload when one was entered |

Every run is numbered per project and pins its inputs:
- the approved transformation code (artifact ids and digests);
- the pack versions;
- the extract run;
- the segment, if any.

The database refuses a run whose artifacts are not approved versions with those digests, and any later change to
the pinned inputs.

Each run records:
- an input digest and a result digest. A run with the same input digest as an earlier one reports
  `repeat_of: {run, same_result}`, so repeatability is shown, not assumed.
- per-table counts: source, transformed, accepted, and each status.

Loading by segment (`segment: {column, values}`) moves one line of business or region at a time.

Each artifact's staged rows go through its approved procedure on the SQL Server workbench, in a transaction that
is rolled back. Each row then goes to the target adapter's load endpoint for its table (`load.endpoints[].table`).
Without that endpoint, the records are `blocked` with the reason.

**Error queue (E13.F1.S2).** `GET /load-runs/{id}/records` lists the failed records by default: `rejected` by the
target (with its HTTP status and reason), `invalid` (stopped by a blocking rule) and `blocked`. You can filter by
table, status, triage state, owner or text. `PATCH /load-runs/{id}/records` assigns an owner, sets the triage state
(`open`, `fixed`, `wont_fix` with a reason) or stores a fixed payload with the same columns. Then reload those
records alone.

## Validation (E14.F1.S1)

Every transformed record is validated before it is sent:

- **Structural:** the target baseline's required columns, string lengths, and numeric precision and scale.
- **Reference:** the source adapter's entity relations, carried to the target through the approved mappings. A
  parent must be in this load or an earlier one.
- **Semantic and business:** the executable rules of the blueprint's domain packs (semantic) and pattern packs
  (business): `order`, `within`, `sum_equals` (to the cent) and `not_null`. Concepts and attributes are translated
  to target tables and columns through the source adapter's bindings and the mappings.

Each failure names the rule, the record and a proposed fix in plain language. Blocking failures stop the record
unless the blueprint sets `validation.blocking_rules_stop_load: false`.

## Reconciliation (E14.F1.S2) and data quality (E14.F1.S3)

After every run, each target table is reconciled at three stages: the source rows, the transformed rows, and the
records the target accepted (or, in a rehearsal, would accept). It compares record counts and every measured
amount, to the cent.

The measures are `validation.measures` in the blueprint (table, column and label, for example premium, taxes,
commissions or ledger balance). When the blueprint lists none, every mapped decimal or money column is measured.

Each difference is a **break**:
- `GET /projects/{id}/recon-breaks`.
- It is owned by the project's customer data owner when there is exactly one, otherwise someone names an owner.
- `PATCH /recon-breaks/{id}` names the owner or closes the break. A break cannot close without an owner and a reason
  of at least ten characters, and an agent cannot close one (all enforced in the database).

Data quality per object and per segment: *before* is discovery's profile score of the source table, *after* is the
share of transformed records with no validation failure.

## Documents (E13.F2.S2)

`POST /load-runs/{id}/document-checks` checks every document of the run's extract:
- the link must resolve at source;
- the linked record must have been accepted by the target.

Broken links are listed with their entity.

A random sample is also read back from the target and compared byte for byte (SHA-256). The sample's size is the
blueprint's `documents.retrieval_sample_size`, and it is seeded by the run, so it can be repeated. Reading back
needs the target adapter's `documents.read_path` and a target connection; otherwise the sample is reported as
blocked.

## Parity (E14.F2)

`POST /projects/{id}/parity-runs {kind, name, spec, source, target}` compares result files from both systems (CSV
or JSON):
- re-rated policies (`rating`);
- report outputs (`report`);
- workflow replay outcomes (`workflow`);
- a closed accounting period (`period_close`).

The spec names the key fields, the compared fields (`money` to the cent, `number`, `text`) and the input fields to
show. Missing cases on either side are differences. For rating, reports and period close, each amount's grand
total must also match to the cent.

Every difference shows the inputs and both outputs. `POST /parity-runs/{id}/cases/decide` approves differences (the
approver is recorded) or marks them fixed. A run passes when nothing is open.

**Forms (E14.F2.S2).** Form parity separates content differences (page text and form fields), which fail, from
layout-only differences (page count or size), which a person can approve with a note
(`POST /projects/{id}/design/form-layout-approval`).

## Coexistence (E15.F1.S2)

`PUT /projects/{id}/coexistence-schedule {connection_id, owner_user_id, hour_utc}` turns on a daily reconciliation.
A scheduler in the API process enqueues it when due.

For each shared entity in the plan's coexistence rules, it compares the source's live record count and measured
amounts (read-only) with what the target accepted in loads so far. Breaks go to the schedule's named owner. An open
break for the same entity and measure is updated rather than repeated.

`GET /projects/{id}/coexistence` is the dashboard: rules, schedule and open breaks.
`POST /projects/{id}/coexistence-reconcile` runs it now.
