# Astra Migrate web

React front end for Astra Migrate: design system, app shell, OIDC sign-in and the typed API client.
Feature workbenches are built on top of these primitives.

Ground rules (from `docs/PLAN.md`): the platform is generic, and nothing is faked. Every screen reads
real state from `/api/v1`. When the API fails, the UI shows an honest error state with a retry. It
never shows invented numbers or placeholder pages for features that do not exist yet.

## Run it

Requirements: Node 22+ (developed on Node 24) and npm 11.

```bash
cd apps/web
npm ci
npm run dev          # http://localhost:5273 (port is fixed: it is the registered OIDC redirect)
```

The dev server proxies `/api` to `http://127.0.0.1:8000`. Set `ASTRA_API_PROXY_TARGET` to change this.
To sign in you need the local Keycloak realm running at `http://localhost:18080/realms/astra` (see
`infra/local`).

| Command             | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `npm run dev`       | Vite dev server on port 5273                                                |
| `npm run build`     | Type-check, then production build to `dist/`                                |
| `npm run preview`   | Serve `dist/` on port 4173                                                  |
| `npm run typecheck` | `tsc -b` (strict)                                                           |
| `npm run lint`      | ESLint (typescript-eslint strict, react-hooks, jsx-a11y strict), 0 warnings |
| `npm run format`    | Prettier write (`format:check` to verify)                                   |
| `npm test`          | Vitest + Testing Library (jsdom)                                            |
| `npm run test:e2e`  | Playwright + axe accessibility checks (builds and serves on 4173)           |

First Playwright run: `npx playwright install chromium`.

### Configuration (Vite env)

Copy `.env.example` to `.env.local` to override. All values are public; never put secrets here.

| Variable                   | Default                               | Notes                                |
| -------------------------- | ------------------------------------- | ------------------------------------ |
| `VITE_OIDC_AUTHORITY`      | `http://localhost:18080/realms/astra` | OIDC issuer                          |
| `VITE_OIDC_CLIENT_ID`      | `astra-web`                           | Public client, PKCE S256             |
| `VITE_OIDC_REDIRECT_URI`   | `<origin>/auth/callback`              | Must be registered with the provider |
| `VITE_OIDC_MFA_ACR_VALUES` | empty                                 | `acr_values` sent on step-up sign-in |

## Structure

```
src/
  main.tsx              entry: creates QueryClient + router, mounts <App>
  app/
    App.tsx             provider stack (error boundary, theme, query, tooltips, auth, toasts)
    router.tsx          code-based TanStack Router: public routes + authenticated layout
    navigation.ts       nav registry (sidebar + command palette), permission-filtered
    AppShell.tsx        sidebar, top bar, context-switcher slot, command palette, user menu
    ApiErrorView.tsx    maps any ApiError to the right UI state (MFA, forbidden, offline, ...)
    RequirePermission.tsx  page-level permission guard
    permissions.ts      usePermissions() from GET /api/v1/me
    context-switcher.ts useContextSwitcher() to fill the top-bar slot
  auth/                 oidc-client-ts UserManager, AuthProvider, useAuth
  api/
    types.ts            wire types for /api/v1 (mirror the backend contract)
    errors.ts           ApiError + RFC 9457 problem parsing and classification
    client.ts           fetch wrapper (bearer token, 401 refresh-and-retry, problem errors)
    queries.ts          query keys, queryOptions and hooks (useHealth, useMe)
    queryClient.ts      retry policy (transient failures only)
  ui/                   design system (import from '@/ui' only)
  pages/                route components (sign-in, callback, home, 404, route error)
  theme/                light/dark/system preference
  styles/tokens.css     design tokens (single source of truth)
  styles/global.css     reset, base typography, focus ring
  lib/                  small helpers (storage, time, platform)
  test/                 Vitest setup and render helpers
e2e/                    Playwright specs (axe accessibility smoke tests)
```

## Screens

