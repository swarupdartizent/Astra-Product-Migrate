# Astra Migrate: architecture and delivery plan

Sources: *Astra Migrate Product Specification v1.1*, *Astra Migrate Product Backlog v1.0* (128 stories) and the *ConceptOne to Pro Suite Fit Assessment*.
Story traceability with increment and status: [backlog/stories.json](backlog/stories.json).

---

## 1. Ground rules

1. **The platform is generic, and the reference case is configuration.** Nothing under `platform/` or `apps/` names a customer, vendor or product from the reference case. All reference-case knowledge lives under `packs/` (adapter, domain, compliance and pattern packs) and `programmes/` (blueprints and the programme set-up). A CI check fails the build if a denied term appears in platform code (the list lives in `tools/genericity/denylist.txt`).
2. **Nothing is faked.** Every screen reads real state from the API, every number comes from a real computation, and every agent call goes to a real model. Where a real input is missing (for example the Pro Suite sandbox), the feature is built against the contract and shows as **Blocked: waiting for input** in the UI, with the reason. It never shows made-up output.
3. **Test fixtures are labelled as fixtures.** The synthetic golden estate (E22.F1.S1) is a test asset with known answers. It lives in `testkit/` and is never presented as customer data. Its schema is modelled on an MGA policy administration system, not on the real ConceptOne schema, which we have not seen.
4. **Deterministic first, then agents** (as the fit assessment recommends). Delta, conversion, reconciliation, parity and gate checks are deterministic code. Agents propose, people decide, and deterministic code proves.
5. **Production grade from the first increment.** Every increment ships with tests, migrations, audit and trace records, and docs. The definition of done is backlog section 1.2.

## 2. Architecture

```
apps/web (React workbenches) ──HTTPS/OIDC──► platform/api (FastAPI)
                                               │
          ┌──────────────┬──────────────┬──────┴───────┬───────────────┬─────────────┐
     tenancy+IAM    pack registry    blueprint svc   planning engine   review/gates   proof pack
     audit log      ontology svc     (git-backed)    (agents+CP-SAT)   decisions      (signed PDF+JSON)
          │              │                               │
          └──── platform/runtime: durable job runner, agent runtime, model gateway, guardrails, tracing
                         │
          platform/connectors: engine drivers (SQL Anywhere, SQL Server, Postgres), REST/OAuth2 target driver
                         │
          packs/: source & target adapter packs (declarative + optional hooks), domain, compliance, pattern packs
```

| Concern | Local (now) | Azure (later) | Abstraction |
|---|---|---|---|
| API and workers | Python 3.13, FastAPI, SQLAlchemy 2, Alembic | Azure Container Apps | containers |
| Control-plane DB | PostgreSQL 17 + pgvector | Azure Database for PostgreSQL Flexible | SQLAlchemy |
| Tenant storage | One database per tenant, own data key | Same, plus per-tenant storage account | `TenantStore` |
| Secrets and keys | OpenBao (Vault-compatible) container | Azure Key Vault | `SecretStore`, `KeyService` |
| Identity | Keycloak (real OIDC, MFA policy) | Microsoft Entra ID, Okta | OIDC |
| Write-once audit | Hash-chained append-only table, UPDATE/DELETE revoked and blocked by trigger | Same, plus immutable Blob export | `AuditLog` |
| Tracing | OpenTelemetry → Jaeger | Azure Monitor / App Insights | OTel |
| Blueprint history | Git repository per tenant | Same, or Azure Repos | `BlueprintRepo` |
| Graph and vectors | Postgres node/edge tables + pgvector | Same (Cosmos/Neo4j optional later) | `GraphStore` |
| Constraint solver | Google OR-Tools CP-SAT | same | n/a |
| SQL dialect work | sqlglot with a custom SQL Anywhere dialect; compile check on a real SQL Server container | same | `DialectConverter` |
| Models | Model gateway: Anthropic (Claude, default) + a second provider (Azure OpenAI or Bedrock) | Same, through enterprise endpoints in the tenant's region | `ModelGateway` |
| Signed PDF | WeasyPrint + pyHanko | same, key in Key Vault | n/a |
| Web | React 19, TypeScript, Vite, TanStack Router/Query, Radix primitives, design tokens, React Flow for graphs | Static Web Apps or Container Apps | n/a |
| Infra as code | docker compose | Bicep | n/a |

