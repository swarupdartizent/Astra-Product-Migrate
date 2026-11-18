# ADR 0009: A design register from evidence, and generated code gated by its own tests

Status: accepted (I9, 18 Nov 2026)

## Context

I9 covers design and build (E12): mapping proposals, configuration translation, forms, code modernisation,
integration and report rebuilds, page drafts and security profiles, and data transformation code. No model key is
available, and the reference target's design facts (mechanisms, naming rules, page builder) are reported, not
confirmed in writing.

## Decision

1. **One register, many streams.** Every proposal is an item in a tenant-side register with its source, target,
   evidence, confidence, flags and decision. A new design run keeps decisions on unchanged sources. Customer element
   names stay in the tenant.
2. **The target adapter states what design needs.** An optional `design` section records mechanisms, retirements,
   naming, configuration areas, forms and the page builder, each with its source and confidence. Missing parts block
   their streams with the reason instead of being guessed.
3. **Deterministic proposals with explained confidence.** Mapping confidence is a documented formula over name,
   type, table match and precedents. Low-confidence items go to the review queue, and the queue's decision updates
   the register, so there is one decision path per item.
4. **Readiness rules per stream.** Forms need parity, integrations need an end-to-end test, security profiles need a
   decision for every new object, customer tables need a key. Two-person rules from compliance packs apply to
   register approvals too.
5. **Code is generated, versioned and tested; only approved versions run.** Build artifacts are versioned by digest.
   Tests run on SQL Server in rolled-back transactions, seeded with real extract rows where available. The database
   refuses approval unless that version's tests passed, refuses digest changes and refuses agent approvers.
6. **No silent data loss in transformations.** Same-type columns are not cast, so truncation and overflow fail the
   tests; value checks compare in the right domain.

## Consequences

Design is reproducible and explainable item by item, and nothing runs untested. The reference case shows its design
streams as blocked until the reference target adapter records a design section. Page drafts are entity-based until
an adapter supplies legacy screen layouts. Report and form parity complete with validation (I10).
