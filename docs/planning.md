# Planning (I7)

The plan is built from evidence the platform already holds: the blueprint (packs, constraints, approvals), the
newest successful discovery run (its knowledge graph), the newest version delta and the pinned target baseline.
Everything that names customer elements is stored in the tenant database (`estate.plan_items`, one row per
project, kind and key). Approvals, gaps and pre-sales estimates live in the control plane.

All endpoints are under `/api/v1/projects/{id}/plan` unless noted.

## Scope register (E11.F1.S1)

`POST /plan/scope/generate` proposes a disposition for every element of the knowledge graph (columns, rules and
code lists are parts of other elements). The six dispositions are `migrate`, `rebuild`, `replace_with_standard`,
`agentify`, `archive` and `retire`. Proposals follow fixed rules, and each one carries its evidence:

| Evidence | Proposal |
|---|---|
| No direct or indirect use in the activity window | retire |
| An interface found in activity records | rebuild (on the target's APIs) |
| The source platform | replace with standard (the target's hosting) |
| Views and reports | rebuild |
| Delta: unchanged, renamed or moved, changed behaviour | migrate |
| Delta: removed in target, read but never written | archive |
| Delta: removed in target, customer-specific or customized | rebuild |
| Delta: removed in target, standard product element | replace with standard |
| Delta: removed in target, origin unknown | rebuild (the evidence says how to decide otherwise) |
| A type the target baseline does not describe | rebuild |

`agentify` is never proposed: it needs an agentification assessment, so only a person chooses it. Proposals are
not decisions. `POST /plan/scope/decisions` approves them, or sets another disposition, with a reason. Decisions
survive re-generation; if the evidence later changes the proposal, the item says so.

## Dependencies (E11.F1.S2)

Edges come from the knowledge graph between elements in scope: code depending on tables, foreign keys, and
interfaces reading, writing or executing elements. `src -> dst` means src's work comes after dst's. People can add
edges, and they can remove discovered edges; a removal is kept, with who and why, so re-generation does not bring
the edge back. Cycles are reported as errors.

## Tasks and estimates (E11.F2)

Estimation rules come from the blueprint's pattern packs (`content.estimation`; the format is in
`planning/estimation.py`). Each rule gives:

- a low/likely/high range per element, per column or per thousand rows, plus a fixed part;
- activities with owner roles and their share of the hours.

Every scope item becomes one task per activity. A task whose likely estimate exceeds the blueprint's
`max_task_hours` (40 at most) is split into equal parts. Task dependencies work like this:

- an item's activities run in order;
- an item's first task waits for the last task of every item it depends on.

Each task shows the rule, the pack, the size used and its calibration. Task keys are stable, so exports and actuals
keep matching.

**Calibration.** Actual effort imported from Jira or Azure DevOps is kept per task with the rule and the estimate it
had. Once a rule has three or more past tasks with actuals, later estimates are multiplied by the median of
actual divided by estimate, and the evidence names the past tasks used.

The shipped `generic-estimation` pattern pack is a set of planning assumptions, marked `calibrated: false`. Every
screen shows that.

Roll-ups (`GET /plan/estimates`) total low, likely and high hours by stream, segment, wave and role. A segment is
the element's business concept family, else its schema.

## Control matrix (E11.F3.S1)

Every control of the blueprint's compliance packs gets:

- a task that operates it;
- the plan tasks it governs: approval controls by their `applies_to`, data-handling controls the data tasks, and
  retention controls the archive and retire tasks;
- the lifecycle gates where it applies.

## Waves (E11.F3.S2)

People define waves (dates, cutover day, capacity in hours per role) and may pin scope items to a wave. OR-Tools
CP-SAT assigns every scope item to exactly one wave under these constraints:

- **Dependencies (hard):** an item never goes in an earlier wave than the items it depends on.
- **Capacity (soft):** work per role per wave must fit the wave's capacity; any overflow is measured.
- **Pins (soft):** a broken pin is reported.

Calendar checks run alongside:

- a cutover inside a freeze period;
- a cutover outside its wave;
- a last wave that ends after the target completion date.

The result lists every broken constraint and the options that would make the plan fit:

- add capacity (with the hours);
- add a wave;
- move a cutover date;
- unpin an item;
- move the target date.

Work is never dropped. Open vendor product changes that block waves are listed with the result.

## Risks (E11.F3.S3)

A risk has a likelihood and impact (1 to 5), an owner, a mitigation task and a status. Risks a person records are
accepted. Risks the planner finds (dependency cycles, items without estimation rules, unapproved scope) arrive as
`proposed` and need a person to accept or reject them.

## Cutover and coexistence (E11.F4, E15.F1)

`POST /plan/cutover/compare` shows whole-estate, phased and parallel-run cutover side by side. The figures are
computed from these inputs:

- discovery row counts;
- the target adapter's recorded load rate and batch sizes;
- the waves and their assignments;
- the blueprint's cutover window;
- stated assumptions that the caller can change (extract hours, reconciliation minutes per entity, parallel-run
  weeks and hours per day, switch minutes).

For each option it reports:

- the longest window and the effort;
- risk factors, each explained: the share of rows in the largest window, the coexistence periods, and whether it
  fits the window;
- the constraint checks.

The chosen option is recorded with its reason and the comparison it was chosen from.

`POST /plan/runbook/generate` builds the timed runbook for the chosen option:

- the go/no-go checks: cutover gate controls, the hosting checklist and the signed reconciliation;
- freeze, final extract, then a load and a reconciliation per entity;
- a final go/no-go, the switch, and rollback steps.

Each step has an owner role and a planned duration, with its basis. Rehearsal timings replace the planned duration
and keep the history.

**Coexistence.** A phased plan needs a rule for every shared entity (one bound to an ontology concept) in every
phase but the last. Each rule names the system of record, an end date and an exit reconciliation. Warnings appear
when a rule is missing or incomplete, when the end date falls before the last wave's cutover, or when the end date
is near or has passed.

## Baselines (E11.F5.S1)

`POST /plan/baselines` freezes the whole plan as a proposed baseline. It records a digest, a summary, and its
changes against the approved baseline. A different person with `plan:approve` approves or rejects it. The proposer
cannot approve their own baseline, and agents can never decide (database trigger). A phased plan cannot be approved
without its coexistence rules (E15.F1.S1).

`GET /plan/diff` shows the current plan against the approved baseline, item by item and field by field. Any change
to an approved plan becomes a new proposed baseline that needs approval. The planning stage gate opens once an
approved baseline exists.

## Exports and actuals (E11.F5.S2)

`GET /plan/export?format=jira|ado&target=…` produces the tool's own CSV import format. Every row carries the stable
`Astra ID`. `POST /plan/actuals` reads a Jira export (`Time Spent`, in seconds) or an Azure DevOps export
(`Completed Work`, in hours), matches rows by `Astra ID` and lists the rows it could not match.

## Gaps (E19.F1)

`POST /projects/{id}/gaps` records a gap. `PATCH /gaps/{id}` gives it a route (`configuration`,
`customer_extension`, `vendor_product_change` or `process_change`) and an owner. A gap cannot close without both
(also a database constraint). Vendor product changes carry the vendor's reference and the waves they block, and the
wave solver lists them as dependencies. `GET /programmes/{id}/vendor-changes` ranks open vendor changes across the
programme's customers by how many customers they block, then by waves blocked; `format=csv` exports the list for
the vendor's product team.

## Pre-sales (E11.F5.S4)

`POST /presales-estimates` sizes a prospect from a questionnaire and, optionally, a sample extract in
`astra.baseline/v1` format. It uses the same estimation rules as the delivery plan. The output is labelled as an
estimate and lists every assumption. It gives a scope outline, an effort range and waves sized from the team's
weekly hours.
