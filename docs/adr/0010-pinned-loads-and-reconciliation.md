# ADR 0010: Pinned, repeatable loads with validation and reconciliation to the cent

Status: accepted (I10, 18 Nov 2026)

## Context

I10 covers load runs, the error queue, segment and delta loads, document checks, validation, reconciliation, data
quality, parity and coexistence reconciliation (E13, E14, E15.F1.S2). The reference target's load endpoints are not
documented yet, so real loads to it are blocked.

## Decision

1. **A load run pins everything that decides its result:** the approved code's artifact ids and digests, the pack
   versions, the extract run and the segment. The database refuses unapproved code and any change to the pinned
   inputs. Result digests prove that a rerun gave the same result.
2. **Rehearsals are first-class.** They run the same transformation, validation and reconciliation without sending
   anything, so a project whose target loads are blocked still proves its data.
3. **Transformation runs on SQL Server in a rolled-back transaction.** The approved procedure runs on staged rows,
   and the target-shaped rows are read back. Nothing is persisted outside the tenant database.
4. **Validation reuses the packs' executable rules.** Concepts are translated to target columns through the source
   adapter's bindings and the approved mappings, so domain rules apply after transformation without new code.
5. **Every record is kept with its outcome.** The record table is the error queue. Fixes are stored next to the
   original, and reloads send only the chosen records as a new numbered run.
6. **Reconciliation is three-way and to the cent.** Source, transformed and accepted are compared for counts and
   every measured amount. Each difference is a break with an owner, and a break cannot close without one (in the
   database).
7. **Parity compares results, not engines.** Re-rating, report, workflow and period-close results are compared as
   files from both systems, because neither engine can be driven generically. Approvals are recorded per difference.
8. **Coexistence reconciliation is scheduled in the API process** by a small scheduler that enqueues due jobs, so
   one database row turns it on and off.

## Consequences

Loads are repeatable and auditable, and nothing is sent that failed a blocking rule. For the reference case, loads
stay rehearsals until the target documents its endpoints. The target side of coexistence and document checks is
what the target accepted or returns; a direct read of the target's data needs its read API.
