# ADR 0004: Adapters as packs, the ontology store, and golden datasets

Status: accepted (I4, 18 Nov 2026)

## Context

I4 needs a single adapter contract (E05.F1.S1), the reference source and target adapters (E05.F2, E05.F3),
an ontology service with a graph store and a vector index (E06.F1.S1), the core and P&C packs (E06.F2), the first
compliance packs (E07.F2.S1) and a synthetic golden dataset (E22.F1.S1). No real reference estate, SQL Anywhere
engine or target API documentation is available yet.

## Decision

1. **An adapter is a pack; drivers are platform code.** Product knowledge (catalogue queries, entity bindings,
   traps, constraints) is pack content validated against `astra.adapters/v1`. Generic drivers (SQL Server through
   pymssql, SQL Anywhere through sqlanydb, REST/OAuth2) run it. Reference-case names stay in `packs/` and
   `programmes/`; the genericity guard keeps them out of platform code.
2. **Read-only in three layers:** a statement guard, a connection check of the account's permissions, and a
   rolled-back session. Target loads have no database method at all.
3. **Customer data stays in the tenant.** Object names, code, rows, documents and trap hits go to the tenant's own
   database; the control plane keeps run status and counts.
4. **Ontology store in Postgres.** Concepts and typed relations form a property graph walked with recursive
   queries; similarity uses pgvector (HNSW, cosine). The default embedder is lexical feature hashing: deterministic,
   offline and good at labels, synonyms and abbreviations, but not semantic. A model-based embedder can replace it,
   with the embedder name stored per vector. Every answer names the exact pack versions it came from.
5. **Executable rules speak ontology.** Domain rules may carry checks (`order`, `within`, `sum_equals`,
   `not_null`) written against concepts and attributes. Adapter bindings compile them to one read-only query, so
   the same rule runs on any product that binds the concepts.
6. **Golden datasets ship with the adapter** and are built on a local SQL Server (Developer Edition, licence
   accepted by the user on 18 Nov 2026) by an administrator login that exists only in test environments. A pack
   test passes only when a golden run with the exact pack contents passed.
7. **Unknowns stay unknown.** The reference adapters are marked unvalidated; target endpoints and rate limits are
   unset or conservative and labelled; compliance packs do not invent state-specific values; compliance packs are
   not published without a named specialist's review.

## Consequences

- The synthetic estate's table names are invented. The reference source adapter must be re-proven, and its entity
  bindings confirmed, against a real estate before customer use.
- SQL Anywhere support is written but unproven until an engine with SAP's client libraries is available.
- Lexical embeddings can miss matches that share meaning but no wording; the ontology's synonyms carry that load
  until a model-based embedder is added.
