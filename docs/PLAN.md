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

## 7. Known gaps after I1 (carried forward)

| Gap | Planned in |
|---|---|
| Tenant creation and region moves run inside the HTTP request; move them to the durable job runner with progress | I3 (runtime) |
| OpenAPI does not yet describe the bearer scheme, problem+json errors, non-JSON export responses or status enums | I2 |
| `/users` has no paging and no single-user endpoint | I12 (programme scale) |
| Plan impact of a pack upgrade (E04.F1.S2) and the control matrix (E07.F1.S1) | I7 |
| Loosening approvals and conflict decisions in the proof pack (E03.F2.S3) | I11 |
| A pack CLI and SDK templates for partners (E04.F3.S1, R3); packs are uploaded through the API until then | I4 / R3 |
| Model cost per agent on the observability dashboard (E01.F3.S2) | I3 |
| Live verification against Microsoft Entra ID and Okta (E01.F2.S1) | Needs a test tenant |

## 8. Working rhythm

For each story: read its acceptance criteria → design note (ADR when a decision is hard to reverse) → code and tests → audit and trace records → docs → mark `done` in `stories.json`. One increment at a time, with a demo at the end of each.
