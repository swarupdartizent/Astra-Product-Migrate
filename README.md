# Astra Migrate

A generic, pack-driven platform for moving a company from a legacy product to a new agentic product:
data, configuration, custom code, integrations, reports, users and workflows. Each migration is described
by configuration (a Migration Blueprint plus source, target, domain and compliance packs), not by new code.

- Architecture, ground rules and delivery plan: [docs/PLAN.md](docs/PLAN.md)
- Backlog traceability (128 stories, increment and status): [docs/backlog/stories.json](docs/backlog/stories.json)

**Ground rules.** Platform code is generic: reference-case knowledge lives only in `packs/` and `programmes/`,
and CI enforces it (`tools/genericity`). Nothing is faked: every screen shows real state, and missing inputs
show as *Blocked* with a reason.

## Run it locally

Prerequisites: Docker Desktop, Python 3.13, Node 24.

```bash
py -3.13 tools/dev.py up
```

This starts two regional Postgres servers, OpenBao (secrets and per-tenant keys), Keycloak (OIDC), Jaeger and
SQL Server 2022 Developer Edition (for golden estates and source databases; Microsoft's licence was accepted when
it was added), and generates every secret into `.local/` (gitignored). It is idempotent; run it again after a reboot to unseal
the vault.

```bash
cd platform && py -3.13 -m uv sync && .venv/Scripts/python -m alembic upgrade head
```

```bash
cd platform && .venv/Scripts/python -m uvicorn astra_migrate.api.app:app --port 8000
```

```bash
cd apps/web && npm install && npm run dev
```

Open http://localhost:5273 and sign in as `admin@astra.local`. The password is in
`.local/secrets/local_admin_password`. The first sign-in asks you to enrol an authenticator app (MFA).

> On machines where policy blocks the launcher `.exe` files that Python creates in `.venv/Scripts`,
> always run tools as `python -m <tool>`, as shown above.

Background work (tenant provisioning, region moves, agent runs and agent test suites) runs on a durable job
queue. The API process runs two worker threads (`ASTRA_JOB_WORKERS`); in Azure, workers run as their own
process: `python -m astra_migrate.jobs --workers 2`.

### Models and agents

Agents call models only through the model gateway, and no key is built in. To turn agents on:

1. Sign in as a platform administrator and open **Platform > Models**.
2. Add a provider (Anthropic by default). Record where its no-training terms are, store the API key (it goes
   to the vault and is never shown again), run **Check connection**, then enable it.
3. Point the alias `reasoning` at a model, for example `claude-opus-5-5`.
4. Under **Platform > Agents**, import the built-in agents, run the Orchestrator's test suite and release it
   when the suite passes. Then pin it on a project and start a run.

Until a provider is configured, model test cases and agent runs show as *Blocked* with the reason.

### Packs and adapters

Packs live in `packs/` (one folder each). Check them offline, then upload as drafts (or use the Packs screen):

```bash
cd platform && .venv/Scripts/python -m astra_migrate.packs.cli validate ../packs/*
```

Source adapters follow the adapter contract (`docs/adapter-contract.md`). A source adapter ships golden datasets:
synthetic estates with known answers that run on the local SQL Server (Packs > Golden datasets). Domain and adapter
packs publish only after a golden run with their exact contents passed. The reference case's packs and their own
tests are described in `programmes/conceptone-prosuite/README.md`.

| Service | URL |
|---|---|
| Web app | http://localhost:5273 |
| API docs (OpenAPI) | http://localhost:8000/api/v1/docs |
| Keycloak | http://localhost:18080 |
| Jaeger (traces) | http://localhost:16686 |
| SQL Server (golden estates) | 127.0.0.1:11433 |

## Tests

```bash
cd platform && .venv/Scripts/python -m pytest -q
```

Integration tests run against the real local stack, using a separate control database (`astra_control_test`).
Live agent tests (`tests/test_live_agents.py`) call a real model and run only when `ANTHROPIC_API_KEY` is set;
otherwise they are skipped with that reason.

## Layout

```
platform/    API, runtime and engines (Python, FastAPI)
apps/web/    workbenches (React, TypeScript)
packs/       adapter, domain, compliance and pattern packs
programmes/  reference-case programme and blueprints (configuration only)
testkit/     golden datasets and contract tests
infra/       local stack (docker compose); Azure templates later
tools/       dev tool, genericity guard
docs/        plan, ADRs, backlog traceability
```
