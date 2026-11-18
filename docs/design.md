# Design and build (I9)

Design turns discovery evidence into proposals people decide: column mappings, configuration, forms, customer code,
integrations and desktop links, reports, web pages and security profiles. Build turns decisions into versioned code
that is tested on the SQL Server workbench and can run only after a person approves a version whose tests passed.

## What design needs from the target adapter

Target adapters gain an optional `design` section (contract `astra.adapters/v1`, added in I9). Every part is
optional, and a stream whose part is missing is shown as **blocked** with the reason, never guessed:

| Part | Used by |
|---|---|
| `mechanisms`: approved ways in and out (`rest_api`, `read_query`, `webhook`, `integration_vendor`, `file_exchange`) with directions `inbound`, `outbound`, `read`, a source and a confidence | integrations, desktop links |
| `report_access`: the mechanism reports are rebuilt on | reports |
| `retirements`: source object types or configuration kinds the target does not support (optionally only when detail fields match, or names match a pattern), with the proposed replacement | configuration, desktop links |
| `naming`: owning schema, prefix, case and maximum length for customer objects | customer code, reports |
| `configuration_areas`: where each source configuration kind is rebuilt, and how (`api`, `import_file`, `manual`) | configuration |
| `forms`: the target's form format, which configuration kinds are forms, and what shows a form is already in it | forms |
| `pages`: the target's page builder | page drafts |

## Design runs

`POST /api/v1/projects/{id}/design-runs {connection_id}` (stage manager with source access) starts a run that
reads the source live through its adapter (metadata with details, data dictionary, configuration), and uses the
newest discovery (interfaces), version delta (table matches), scope register (tables to migrate or rebuild), latest
code conversion, the pinned target baseline and the adapter's design section. The register is kept in the tenant
database. A new run keeps people's decisions on items whose source has not changed.

`GET /projects/{id}/design` gives counts per stream and status, the latest run, the target's design section (or why
it is missing), build counts and which streams the caller can decide. `GET /design/items?stream=` lists items;
`GET /design/item?stream=&key=` shows one with `readiness` (why it cannot be approved yet).

## Streams

**Mappings (E12.F1.S1).** Every in-scope source column gets a proposed target column with evidence, precedents and
a confidence: 0.55 × name similarity + 0.25 × type compatibility + 0.20 × table match, +0.15 when an earlier decision
in the tenant chose the same target, −0.15 when one chose another, −0.10 when the runner-up is within 0.05. Table
matches come from the version delta, then the same name, then a shared ontology concept, then a similar name.
Each target column is claimed by one source column. Items below 0.8, and columns with no target, go to the review
queue for the data SME; the decision there (accept, no target, or a changed `schema.table.column`) updates the
register. Required target columns nothing maps to are listed in the run summary.

**Configuration (E12.F2.S1).** Each configuration item records its source (kind, key, definition, dependencies)
and its target area, key, method and translated definition. Items matching a retirement are flagged with the
proposed replacement and go to review ("approve retirement" or "rebuild instead"). Applying configuration to the
target happens with loads (I10).

**Forms (E12.F2.S2).** Form designs become the target's format. A form is approved only after its converted PDF
passes parity against the approved golden copy: `PUT /design/form-files` uploads both, `POST /design/form-parity`
compares page count, page sizes, page text and form fields (names and types).

**Customer code (E12.F2.S3).** User-defined tables and converted procedures, functions and triggers are named by
the target's rules. A user-defined table needs its key declared (`PUT /design/code-key`): the source does not report
keys. Build generates the code and tests it (below).

**Integrations and desktop links (E12.F3.S1, E12.F3.S2).** Each interface found in discovery gets a target
design: inbound (writes or calls) on an inbound mechanism, read-only on a read mechanism, outbound (linked servers,
configured event programs) on an outbound one. Its touched tables show their mapped targets, and a flag warns when
its call volume would use over half the target's rate limit. Desktop-only links matching a retirement go to review:
an approved retirement or a browser replacement. A non-retired interface is approved only once it has an
end-to-end test (`PUT /design/integration-test`: HTTP steps with expected status and response keys);
`POST /design/integration-test-runs` runs it against a target connection (a sandbox), logging every call.

**Reports (E12.F3.S3).** Views are rebuilt as read-only procedures on the report access mechanism, with source
tables and columns renamed to their mapped targets. Build compiles and runs them. Report parity runs with
validation (I10).

**Pages and security (E12.F3.S4).** Pages are drafted for each source entity from its mappings (key fields, details,
related entities), because no adapter supplies legacy screen layouts yet; they need the solution architect's
approval. Each source security profile lists every new object (pages and reports) and is approved only when every
object has an explicit access decision (`none`, `view`, `edit` or `full`) via `PUT /design/security`.

## Decisions

`POST /design/decisions {stream, keys, action: approve | reject | change, reason, target?, no_target?}`.
Mappings are decided by the data SME, security profiles by the customer's IT security lead, everything else by the
solution architect. Items in the review queue are decided there; blocked items cannot be approved. Where the
project's compliance packs require two people for a stream's subject (for example `applies_to: [mapping]` with
`two_person_approval`), the first approval is recorded and a different person completes it.

## Build (E12.F4.S1)

`POST /projects/{id}/build` generates code from the register's decisions and tests it on the SQL Server workbench
(each run in a rolled-back transaction):

- **Transformations:** one procedure per (source table, target table) from approved mappings. It reads the staged
  source (`src` schema) and writes target-shaped rows (`tgt` schema) for loading. Same-type columns are not cast, so
  truncation and overflow raise errors; other types are converted explicitly. Tests seed up to 50 real rows from the
  newest extract (when one exists) plus a typical and an edge row, apply the target's NOT NULL rules, and check that
  every row arrives and every mapped value is preserved (numbers compared as numbers, dates as dates, text as text).
  An unmapped required target column fails the tests.
- **Customer code:** user-defined tables (tests: compiles, has a primary key) and converted code renamed to the
  target's names (tests: compiles, plus every recorded test case; at least one case is required).
- **Reports:** read-only procedures (tests: compile and run).

Artifacts are versioned by digest: unchanged code keeps its version; a change makes a new version and supersedes
earlier unapproved ones. `POST /build-artifacts/{id}/approve` (solution architect, not the person who generated it)
approves exactly that version. The database refuses approval unless the tests of that version passed, refuses any
change to an artifact's digest, and refuses agent approvers. Only `approved` artifacts are runnable; loads (I10)
run only those.