| Route                                           | Nav permission                                            | What it does                                                                                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                             | any signed-in user                                        | Greeting, "Get started" links to the screens you can open, your role assignments, platform health                                                                                                       |
| `/tenants`                                      | `tenant:read`                                             | Tenant list; "New tenant" (needs `tenant:create`) builds the database, role and key synchronously                                                                                                       |
| `/tenants/$tenantId?tab=`                       | `tenant:read`                                             | Tabs: overview, security policy, connector secrets, region, danger zone                                                                                                                                 |
| `/programmes`                                   | `tenant:read`                                             | Programmes with partners; create programme and add partner need `programme:manage`                                                                                                                      |
| `/access`                                       | `access:read`                                             | People search, invite, role grant/revoke, enable/disable (side panel)                                                                                                                                   |
| `/audit`                                        | `audit:read`                                              | Filtered, keyset-paginated audit log; detail panel; CSV/JSONL export (`audit:export`); integrity verification (`audit:verify`) and signed anchors                                                       |
| `/observability`                                | `observability:read`                                      | Span summary grouped by category, tenant, operation, stage, agent or project; recent traces                                                                                                             |
| `/observability/traces/$traceId`                | `observability:read`                                      | Trace waterfall, span attributes, link to Jaeger when the API provides one                                                                                                                              |
| `/packs`                                        | any signed-in user                                        | Pack library grouped by name (expand for older versions), filters; "Upload pack" (`pack:publish`) sends a folder or files as `{files: {path: base64}}`                                                  |
| `/packs/$name/$version?tab=`                    | any signed-in user                                        | Overview (disclaimer, requires, digest, review), controls with placement, rules, settings, files, tests and release (run tests, record review with `pack:review`, publish, deprecate), compare versions |
| `/packs/compose`                                | any signed-in user                                        | Composition preview of published packs: controls by placement area, settings with conflicts, requirement problems                                                                                       |
| `/tenants/$tenantId?tab=projects`               | `tenant:read`                                             | Projects with latest/approved version and planning gate; "New project" needs `project:create` on the tenant                                                                                             |
| `/projects/$projectId?tab=&version=`            | project read                                              | Blueprint workspace: editor (form and YAML views, live validation, save), versions and approvals, compare, decisions                                                                                    |
| `/templates`                                    | any signed-in user                                        | Blueprint templates; "New template" needs `template:manage`                                                                                                                                             |
| `/models?tab=`                                  | any of `model:manage`, `audit:read`, `observability:read` | Providers (problems, credential, connection test, prices, enable), aliases, usage and cost, model calls. Editing needs `model:manage`                                                                   |
| `/agents?tab=`                                  | any signed-in user with a role                            | Registry, built-in catalogue (import with `agent:manage`), model readiness, governance records (JSON download), guardrail lab (`agent:manage` or `audit:read`)                                          |
| `/agents/$name/$version?tab=`                   | as above                                                  | Purpose, tools and forbidden effects, limits, oversight, release blockers; test suite with per-case results (Blocked is never shown as failed); read-only manifest; governance record                   |
| `/agents/register`                              | `agent:manage`                                            | Manifest YAML with live validation (field paths such as `tests.3.expect.must_call`)                                                                                                                     |
| `/projects/$projectId?tab=agents`               | project read                                              | Pins (`agent:pin`), runs (`agent:run`), run transcript timeline, project jobs                                                                                                                           |
| `/projects/$projectId?tab=reviews`              | project read                                              | Review queue; resolve or dismiss when `can_resolve`                                                                                                                                                     |
| `/projects/$projectId?tab=baseline`             | project read                                              | Pinned target baseline; pin or change it with a reason (`blueprint:edit`)                                                                                                                               |
| `/tenants/$tenantId?tab=sources`                | `tenant:read`                                             | Source connections (`source:manage` per connection via `can_manage`), check/harvest/extract runs, 409 messages                                                                                          |
| `/tenants/$tenantId?tab=targets`                | `tenant:read`                                             | Target connections, loads (`target:load`; a job error starting "Blocked:" shows as Blocked), call log                                                                                                   |
| `/adapter-runs/$runId`                          | `tenant:read`                                             | Check (read-only evidence; a writable account is refused), harvest coverage, trap findings, paged object browser with code; extract counts and documents                                                |
| `/adapters?tab=`                                | any signed-in user                                        | Adapter list (contract mismatch, Unvalidated badge) and the adapter contract                                                                                                                            |
| `/adapters/$name/$version?tab=`                 | any signed-in user                                        | Source: object types, entities and concept bindings, document store, golden datasets; traps (curate with `trap:curate`); target: constraints and load config                                            |
| `/golden?dataset=`                              | any signed-in user                                        | Golden datasets, expected answers, runs (`golden:run`) and the scorecard; Blocked runs show their reason                                                                                                |
| `/baselines`, `/baselines/$id`                  | any signed-in user                                        | Immutable target baselines (synthetic ones marked); add with `baseline:manage`; paged objects and columns                                                                                               |
| `/ontology?packs=`, `/ontology/$conceptId?tab=` | any signed-in user                                        | Concept browse and search (exact/similar, score), concept detail, constraints, bindings, precedents; always shows `ontology_version`                                                                    |
| `/projects/$projectId?tab=discovery`            | project read                                              | Discovery runs (start with `source:manage`), the current coverage report: nine streams, gaps, waivers (reason >= 15) and accept/reject (`can_decide`, note >= 10; a 409 lists open gaps)                |
| `/discovery-runs/$runId?tab=&node=&unused=`     | project read                                              | Phases and summary; profile, usage (flagged for retirement review), rules, interfaces, configuration differences between scopes, documents, dictionary; knowledge graph explorer                        |

