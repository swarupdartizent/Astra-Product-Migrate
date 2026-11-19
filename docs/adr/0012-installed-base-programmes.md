# ADR 0012: Installed-base programmes with partner isolation, consented light scans and a documented index

Status: accepted (I12, 19 Nov 2026)

## Context

I12 covers installed-base programmes (E18): set-up, a consented fleet scan, the Migration Complexity Index, the
portfolio planner, the programme owner's view and commercial metering. Programmes, partners and partner-scoped
roles already existed (I1).

## Decision

1. **One access rule for every programme read.** A programme or platform grant sees every customer; a partner grant
   sees only that partner's customers. Planner results are filtered the same way.
2. **Programme views hold aggregates only.** Scans keep numbers, and dashboards read counts from each customer's
   database, so nothing that names a customer's elements crosses tenants.
3. **Consent is a database rule.** A scan needs an active consent for that customer; consents are never edited, and
   revoked ones stay revoked.
4. **The index is a documented weighted sum** with programme-adjustable weights, ranges and band limits. Each score
   shows its measures and contributions.
5. **The portfolio is planned with CP-SAT** on bands (weeks needed), wave lengths and pod capacity. Customers that do
   not fit are reported with the reason, never silently dropped.
6. **Metering reads evidence that already exists:** gate passes and their approvers, imported actual effort, and
   scan bands. The gate evidence exports as CSV for invoicing.

## Consequences

Sizing and pricing follow measured complexity before contracts, and partners stay isolated. The default index
weights and ranges are starting assumptions until delivered customers calibrate them. Billing systems receive gate
evidence as CSV; a live integration needs the billing system's API.
