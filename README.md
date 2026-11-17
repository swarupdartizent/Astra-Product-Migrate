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

This starts two regional Postgres servers, OpenBao (secrets and per-tenant keys), Keycloak (OIDC) and Jaeger,
and generates every secret into `.local/` (gitignored). It is idempotent; run it again after a reboot to unseal
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

| Service | URL |
|---|---|
| Web app | http://localhost:5273 |
| API docs (OpenAPI) | http://localhost:8000/api/v1/docs |
| Keycloak | http://localhost:18080 |
| Jaeger (traces) | http://localhost:16686 |

## Tests

```bash
cd platform && .venv/Scripts/python -m pytest -q
```

Integration tests run against the real local stack, using a separate control database (`astra_control_test`).

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