Per-tenant actions are gated by `Tenant.permissions` (the permissions the caller holds on that
tenant), not by the global `/me` list: policy edits need `tenant:update_policy`, secrets need
`secrets:read` / `secrets:manage`, region moves `tenant:region_migrate`, deletion `tenant:delete`.
Hidden buttons are a convenience; the API enforces every rule and its 403 is always handled.

Feature code lives in `src/features/<area>/`, with pure logic (validation, policy-loosening rule,
waterfall layout) in each area's `model.ts` and unit tests beside it. Query hooks live in
`src/api/{tenancy,access,audit,observability}.ts`, with query keys under a feature prefix
(`['tenants', ...]`, `['access', ...]`, `['audit', ...]`, `['observability', ...]`) and invalidation
on every mutation.

Forms follow one pattern: client validation mirrors the API rules and shows after the first submit;
422 `errors: [{field, message}]` from the API are mapped onto the matching `Field` (the server wins);
anything else renders in `FormError` (auth and permission problems render their dedicated state,
e.g. the multi-factor step-up).

### Background jobs and AI runtime

- Long work runs as background jobs. `JobProgress` (`src/app/JobProgress.tsx`) polls
  `GET /jobs/{id}` while a job is queued or running, shows an accessible progress bar and the
  job's message, reports the end once (`onFinished`), and shows the job's `error` when it fails.
  Tenant provisioning (`active_job`), region moves (`detail.job_id`), agent test suites and agent
  runs all use it. `JobsCard` lists a tenant's or project's jobs and can cancel queued ones.
- The project page shows the six lifecycle stages. With `stage:manage` a stage can be changed;
  a refusal (409 `/problems/gate-closed`) lists the gate's reasons in the dialog.
- Model and legacy text (run output, transcripts, flagged review text, guardrail lab) is shown
  with `PlainText`: verbatim, never as HTML.
- Model cost is shown from recorded calls; a call with no configured price shows
  "Price not configured" and is counted in `unpriced_calls`, never as zero.

### Adapters, sources, targets and the ontology

- Adapter packs that fail the contract say "Does not match the adapter contract" with the API's
  `contract_problem`; packs not proven on a real estate or target carry an "Unvalidated" badge.
- A target adapter with no recorded endpoints or token path says "Loads are Blocked: the target's
  API endpoints are not yet recorded." Load jobs that fail with an error starting "Blocked:" are
  shown as Blocked, never as failed.
- A connection check on an account that can write says "This account can write to the source.
  Adapters only run with read-only accounts." Extracts stay disabled until a check passes.
- Harvested code, trap queries and hits, expected answers and object detail are shown with
  `PlainText` (line numbers for code), never as HTML.
- Curated traps are written as YAML or JSON (`yaml` package); 422 field paths such as
  `trap.detect.queries.sqlserver` are listed under the editor.
- Every ontology answer shows its `ontology_version`; the pack picker scopes all calls
  (`packs=` repeated), defaulting to the latest published domain packs.
- Hooks live in `src/api/{adapters,targets,ontology}.ts`.

### Discovery and the knowledge graph

- Activity imports (logins and queries, JSONL or CSV, up to 25 MB) are on each source
  connection's card; the dialog explains the format. 422 messages on `content_base64` are shown
  under the file field.
- Result sections are only fetched for a succeeded run; Blocked and failed runs show the API's
  `status_detail`, and partial phases show their detail.
- Null rates are computed as nulls / rows; value shapes (for example 99-9999999) never hold values.
- Configuration differences show every scope side by side with its definition as plain text;
  scopes that agree share a variant number, missing scopes are marked.
- Unused elements are "flagged for retirement review", never retired; the review item links to
  the run's usage tab. The stage strip links the discovery stage to the coverage report.

### Blueprint workspace

- The editor keeps one draft in two views. The form edits the blueprint mapping (`content`); the
  YAML view edits the file. Switching calls `POST /blueprints/convert` so both always match the
  server's reading; invalid YAML keeps you in the file view and shows the line and column.
