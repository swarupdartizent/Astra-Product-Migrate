# ADR 0008: Review workbench with pack-driven compliance and database-enforced approvals

Status: accepted (I8, 18 Nov 2026)

## Context

I8 covers the review workbench (E16.F1.S1–S4), the planning workbench (E16.F2.S1) and precedents (E21.F1.S1).
Compliance packs already declare approval controls with `applies_to`, `compliance_critical` and
`two_person_approval`, but review items did not know which controls governed them. No model key is available.

## Decision

1. **Review items carry their own priority inputs.** Risk, confidence, stream, segment, subject type, evidence links
   and a pattern key are recorded when the item is raised, by the rule or agent that raises it. Priority is a
   documented formula over those fields, and each item explains its score.
2. **Compliance impact comes from packs at creation time.** The approval controls of the project's compliance packs
   are matched on the item's subject type, so adding a pack changes which items need named and second reviewers
   without code changes. The controls are stored on the item for audit.
3. **Approvals are rows, and the rules are database triggers.** Each approval is a row per person. Triggers refuse
   an approved outcome without enough distinct approvals, a decision on a critical item without a named reviewer,
   an approval by the requester and an approval by an agent identity. The API checks the same rules first to give
   clear messages.
4. **"Change" goes back to the requester.** For agent items a follow-up run of the same agent starts with the note
   (or the reason it could not start is recorded). For rule-raised items there is no one to send it to, so the
   reviewer's changed answer is the decision.
5. **Precedents are matched by pattern key within the tenant.** Keys strip names, quoted values and numbers, so items
   about different objects with the same reasons match. Precedents never cross tenants.
6. **The Review Assistant is an ordinary governed agent** with two metadata-read tools, no deciding tool and no
   delegation. A deterministic explanation from the recorded evidence is always shown, so reviewers are never
   blocked on a model.
7. **Plan edits are batched and always followed by a solve.** Moves, dependency changes and task changes are applied
   in one tenant transaction, then the CP-SAT solver runs, so the person sees the constraints the edit breaks.

## Consequences

Review order and compliance handling are explainable and auditable. The quality of the order depends on requesters
stating risk honestly; rules use fixed values per item type. Bulk approval (E16.F1.S5) can be added on top of the
pattern key, and must exclude compliance-critical items.
