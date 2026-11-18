# Review and planning workbenches (I8)

Agents and platform rules propose; people decide. I8 turns the review queue into a workbench and adds a single view of
the plan that re-runs the constraint solver after every edit.

## Review queue (E16.F1.S1)

`GET /api/v1/projects/{id}/review-queue` returns the items sorted by priority, with facets and groups.

Every review item now carries:

| Field | Set by | Meaning |
|---|---|---|
| `risk` | the requester (rule or agent) | low, medium, high, critical: harm a wrong answer would do |
| `confidence` | agents (optional) | 0 to 1; rules leave it empty |
| `compliance` | the platform, from packs | none, relevant or critical (see below) |
| `stream`, `segment` | the requester | migration stream and a finer grouping (for example the object kind) |
| `subject_type` | the requester | what the decision is about: `conversion_script`, `mapping`, `retirement`, `pattern`, `screening`, `decision`, ... |
| `pattern_key` | the requester | a stable key for "the same kind of question", used for precedents and grouping |
| `evidence` | the requester | links to the source objects: conversion object or run, delta run, discovery run, agent run |

**Priority** = risk × 100 + compliance × 30 + (1 − confidence) × 20, where low/medium/high/critical count 1–4 and
none/relevant/critical count 0–2. An item without a stated confidence counts as 0.5. Ties go to the oldest item.
Each item returns `priority` and `priority_reasons`, so the order is never a black box.

Filters: `status` (`open`, `decided`, `all` or one status), `stream`, `segment`, `agent`, `kind`, `risk`,
`compliance`, `owner_role`, `pattern_key`, `mine` (items named to me, or unnamed items owned by one of my roles) and
`q` (title and question). Facets count the items in the chosen status before the other filters. `groups` lists
pattern keys shared by more than one item, so a large conversion run with many similar items can be worked
pattern by pattern. Bulk approval is a later story (E16.F1.S5) and will never apply to compliance-critical items.

## Evidence panel and precedents (E16.F1.S2, E21.F1.S1)

`GET /api/v1/review-items/{id}/workbench` returns:

- `item`, including the evidence links and the approvals recorded so far;
- `why`: an explanation built only from what was recorded with the item (the agent's stated reason, the conversion
  rules that stopped, the delta's advice, the activity evidence, the controls that apply and the priority reasons);
  no model is involved;
- `samples`: sample values read from the tenant database at view time (the source and converted code of a conversion
  object, unused elements from discovery, the flagged text of a screening item). They are never copied into the
  control plane;
- `precedents`: earlier decided items in the same tenant with the same pattern key, with their source project,
  outcome, answer, note, who decided and when, and a count by outcome;
- `assistant` and `assistant_runs`: whether the Review Assistant can be asked, and the runs asked so far;
- `reviewers`: the people who hold the owning role on the project and can be named.

## Decisions (E16.F1.S3)

`POST /api/v1/review-items/{id}/decide` with `action`:

| Action | Needs | Result |
|---|---|---|
| `approve` | one of the item's options | an approval; the item resolves once it has the approvals it needs |
| `reject` | a reason (10+ characters) | `rejected` |
| `change` | a reason; `changed_value` when no agent raised the item | agent items: `changes_requested`, and a follow-up run of the same agent starts with the note; rule items: resolved with the changed answer |
| `dismiss` | a reason | `dismissed` |

The earlier `/resolve` endpoint still works and maps to approve and dismiss.

**Compliance impact** comes from the approval controls of the project's compliance packs. A control whose
`parameters.applies_to` names the item's `subject_type` makes the item compliance-relevant, or critical when the
control is `compliance_critical`. `two_person_approval: true` or `min_approvers: 2` makes it need two people.

Rules (the starred ones are enforced in the database as well as in the API):

- Only a holder of the owning role, or the named reviewer, decides an item.
- \* The person who requested an item cannot approve it; an agent identity can never approve.
- \* A compliance-critical item is decided only once a named reviewer is assigned
  (`PUT /review-items/{id}/reviewer`, migration lead). With one required approval only the named reviewer decides;
  with two, the named reviewer must be one of the two.
- \* An item resolves as approved only with as many approvals, from different people, as it requires. The second
  approver must choose the same option, or reject the item with a reason.
- A change to a two-person item raised by a rule is refused: approve an option or reject with a reason.

## Review Assistant (E16.F1.S4)

`POST /api/v1/review-items/{id}/ask` with a `question` starts a run of the `review-assistant` agent (catalogue
manifest `agents/catalog/review-assistant.yaml`). Its only tools are `get_review_item` and `get_review_precedents`,
both metadata reads; reviewers' notes are not passed to the model. It has no tool that decides anything, and the
database refuses any decision recorded by an agent identity. The answer is the run's output, linked from the item.

The assistant runs only when a released version is pinned on the project and a model provider is configured. Until
then the endpoint answers 409 with the reason, and the `why` explanation is still shown from the recorded evidence.

## Planning workbench (E16.F2.S1)

`GET /api/v1/projects/{id}/plan/workbench` returns one view of the plan for the timeline, the task list and the
dependency graph: waves with dates, capacity, load and the items in each; every scope item with its wave, pinned
wave, depth, hours by role and range, task count and dependencies; edges; cycles; the latest solver result; `stale`
when scope, edges, tasks, waves or pins changed after the last solve; `unplaced` (estimated work not placed) and
`unestimated` (no estimated work).

`POST /api/v1/projects/{id}/plan/workbench/edits` applies a list of edits in one transaction and then re-runs the
wave solver:

- `move`: pin a scope item to a wave, or unpin it (`wave: null`);
- `add_dependency` and `remove_dependency`, with a reason;
- `task`: change a task's role or estimate (low ≤ likely ≤ high, likely within the blueprint's maximum task hours),
  with a reason. The change is kept with the original values, and survives task regeneration while the task key
  exists.

If any edit is invalid, nothing is saved and the error names the edit (`edits.{n}.{field}`).

Also added for the planning screens: `GET /plan/scope/keys?q=` (a short list for pickers),
`POST /plan/dependencies/remove` (reason in the body; the query-string `DELETE` is deprecated) and
`baseline_awaiting_approval` / `can_approve_waiting` on the plan overview.
