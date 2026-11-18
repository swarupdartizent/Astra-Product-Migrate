# ADR 0005: Deterministic discovery and the tenant-side knowledge graph

Status: accepted (I5, 18 Nov 2026)

## Context

Discovery must cover all nine streams (DS-01), find rules in code with their fields (DS-02), measure usage
(DS-03), find hidden interfaces from login records and query logs (E08.F2.S2), read configuration (E08.F2.S3), size
documents (E13.F2.S1), and produce the coverage report the discovery gate needs (E08.F3.S1). The specification's
Astra RE Harness is not available to this platform, and agent features need a model key.

## Decision

1. **Deterministic engines first.** Dictionary, profiler, usage, code reader, interface finder, configuration
   reader and document sizing are deterministic code. The same estate and records give the same graph, so golden
   datasets can score them. Discovery agents (Metadata Harvester, Profiler, Code Reader) will call these engines as
   tools and add reasoning on top; they do not replace them.
2. **Code reading by static analysis.** sqlglot parses statements; rule patterns are explicit and each rule kind has
   a fixed confidence. Dependencies the catalogue cannot see (dynamic SQL) are reported as interface rules, not
   guessed.
3. **Activity from the customer's own audit exports.** The platform defines a small record format (timestamp, login,
   host, program, statement) instead of reading server-wide telemetry, which needs elevated permissions a read-only
   account should not have. Missing or short evidence shows as a gap, never as "no interfaces".
4. **Use flows through code.** An element is unused only if nothing reads, writes or executes it directly and no used
   view, procedure or fired trigger depends on it. Unused elements are flagged for retirement review, never retired.
5. **The graph lives in the tenant database**, per discovery run: nodes carry stream, element, usage, ontology concept
   (from the adapter's bindings) and a candidate target element (same-name match against the pinned baseline, until
   the version delta engine in I6); edges carry the dependency type.
6. **The gate is evidence.** The discovery stage gate opens only with an accepted coverage report whose blocking gaps
   are waived by a person with a reason. Agents cannot accept reports (database trigger).

## Consequences

- Rules hidden in dynamic SQL or outside the database (client code, scripts) need the Code Reader agent or the RE
  Harness later; the current reader reports what it cannot see.
- Interfaces that do not appear in the imported records and leave no trace in code or configuration are missed;
  the coverage report states how many days of evidence it had.
- Process mining (DS-04) and agentification candidates are not started; the coverage report shows them as gaps.