### Adapter design that keeps the platform generic

An adapter pack is mostly declarative: which engine driver it uses, which catalogue queries read its metadata, how its entities map to core ontology concepts, its known traps, its limits, and its load methods. The platform ships the **engine drivers** (generic per database engine or API style). Product-specific code, if any is ever needed, lives as a hook inside the pack and runs behind the same contract test suite (E05.F1.S1).

## 3. Repository layout

```
platform/      api, runtime, connectors, engines (delta, conversion, recon, parity, planner)
apps/web/      workbenches (planning, review, programme, admin)
packs/         adapter, domain, compliance, pattern packs (versioned, tested)
programmes/    reference-case programme and blueprints (configuration only)
testkit/       golden datasets, contract tests, manipulation cases
infra/         docker compose (local), Bicep (Azure)
tools/         genericity guard, pack CLI
docs/          this plan, ADRs, backlog traceability
```

## 4. Delivery increments (R1: 102 stories)

Each increment ends with a running, demonstrable slice. Story IDs are in `backlog/stories.json`.

| # | Increment | Stories | What you can see at the end |
|---|---|---|---|
| I0 | Engineering foundation | none | Repo, CI, local stack in one command, design system, app shell, genericity guard |
| I1 | Platform foundation (E01) | 7 | Create tenants with region and own key, SSO sign-in with roles, vault secrets, tamper-evident audit log, traces |
| I2 | Packs and blueprints (E04, E03, E07.F1) | 10 | Publish versioned packs, author blueprints in form or YAML, diff, validate, resolve conflicts, dual approval |
| I3 | Agent runtime and AI governance (E02) | 6 | Registered agents with tool allow-lists, model gateway, data-not-instructions guardrail with 20+ manipulation tests, governance records |
| I4 | Adapters, reference packs, golden estate (E05, E06.F1–F2, E07.F2, E22.F1.S1) | 13 | Adapter contract and tests, reference-case source and target adapter packs, P&C + MGA pack, first compliance packs, ontology service, synthetic golden estate |
| I5 | Discovery and knowledge graph (E08, E13.F2.S1) | 8 | Harvest, profile, usage, code rules, interface finder, configuration reader, coverage report |
| I6 | Version delta and platform conversion (E09, E10) | 6 | Deterministic four-group delta, SQL Anywhere to SQL Server conversion compiled on real SQL Server, recorded-I/O tests |
| I7 | Planning engine (E11, E15.F1.S1/S3, E19) | 16 | Scope register, dependency graph, ≤40h tasks, ranged estimates, control matrix, CP-SAT waves, risks, cutover comparison and runbook, baselines, Jira/ADO export, pre-sales mode, vendor gaps |
| I8 | Workbenches and precedents (E16, E21.F1.S1) | 6 | Risk-sorted review queue, evidence panel, approve/reject/change, Review Assistant, plan timeline/list/graph (WCAG 2.2 AA) |
| I9 | Design and build (E12) | 9 | Mapping proposals, configuration translation, forms, code modernisation, integration and report rebuilds, view drafts, tested transformation code |
| I10 | Loads, validation, reconciliation, parity (E13, E14, E15.F1.S2) | 12 | Numbered repeatable load runs, error queue, deltas, document link and byte checks, recon to the cent, rating/forms/report/workflow/accounting parity |
| I11 | Gates and proof pack (E17) | 2 | Gate checklists, signed PDF + structured proof pack |
| I12 | Installed-base programme (E18) | 6 | Programme set-up, consented fleet scan, Complexity Index, portfolio planner, programme owner view, commercial metering |
| I13 | Release gate (E22.F1.S2) | 1 | Release blocked when any golden measure regresses |

A thin **review-item and decision service** is built in I2, because conflicts, approvals and scope decisions need it from the start. I8 builds the full review workbench on top of it.

R2–R4 stories (26) follow after R1, in the order of release phases 2–4.

## 5. Inputs we do not have yet

