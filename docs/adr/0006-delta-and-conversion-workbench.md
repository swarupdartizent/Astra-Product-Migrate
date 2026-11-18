# ADR 0006: Deterministic version delta and a rolled-back conversion workbench

Status: accepted (I6, 18 Nov 2026)

## Context

The version delta must sort every object into four groups, give the same result for the same inputs and be
exportable (E09.F1.S1); it must tell customization from standard (E09.F1.S2). Converted code must compile on SQL
Server or go to review with a reason (E10.F1.S1), and recorded cases must be replayed with differences listed
(E10.F1.S2). No SQL Anywhere engine is available locally, and no real target baseline exists yet.

## Decision

1. **The delta is deterministic code, not a model.** Matching is by type and name, then schema (moved), then column
   overlap (Jaccard of at least 0.8) or code body hash (renamed). Inputs are sorted and digested. Object types the
   baseline does not describe are `not_in_scope`, never forced into a group.
2. **Origin needs evidence.** With the source product's standard baseline, origin is exact. Without it, only what the
   adapter declares (`customization: true`) is customer-specific; the rest is `unknown`. Source adapters may
   therefore register baselines too, but projects can pin only target baselines.
3. **Conversion is rule-based and says what it did.** Every rewrite is named. Constructs without a safe equivalent go
   to review. A converted object counts only once it compiles.
4. **The workbench is a separate SQL Server, and nothing persists.** Each compile and each test case runs in one
   transaction that is rolled back: tables from the pinned baseline plus the source's own tables, the object, the
   case's rows, the call. Unresolved references are reported because SQL Server defers name resolution.
5. **Recorded cases are supplied, not generated.** The platform never executes customer code on the source (its
   account is read-only). Cases come from the customer's recordings, with the rows the code needs.
6. **Pattern advice is evidence for a person.** A disagreement with the blueprint becomes a review proposal.

## Consequences

SQL Anywhere conversion is proven with synthetic Watcom-SQL objects compiled and tested on real SQL Server; reading
code from a live SQL Anywhere estate waits for an engine. The 60% same-family threshold is a starting point to tune
against real estates.
