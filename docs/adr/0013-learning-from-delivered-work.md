# ADR 0013: Learning from delivered work, with every change kept and nothing contracted rewritten

Status: accepted (I14, 20 Nov 2026)

## Context

I14 is the first R2 increment. It closes four loops that turn delivered work into better numbers: bulk approval of
repeated review questions (E16.F1.S5), confidence calibration per agent (E22.F1.S3), estimates that learn from
actual effort (E21.F3.S2), and Complexity Index weights recalibrated after each wave (E18.F2.S3). None of them needs
a model; they use reviewer decisions, imported actual hours and light-scan measures.

## Decision

1. **Bulk approval is many single approvals under one reason.** A reviewer approves the open items that share an
   evidence pattern (pattern key). Each item gets its own approval row and audit event, linked to one batch record.
   It is all or nothing. Compliance-critical items are never included, and the database refuses a bulk approval of
   one. Two-person items get the reviewer's approval and still wait for a second person.
2. **Calibration needs the suggested option.** Confidence only means something against what was suggested, so agents
   now give `suggested_option` with any confidence, and design proposals record theirs. An item is right when the
   reviewer approved exactly the suggestion. Dismissed items do not score. Items without a recorded suggestion are
   counted as unscored, never guessed.
3. **Calibration does not compound.** Imported actuals keep the rule's uncalibrated estimate, the factor applied and
   the planned range. Factors compare actuals with the uncalibrated estimate. Tasks a person overrode are left out.
   The error report per wave uses what the team was shown.
4. **Index weights are versioned and contracted bands are fixed.** Every set of weights is a numbered, dated,
   append-only version. The starting assumptions are recorded before the first change. Recalibration fits actual
   hours to the normalised measures (non-negative least squares with an intercept), then blends the result with the
   current weights by n ÷ (n + 10). A customer's band can be contracted once; it never changes, and contracts are
   append-only. Bands of uncontracted customers follow the current weights.

## Consequences

Reviewers clear repeated questions quickly without weakening compliance controls. Review thresholds and confidence
can be set on measured evidence once enough items are decided (20 per source). Estimates and the index become
evidence-based as delivered work flows back. A small fleet moves the weights only a little. Recalibration is
explained by its stored basis: which waves, how many customers, the fit before and after, and the band changes.