| Input | Needed for | What we do until it arrives |
|---|---|---|
| A real ConceptOne database (sample or Insurity reference) | I4 adapter validation, I5, I6, I13 | Build against the synthetic golden estate. The adapter pack's catalogue queries stay marked *unvalidated* until run against a real estate. |
| SAP SQL Anywhere engine (developer edition) | E05.F2.S1, E10.F1.S2 recorded I/O on the source | The SQL Server path works fully. SQL Anywhere connection tests run only when an engine is available, and are skipped with a visible reason otherwise. |
| Pro Suite Base baseline metadata, API docs, sandbox and OAuth2 credentials | E05.F3, E09, E13 loads | Build the generic REST/OAuth2 target driver and its contract. Loads to the reference target show as *Blocked*. |
| Model API keys (Anthropic plus a second provider) | I3 onwards | Agent features cannot run without them; no stubbed answers. |
| Named SMEs and compliance reviewers | Pack release status | Packs can be published as *draft*. Release status needs the named reviewer (E07.F2.S1). |

## 6. Decisions (17 Nov 2026)

| Decision | Choice |
|---|---|
| Stack | Python 3.13 (FastAPI) + React/TypeScript. Dependencies locked with uv and npm lockfiles. |
| Models | Anthropic API key (Claude default). The second gateway provider is built to the same contract and enabled when a key exists. |
| Real reference inputs | None yet. Work starts on the synthetic golden estate; reference-case adapters stay *unvalidated* and Pro Suite loads stay *Blocked*. |
| Start | I0 then I1, with a demo after each. |

## 7. Known gaps (carried forward)