- Validation runs on every pause in typing (`POST /projects/{id}/blueprint/validate`; nothing is
  stored). Issues are grouped by severity; selecting one focuses the matching form field
  (`fieldId(path)` in `features/blueprints/model.ts`).
- Overrides show a live badge: "Loosens · needs approval" and "No pack sets this" come from the
  validation issues; "Tightens" / "Same as packs" / "Loosens · approved" are worked out from the
  composed setting with the same strictness rule as the API.
- Saving asks why (≥5 characters) and creates a new numbered version, committed to git. Approved
  versions are locked; changes are new versions that need approval again.
- Approve/Reject buttons appear only when `VersionDetail.can_approve_as` is non-empty; per-project
  buttons use `Project.permissions`. Decisions (setting conflicts and loosening requests) are made
  by a person with a reason; no default is ever applied.

## Auth

- Authorization Code + PKCE with `oidc-client-ts`. Tokens live in `sessionStorage`.
- Silent renew uses the refresh token (no hidden iframe, no third-party cookies).
- The API client attaches `Authorization: Bearer <access token>`. On a `401` it refreshes once and
  retries. If that fails, the session ends: a toast explains it, cached data is cleared, and route
  guards redirect to `/sign-in?redirect=<where you were>`.
- A `403` whose problem `type` ends in `/mfa-required` renders "Multi-factor sign-in required" with a
  button that calls `signinRedirect` with `prompt=login` (plus `acr_values` when configured).
  Any other `403` renders a permission-denied state.
- A `401` whose type ends in `/session-expired` comes from a tenant's own session timeout. It does
  not end the app session (other screens still work); the screen shows "Sign in again", which
  starts a fresh sign-in (`prompt=login`).
- Sign-out ends the provider session (`signoutRedirect`). If the provider is unreachable, the local
  session still ends and the user is told.

## Adding a feature page and nav entry

1. **API types and hooks.** Add wire types to `src/api/types.ts`, exactly as the backend returns them.
   Add `queryOptions` and hooks next to `src/api/queries.ts` (or a feature file such as
   `src/api/tenants.ts`) using `api.get/post/...` from `src/api/client.ts`.
2. **Page.** Create `src/pages/TenantsPage.tsx` (or `src/features/tenants/...`). Use `PageHeader`,
   `Card`, `DataTable`, `EmptyState` and friends from `@/ui`. Render `ApiErrorView` for query errors,
   `EmptyState` for genuinely empty results and skeletons while loading. Call
   `useDocumentTitle('Tenants')`. Wrap the page in `<RequirePermission permission="tenant:read">`.
3. **Route.** In `src/app/router.tsx`, add a child of `appLayoutRoute`:
   ```ts
   const tenantsRoute = createRoute({
     getParentRoute: () => appLayoutRoute,
     path: '/tenants',
     component: TenantsPage,
   });
   // ...and include it: appLayoutRoute.addChildren([homeRoute, tenantsRoute])
   ```
4. **Nav entry.** In `src/app/navigation.ts`, add to `navItems`:
   ```ts
   { id: 'tenants', to: '/tenants', label: 'Tenants', icon: Building2,
     permission: 'tenant:read', group: 'platform', keywords: ['organisations'] }
   ```
   The sidebar and command palette pick it up automatically, and only users whose
   `/api/v1/me` `permissions` include `tenant:read` see it. The API stays the real enforcement point.
5. **Tests.** Add a Vitest file beside the page. Mock `fetch` with labelled fixtures that follow the
   API contract (see `src/pages/HomePage.test.tsx`).

Only register a nav entry when its page and API exist. Do not add placeholder pages.

## Design system

Import from `@/ui`. Every component is keyboard-accessible, has visible focus, and uses tokens only.

