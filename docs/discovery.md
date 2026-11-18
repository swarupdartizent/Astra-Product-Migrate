# Discovery and the Migration Knowledge Graph

A discovery run reads a legacy estate through its source adapter, with a read-only account, and builds the
Migration Knowledge Graph for one project. Every phase reports `done`, `partial`, `failed` or `skipped` with the
reason, and the run ends with a coverage report across the nine migration streams.

## Phases

| Phase | What it does | Story |
|---|---|---|
| inventory | Every object type the adapter declares, with owner, last change and dependencies | E05.F2.S2 |
| dictionary | Tables, columns, types, foreign keys, soft (unenforced) references and code lists | E08.F1.S1 |
| profile | Per table: row count; per column: nulls, distinct values and value shapes; broken references; quality score | E08.F1.S2 |
| usage | Reads, writes and executions per element from activity records, flowing through views, procedures and triggers; unused elements flagged for retirement review | E08.F1.S3 |
| code | Business rules in procedures, triggers, functions and views, with confidence, excerpt and fields | E08.F2.S1 |
| interfaces | Programs seen in activity (not the product's own client or the platform), linked-server references in code, and interface objects in configuration | E08.F2.S2 |
| configuration | Configuration items per kind with dependencies, and the differences between scopes such as books | E08.F2.S3 |
| documents | Document counts and bytes by type, age and the entity they belong to | E13.F2.S1 |

Value shapes keep the form of a value (`99-9999999`), never the value. All results and the graph stay in the
tenant's own database; the control plane keeps run status, counts and the coverage report.

### Data quality score

Per table, 0 to 100: completeness (weight 0.4) is one minus the mean null rate over columns that are mostly
filled; validity (0.3) is the share of values matching each text column's dominant shape where one shape covers at
least 80% of a 1,000-row sample; integrity (0.3) is one minus the share of rows with a broken reference. The
estate score is the row-weighted mean.

### Rule confidence

Validation 0.90 (a condition that rejects a change with an error), automation 0.80 (an external program started by
an event), derivation 0.75 (a value set from other values), calculation 0.70, audit 0.60, interface 0.50 (dynamic
SQL). Rules are linked to fields through the statement's aliases; screens are linked when an adapter supplies
screen metadata.

## Activity records

Usage and most interfaces come from login and query records the customer exports from their database's own
auditing (for example SQL Server Audit or Extended Events, or SQL Anywhere request logs) and imports per source
connection. One record per line (JSON Lines) or per row (CSV with a header):

| Field | Required | Meaning |
|---|---|---|
| `timestamp` | yes | ISO 8601 date and time |
| `login` | yes | Database login |
| `host` | no | Client machine |
| `program` | no | Client program name |
| `statement` | no | The SQL text; empty for a login record |

```json
{"timestamp": "2026-10-03T02:15:00", "login": "etl", "host": "DW01", "program": "NightlyLoader", "statement": "SELECT ... FROM dbo.Orders"}
```

The usage window defaults to 90 days before the run's as-of date. With fewer days of evidence the usage phase is
`partial` and unused flags are provisional; with none, it is `skipped` and the coverage report shows a blocking gap
for integrations.

## Coverage report and the discovery gate

The report shows each stream as `covered`, `partial`, `gap` or `not_started`, with its gaps. A blocking gap must be
closed (by a new run) or waived by a person with a written reason. Accepting the report needs every blocking gap
waived; only then can the project's discovery stage be marked done.