| Gap | Planned in |
|---|---|
| The Orchestrator's model test cases are *Blocked* until a model provider with a real key is configured; it cannot be released (and so cannot run) before that. Live tests (`tests/test_live_agents.py`) run only when `ANTHROPIC_API_KEY` is set | Needs the Anthropic key |
| The Azure OpenAI and Claude-on-Foundry drivers are built and unit-checked but not yet called live | Needs Azure keys |
| Model calls are checked against the region's provider list, but not yet against blueprint residency controls (the I7 control matrix lists residency controls; enforcing them on model calls is not done) | I9 (agents at scale) |
| The other agents in the specification are registered as their tools arrive (only the Orchestrator's tools exist now) | I5 onwards |
| Model prices are kept by administrators on each provider; there is no automatic price feed | Later |
| API gaps from the I3 screens still open: allowed stage moves before trying, `/jobs` paging, untyped governance and transcript payloads (`can_cancel` and the reason a review item cannot be resolved were added in I4; not taken up in I8) | I9 |
| The reference source adapter is proven only on the synthetic golden estate; its entity tables and SQL Anywhere queries must be confirmed on a real ConceptOne estate | Needs a ConceptOne reference database |
| SQL Anywhere: the driver is written but needs an engine and SAP client libraries to run | Needs SQL Anywhere |
| Pro Suite Base loads are Blocked: token endpoint, load endpoints, rate limits and approved bulk tools are unknown; only a synthetic baseline exists | Needs Insurity API docs, sandbox and baseline |
| The five compliance packs are not published: each needs a named compliance specialist's review | Needs named reviewers |
| Ontology embeddings are lexical (no meaning beyond shared wording); a model-based embedder can replace them | Later |
| Dependencies hidden in dynamic SQL are reported as interface rules, not resolved; resolving them needs the Code Reader agent or the RE Harness | Agents (model key) |
| Discovery agents (Metadata Harvester, Profiler, Code Reader, Process Miner) are not registered yet; the deterministic engines run without them | Needs a model key |
| Process mining (DS-04) and agentification candidates are not started; coverage reports show them as gaps | Agentification increment |
| Screens are not linked to rules: no adapter supplies screen metadata yet | With a real estate |
| Server-wide usage statistics (index usage, sessions) are not read; usage comes from imported records | Later |
| API gaps from the I5 screens: untyped discovery result schemas, no `can_start`/`can_waive` hints, results refused for runs that failed late, no single coverage-report GET, graph edge paging and filtered counts, no delete for activity imports (not taken up in I6, I7 or I8) | I9 |
| The Scope Analyst and Cutover Planner agents are not registered; scope proposals and cutover figures come from deterministic rules and stated assumptions | Needs a model key |
| The generic estimation pack is uncalibrated planning assumptions; estimates become evidence-based only as actual effort flows back (three past tasks per rule) | With delivered work |
| Jira and Azure DevOps exchange is through their CSV import and export formats; live two-way API sync needs credentials for each tool | Needs Jira/ADO credentials |
| Risks found by agents use the same proposal flow as the planner's, but no agent raises risks yet | Needs a model key |
| API gaps from the I7 screens still open: untyped planning responses; owner pickers need access:read (`/users`); no permission hints for pre-sales, vendor changes or gaps; plan sub-tabs not deep-linkable (I8 added the scope-key list, the dependency removal reason in the body and the waiting-baseline flag) | I9 |
| I7 screens are verified by unit tests and end-to-end tests against recorded API responses, not yet signed in on the live stack | Next demo |
| The wave solver places scope items, not individual tasks, and does not model calendar time inside a wave | Later |
| SQL Anywhere conversion is proven on synthetic Watcom-SQL objects compiled and tested on SQL Server; reading code from a live SQL Anywhere estate waits for an engine | Needs SQL Anywhere |
| The version delta compares tables by columns and code by normalized hash; configuration items are not yet in the delta, and the 60% same-family threshold is untuned | With a real target baseline |
| The reference source adapter does not yet use `compare_as`/`customization` for its customer extension tables (published 1.1.0 cannot change); until its next version, the delta lists those tables as not in scope | Next reference adapter version |
| Recorded conversion test cases are entered through the API; there is no import from the customer's capture tools yet | I9 |
| The reference target adapter records no hosting constraints for SSO, MFA, network or printing, so its checklist shows the generic items | Needs Insurity hosting documentation |
| API gaps from the I6 screens: no project-scoped list of possible checklist owners (`/users` needs access:read), no permission hints on recorded tests or on starting delta and conversion runs (tenant-level source:manage), untyped delta, conversion and checklist responses, no list of supported dialect pairs, test cases not checked against existing objects, no deep link to a single run | I7 |
| I6 screens are verified by unit tests and by end-to-end tests against recorded API responses; a signed-in walk-through on the live stack needs the administrator's authenticator sign-in | Next demo |
| API gaps from the I4 screens: no source-adapter detail endpoint, untyped run summaries and ontology responses, no permission hints on target connections and golden runs, extract documents capped at 500 without paging, loads have no record beyond the call log, and no up-front "loads blocked" flag on target connections | I5 |
| `npm audit` reports high findings in development tooling only (via picomatch); production dependencies have none | Next dependency update |
| I4 screens are verified by unit tests and by end-to-end tests against recorded API responses; a signed-in walk-through on the live stack needs the administrator's authenticator sign-in | Next demo |
| I3 screens are verified by unit tests and by end-to-end tests against recorded API responses; a signed-in walk-through on the live stack needs the administrator's authenticator sign-in | Next demo |
| The Review Assistant answers only when a released version is pinned on the project and a model key is configured; until then reviewers see the explanation built from the recorded evidence | Needs a model key |
| Risk on items raised by platform rules is a fixed value per item type (for example high for triggers and procedures that need hand conversion); agents state their own risk and confidence | With delivered work |
| Bulk approval of items sharing a pattern (E16.F1.S5, never for compliance-critical items) | R2 |
| Review items raised before I8 have no stream, segment, pattern key or evidence links, and count as medium risk with no compliance impact | Not planned (development data only) |
| API gaps from the I8 screens: conversion evidence links carry no object type (same-named objects of different types cannot be told apart); queue rows do not say whether the caller already approved or is the named reviewer; pattern groups have no readable label; the plan workbench does not return the maximum task hours; the Review Assistant's answer is reachable only through the run transcript | I9 |
| I8 screens are verified by unit tests and end-to-end tests (with accessibility checks) against recorded API responses, not yet signed in on the live stack; plan drag-and-drop has no automated test (the keyboard move does) | Next demo |
| The reference target adapter has no design section yet (mechanisms, naming rules, configuration areas, forms, page builder), so its design streams show as blocked; the fit assessment's reported facts go into its next version, and confirmed values need Insurity documentation | Next reference target adapter version |
| Configuration, forms and integrations are designed and tested, but applying them to the target (configuration API or import, form upload) happens with loads | I10 |
| Report parity and form parity in the validation workbench (I9 checks form parity against the golden copy and compiles and runs reports) | I10 |
| Page drafts are per entity from mappings; drafting from legacy screens needs adapters to supply screen layout metadata | With a real estate |
| The data dictionary does not report keys or decimal precision: customer tables need their key declared, and decimals are staged as decimal(38,10) | Next adapter contract version |
| Code-list value mappings (source code to target code) are not proposed yet; mappings are column-level | I10 |
| The Configuration Translator, Code Modernizer, Integration Rebuilder and Target Designer agents are not registered; proposals come from deterministic rules | Needs a model key |
| API gaps from the I9 screens: build artifacts name their approver by id only; no permission flag for running integration tests (shares stage management with build); no record of a build run beyond its job; the item list searches keys only and its rows lack readiness and can_decide; uploaded PDFs cannot be downloaded back; precedents carry a project id without its name; design runs return no connection name; register updates return the item without readiness, can_decide or files (I9 fixed: form parity checks the decider and decided state, and can_approve excludes the person who generated a version) | I10 |
| I9 screens are verified by unit tests and end-to-end tests (with accessibility checks) against recorded API responses, not yet signed in on the live stack or with real PDFs | Next demo |
| Parity compares result files from both systems; driving the source and target rating, report and workflow engines directly needs their APIs | With target documentation |
| The target side of coexistence and document checks is what the target accepted in loads or returns from its documents path; reading the target's data directly needs its read API (for example DBQuery) | With target documentation |
| Loads into the reference target stay rehearsals until its token endpoint, load endpoints (with tables) and documents path are documented | Needs Insurity API docs and sandbox |
| Staging runs on the SQL Server workbench in one transaction per artifact; very large estates need batching by key range | With a real estate |
| I10 screens are verified by unit tests and end-to-end tests (with accessibility checks) against recorded API responses, not yet signed in on the live stack | Next demo |
| The window, not the content area, scrolls beneath the sticky top bar, so at some scroll positions controls sit partly under it (scroll padding keeps focused controls clear); moving scrolling to the content area is a shell change | Next shell update |
| Some tests are timing-sensitive under full-suite load and pass alone: the plan workbench keyboard-move end-to-end test, the home page and audit page smoke tests | Next test hardening |
| Proof packs carry a detached Ed25519 signature from the vault key, verifiable with the published public key; a PAdES signature that PDF readers show needs an organisation signing certificate | Needs an organisation certificate |
| The reference programme's G0 to G4 labels and approvers belong in its blueprint (`gates`), which is set up with the programme | With the reference programme |
| Proof packs are produced on request; producing one automatically when a gate passes or a wave cuts over is not set up | Later |
| I11 screens are verified by unit tests and end-to-end tests (with accessibility checks) against recorded API responses, not yet signed in on the live stack | Next demo |
| API gaps from the I11 screens: the gates list does not return the caller's user id (the screen reads /me); proof pack waves are keys without names; the signature and public key formats are documented in docs/gates.md but not in the API's schema | I12 |
| The Complexity Index weights and reference ranges are starting assumptions; calibrate them against delivered customers' actual effort | With delivered customers |
| Gate evidence goes to billing as CSV; a live billing integration needs the billing system's API | Needs the billing system |
| The programme view reads each customer's database for risk and effort counts on every request; very large programmes need these figures cached | Programme scale |
| I12 screens are verified by unit tests and end-to-end tests (with accessibility checks) against recorded API responses, not yet signed in on the live stack | Next demo |
| API gaps from the I12 screens: source connections do not say whether a check ever succeeded (the scan refuses unchecked ones server-side); the fleet view returns only succeeded scans; gate titles for `next_gate` are repeated in the web app | I13 |
| Mapping table matching does not use earlier decisions in the tenant, so a renamed customer table finds no target (the golden suite measures it: top-1 accuracy 0.867, every miss goes to review) | Next mapping work |
| One golden evaluation suite exists; more suites (and the reference programme's own, once its real estate is available) make the gate stronger. Agent measures need a model key | With more estates |
| Confidence calibration per agent (E22.F1.S3) | R2 |
| I13 screens are not built yet | I13 (screens) |
| OpenAPI does not yet describe the bearer scheme, problem+json errors, non-JSON export responses or status enums | I2 |
| `/users` has no paging and no single-user endpoint | I12 (programme scale) |
| Plan impact of a pack upgrade (E04.F1.S2) and the control matrix (E07.F1.S1) | I7 |
| SDK templates for partners (E04.F3.S1); the pack CLI (validate, bundle, upload) exists since I4 | R3 |
| Live verification against Microsoft Entra ID and Okta (E01.F2.S1) | Needs a test tenant |

## 8. Working rhythm

For each story: read its acceptance criteria → design note (ADR when a decision is hard to reverse) → code and tests → audit and trace records → docs → mark `done` in `stories.json`. One increment at a time, with a demo at the end of each.
