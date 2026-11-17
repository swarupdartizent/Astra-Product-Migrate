# ADR 0001: Tenant isolation model

Status: accepted (17 Nov 2026) · Stories: E01.F1.S1, E01.F1.S2

## Context
Each customer estate must be isolated in storage, compute and keys, and no query may read across tenants
(spec NFR Tenancy). Partners in one programme must never see each other's customers (IB-04).

## Decision
- **Database per tenant** on the regional database server chosen at creation, owned by a **login role per tenant**
  that has `CONNECT` only on its own database. `PUBLIC` has no access to any tenant database or to the control plane.
  Isolation is enforced by the database, not by application filters.
- **Key per tenant**: a non-exportable AES-256-GCM key in the key service (OpenBao transit locally, Azure Key Vault
  later). Ciphertexts are bound to the tenant id as context. Deleting a tenant destroys its key (crypto-shred).
- **Control plane** holds only platform metadata (tenants, identities, grants, secret references, audit, traces).
- **Region is fixed at creation.** A database trigger rejects any change to `tenants.region_code` unless a
  `region_migrations` task for that exact move is running. The move copies every table, checks row counts, then
  removes the old storage.
- **Compute**: locally, tenant work runs in shared processes that hold only that tenant's credentials per job.
  In Azure, tenant jobs run as separate Container Apps jobs with per-tenant managed identities (to be built with
  the job runner).
- Tenants outside a user's scope return **404**, so their existence is not disclosed.

## Consequences
- Strong, testable isolation (see `platform/tests/test_tenancy.py`), at the cost of one database per tenant.
  At about 50 customers per programme this is well within one server per region.
- Schema changes to tenant databases run per tenant through the tenant schema runner.
