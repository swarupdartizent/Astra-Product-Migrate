# ADR 0003: Agent runtime, model gateway and hard guardrails

Status: accepted (I3, 18 Nov 2026)

## Context

Agents propose and people decide (specification, "Agents"). The backlog asks for agents with registered
tools and test suites (E02.F1.S1), a model-neutral gateway (E02.F1.S2), an Orchestrator that sees status
but not business data (E02.F1.S3), legacy text treated as data (E02.F2.S1), hard rules outside the model
(E02.F2.S2) and governance records (E02.F3.S1). A prompt is not a control: anything that must never
happen has to be impossible in code or in the database.

## Decision

1. **Own tool loop, not a hosted agent service.** The runtime runs the tool-use loop itself through the
   gateway. Every tool call passes through `dispatch`, which refuses tools outside the registered list,
   validates input with the tool's pydantic model and audits the call. Hosted agent services would put
   the loop, and so the enforcement point, outside the platform.
2. **A closed tool catalogue with effects.** Tools are platform code. Each has an effect
   (`read_metadata`, `read_business_data`, `request_decision`, `update_stage`, `assign_task`). Effects
   that write to a target, approve, publish, release or skip a gate do not exist. A manifest that names
   a tool outside the catalogue is refused; a `metadata_only` agent cannot hold a business-data tool.
3. **Agents have identities, and the database refuses them as deciders.** Each agent is a `users` row
   of kind `agent`. A trigger on every "who decided" column (approvals, decisions, review resolution,
   releases, pins, role grants, alias changes) rejects agent identities. A user's kind cannot change.
4. **Gates are code.** Stage moves, from people or agents, go through `stages.check`. The planning gate
   reuses the blueprint gate from I2.
5. **Data, never instructions.** Legacy text reaches a model only through `wrap_untrusted` (escaped,
   labelled, invisible characters made visible) under a fixed data policy at the top of every system
   prompt. A deterministic screen flags instruction-like text into the review queue. The screen is the
   early warning; the tool list and gates are the wall.
6. **Aliases, not models, in agents.** A manifest names an alias. The gateway maps aliases to a provider
   and model, refuses providers without a credential, without recorded no-training terms or outside the
   tenant's region, and records every call (served model, API version, tokens, cost, latency) in an
   append-only table. Drivers: Anthropic API (default; refusal fallbacks enabled on models that support
   them), Claude on Microsoft Foundry and Azure OpenAI.
7. **Release only on a passing suite.** A version is released only when the latest suite run against
   its exact manifest digest passed. Model cases that cannot run (no provider) are *blocked*, and a
   blocked suite cannot release. Released versions are immutable; projects pin versions.
8. **Content in the tenant, metadata in the control plane.** Run objectives, transcripts, outputs and
   flagged text live in the tenant's database. The control plane keeps status, counts and cost.
9. **Durable jobs.** Agent runs, test suites, tenant provisioning and region moves run on a Postgres job
   queue (`FOR UPDATE SKIP LOCKED`, NOTIFY wake-up, heartbeats, stale-job recovery).

## Consequences

- The Orchestrator cannot be released until a real model provider is configured, which is intended.
- Adding an agent capability means adding a catalogue tool (code review) and an agent version (suite),
  never only a prompt.
- Test suites call real models and cost money; cost is recorded per test run.