| Component                                               | Notes                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Button`, `IconButton`                                  | `primary` / `secondary` / `ghost` / `danger`; sizes `sm` / `md` / `lg`; `loading`; `asChild` for links. `IconButton` requires `label`.           |
| `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`     | Pick up label, help and error wiring automatically inside `Field`.                                                                               |
| `Field`                                                 | Label, help, error, `required`; sets `id`, `aria-describedby`, `aria-invalid`. `inline` for toggles.                                             |
| `Badge`, `StatusPill`                                   | Tones: `neutral`, `accent`, `success`, `warning`, `danger`, `info`. Status always has text.                                                      |
| `Callout`                                               | Inline persistent message (info, success, warning, danger).                                                                                      |
| `Card` (+ `CardHeader`, `CardBody`, `CardFooter`)       | `flush` for edge-to-edge tables.                                                                                                                 |
| `PageHeader`                                            | Title, description, actions, breadcrumbs, meta.                                                                                                  |
| `DataTable` + `createDataTableColumns`                  | TanStack Table v9: sorting (`aria-sort`), column resizing (mouse, touch, arrow keys), sticky header, skeleton rows, empty state, row activation. |
| `Sheet`                                                 | Side panel (modal) for inspecting a record from a list.                                                                                          |
| `SegmentedControl`                                      | Radio-group switch between a few views (arrow keys move and select).                                                                             |
| `Tabs`, `TabsList`, `Tab`, `TabPanel`                   | Radix tabs.                                                                                                                                      |
| `Dialog`, `DialogContent`, `DialogBody`, `DialogFooter` | Title required; focus trapped.                                                                                                                   |
| `ConfirmDialog`                                         | Async confirm with spinner and inline error; `confirmationText` for typed confirmation of destructive actions.                                   |
| `DropdownMenu*`                                         | Items, radio items, checkbox items, labels, separators.                                                                                          |
| `Tooltip`, `TooltipProvider`                            | Supplementary hints only.                                                                                                                        |
| `toast`, `Toaster`                                      | sonner, themed.                                                                                                                                  |
| `Skeleton`, `Spinner`                                   | Loading placeholders.                                                                                                                            |
| `EmptyState`, `ErrorState`                              | Icon, title, body, action. `ErrorState` is `role="alert"` with optional retry.                                                                   |
| `Kbd`, `Mono`, `CodeBlock`                              | Keys, inline monospace, copyable code block.                                                                                                     |
| `KeyValueList`                                          | Description list; empty values announced as "Not set".                                                                                           |
| `Timestamp`                                             | Relative time that stays current, absolute time in a tooltip and `aria-label`.                                                                   |
| `CopyButton`                                            | Clipboard copy with a live announcement.                                                                                                         |

### Tokens (`src/styles/tokens.css`)

Light is the default. Dark applies from `prefers-color-scheme` unless the user picked light, or when
`<html data-theme="dark">` is set by the theme toggle (stored in `localStorage` as `astra.theme`).

| Group                                                      | Tokens                                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Surfaces                                                   | `--color-bg`, `--color-bg-subtle`, `--color-bg-muted`, `--color-bg-emphasis`, `--color-surface`, `--color-surface-raised`, `--color-overlay`                       |
| Borders                                                    | `--color-border`, `--color-border-subtle`, `--color-border-strong`                                                                                                 |
| Text                                                       | `--color-text`, `--color-text-secondary`, `--color-text-muted`, `--color-text-disabled`, `--color-text-inverse`                                                    |
| Accent (the one brand colour)                              | `--color-accent`, `-hover`, `-active`, `-subtle`, `-subtle-hover`, `-text`, `-fg`; `--color-focus-ring`                                                            |
| Status (`success`, `warning`, `danger`, `info`, `neutral`) | `--color-<status>-text`, `-bg`, `-border`, `-solid`                                                                                                                |
| Type                                                       | `--font-sans` (Inter Variable, self-hosted), `--font-mono`; `--text-xs` 12 to `--text-3xl` 30 (base `--text-md` 14px); `--leading-*`, `--weight-*`, `--tracking-*` |
| Space (4px grid)                                           | `--space-1` 4px, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-8` 32, `-10` 40, `-12` 48, `-16` 64 (plus `-0-5`, `-1-5`)                                           |
| Controls                                                   | `--control-h-sm` 28px, `--control-h-md` 32px, `--control-h-lg` 40px                                                                                                |
| Radius                                                     | `--radius-xs` 3 to `--radius-xl` 12, `--radius-full`                                                                                                               |
| Elevation                                                  | `--shadow-xs`, `-sm`, `-md`, `-lg`                                                                                                                                 |
| Motion                                                     | `--duration-fast/base/slow`, `--ease-standard`, `--ease-out` (zeroed under `prefers-reduced-motion`)                                                               |
| Layering                                                   | `--z-sticky`, `-sidebar`, `-overlay`, `-modal`, `-popover`, `-toast`, `-tooltip`                                                                                   |
| Layout                                                     | `--sidebar-w`, `--sidebar-w-collapsed`, `--topbar-h`, `--content-max-w`                                                                                            |

Rules: component CSS (CSS Modules, `*.module.css`) uses tokens only. Text and background pairs meet
WCAG 2.2 AA in both themes. Colour never carries meaning alone.
