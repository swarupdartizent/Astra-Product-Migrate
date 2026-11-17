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
npm run dev          # http://localhost:5173 (port is fixed: it is the registered OIDC redirect)
```

The dev server proxies `/api` to `http://127.0.0.1:8000`. Set `ASTRA_API_PROXY_TARGET` to change this.
To sign in you need the local Keycloak realm running at `http://localhost:18080/realms/astra` (see
`infra/local`).

| Command             | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `npm run dev`       | Vite dev server on port 5173                                                |
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

| Route                            | Nav permission       | What it does                                                                                                                                      |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                              | any signed-in user   | Greeting, "Get started" links to the screens you can open, your role assignments, platform health                                                 |
| `/tenants`                       | `tenant:read`        | Tenant list; "New tenant" (needs `tenant:create`) builds the database, role and key synchronously                                                 |
| `/tenants/$tenantId?tab=`        | `tenant:read`        | Tabs: overview, security policy, connector secrets, region, danger zone                                                                           |
| `/programmes`                    | `tenant:read`        | Programmes with partners; create programme and add partner need `programme:manage`                                                                |
| `/access`                        | `access:read`        | People search, invite, role grant/revoke, enable/disable (side panel)                                                                             |
| `/audit`                         | `audit:read`         | Filtered, keyset-paginated audit log; detail panel; CSV/JSONL export (`audit:export`); integrity verification (`audit:verify`) and signed anchors |
| `/observability`                 | `observability:read` | Span summary grouped by category, tenant, operation, stage, agent or project; recent traces                                                       |
| `/observability/traces/$traceId` | `observability:read` | Trace waterfall, span attributes, link to Jaeger when the API provides one                                                                        |

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
