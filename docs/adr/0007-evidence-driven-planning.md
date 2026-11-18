# ADR 0007: Evidence-driven planning with pack estimation rules and a constraint solver

Status: accepted (I7, 18 Nov 2026)

## Context

I7 covers scope decisions with evidence, a dependency graph, 40-hour tasks, ranged estimates, a control matrix,
constraint-checked waves, risks, cutover comparison and runbooks, baselines, Jira and Azure DevOps exports, pre-sales
estimates, coexistence rules and gap routing (E11, E15.F1, E19). No model key is available, and no delivered project
exists yet to measure effort from.

## Decision

1. **Proposals from rules, decisions by people.** Dispositions are proposed by fixed rules over discovery and delta
   evidence, and every proposal carries that evidence. The Scope Analyst agent, when a model key exists, will add
   reasoning on top through the same register. Agentification is never proposed automatically.
2. **Estimation rules live in packs.** Pattern packs carry ranges, units and activities. The shipped generic pack
   states its basis and is marked uncalibrated. Actual effort calibrates a rule once there are three past tasks,
   and the evidence names them. No estimate is presented as measured when it is not.
3. **The plan is a set of keyed items in the tenant database.** One generic table holds scope, edges, tasks, waves,
   pins, risks, cutover choice, runbook steps and coexistence rules. This keeps customer element names in the
   tenant and lets baselines snapshot and diff the whole plan without a schema per kind.
4. **CP-SAT for waves, with soft capacity.** Dependencies are hard constraints. Capacity overflow and broken pins are
   measured through slack variables, so the solver always returns an assignment of all work together with the list
   of what does not fit. Options are derived from the slack, and nothing is dropped. OR-Tools 9.12 is pinned
   because later releases need protobuf 6, which conflicts with the telemetry exporter.
5. **Cutover figures come from inputs, not opinion.** Durations come from row counts and the target's recorded load
   rate, and the other inputs are stated assumptions the user can change. Risk is a small documented score from
   explained factors.
6. **Approval is separated from proposal.** The proposer of a baseline cannot approve it, agents cannot decide
   (database trigger), and phased plans need coexistence rules before approval.
7. **Gaps live in the control plane** because vendor product changes are ranked across a programme's tenants. The
   rule that a gap cannot close without a route and an owner is also a database constraint.

## Consequences

Plans are reproducible from their inputs and explainable item by item. Estimates are only as good as the pattern
pack until actuals arrive. Live two-way sync with Jira and Azure DevOps APIs (rather than CSV) needs credentials
and is deferred.
