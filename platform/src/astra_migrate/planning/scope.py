"""Scope register (E11.F1.S1): what happens to every legacy element, with the evidence, decided by people.

Every element of the newest discovery (its knowledge graph) gets a proposed disposition from deterministic rules
over the evidence discovery and the version delta produced. Proposals are never decisions: each needs a person
to approve it, change it or reject it. `agentify` is never proposed automatically; it needs an agentification
assessment, so only a person can choose it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from astra_migrate.planning.estimation import DISPOSITIONS

NOT_ELEMENTS = {"column", "rule", "code_list"}
STATUSES = ("proposed", "approved")


@dataclass
class Element:
    key: str           # knowledge graph node id
    kind: str
    stream: str
    element: str
    concept: str | None
    usage: dict[str, Any]
    props: dict[str, Any]


def segment_of(e: Element) -> str:
    """Segments group work for roll-ups: the business concept's family, else the element's schema."""
    if e.concept:
        return e.concept.split(".")[0] if "." in e.concept else e.concept
    if "." in e.element and e.kind in ("table", "view", "procedure", "function", "trigger", "user_defined_table"):
        return e.element.split(".", 1)[0]
    return e.stream


def propose(e: Element, delta: dict[str, Any] | None, delta_scope: bool, window_days: int | None
            ) -> tuple[str, list[str]]:
    """The proposed disposition and the evidence for it."""
    ev: list[str] = []
    u = e.usage or {}
    if u.get("unused"):
        ev.append(f"No direct or indirect use in the {window_days or 'measured'}-day activity window "
                  f"(reads {u.get('reads', 0)}, writes {u.get('writes', 0)}, executions {u.get('executions', 0)}).")
        return "retire", ev
    if e.kind == "interface":
        ev.append(f"Interface found in activity records ({e.props.get('kind', 'program')}); the target is reached "
                  "through its own APIs, so the integration is rebuilt.")
        return "rebuild", ev
    if e.kind == "platform":
        ev.append("The source platform is replaced by the target's hosting.")
        return "replace_with_standard", ev
    if e.kind == "view" or e.stream == "reports":
        ev.append("Reports and views are rebuilt on the target's reporting.")
        return "rebuild", ev
    if delta is not None:
        group, origin = delta["group"], delta["origin"]
        ev.append(f"Version delta: {group.replace('_', ' ')}"
                  + (f" as {delta['target']}" if delta.get("target") and delta["target"] != delta["source"] else "")
                  + f"; origin {origin.replace('_', ' ')}.")
        if group in ("unchanged", "renamed_or_moved"):
            return "migrate", ev
        if group == "changed_behaviour":
            ev.append("The target's version differs; mapping needs design work.")
            return "migrate", ev
        # removed in target
        if u.get("reads") and not u.get("writes"):
            ev.append(f"Read {u.get('reads')} time(s) but never written in the window: historical data.")
            return "archive", ev
        if origin in ("customer_specific", "customized_standard"):
            ev.append("A customer extension with no counterpart in the target: rebuilt as a target extension.")
            return "rebuild", ev
        if origin == "standard":
            ev.append("A product element the target no longer has: replaced by the target's standard way.")
            return "replace_with_standard", ev
        ev.append("Origin unknown (no standard baseline): rebuilt to keep its function. If it is a product element "
                  "the target dropped, replace it with the target's standard way instead.")
        return "rebuild", ev
    if delta_scope:
        ev.append("The target baseline does not describe elements of this kind; customer code is rebuilt on "
                  "the target.")
        return "rebuild", ev
    if e.kind in ("configuration", "validation_rule", "workflow", "security_profile"):
        ev.append("Configuration is translated to the target's configuration.")
        return "migrate", ev
    if e.kind == "document_store":
        ev.append(f"{e.props.get('documents', '?')} embedded documents move with their records.")
        return "migrate", ev
    ev.append("No version delta covers this element yet; migrate until the delta says otherwise.")
    return "migrate", ev


def build(nodes: list[Element], delta_rows: list[dict[str, Any]], not_in_scope: list[str], window_days: int | None,
          existing: dict[str, dict[str, Any]], run_ids: dict[str, str | None]) -> dict[str, dict[str, Any]]:
    """Scope items keyed by element node id. Decisions people already made are kept; only the proposal and
    evidence of undecided items change."""
    by_source = {str(d["source"]).lower(): d for d in delta_rows}
    nis = {x.split(":", 1)[1].lower() for x in not_in_scope if ":" in x}
    out: dict[str, dict[str, Any]] = {}
    for e in nodes:
        if e.kind in NOT_ELEMENTS:
            continue
        d = by_source.get(e.element.lower())
        disp, ev = propose(e, d, e.element.lower() in nis, window_days)
        assert disp in DISPOSITIONS
        old = existing.get(e.key)
        item = {"element": e.element, "kind": e.kind, "stream": e.stream, "concept": e.concept,
                "segment": segment_of(e), "props": {k: e.props.get(k) for k in ("rows", "columns", "documents")
                                                    if e.props.get(k) is not None},
                "proposed": disp, "evidence": ev, "delta": d, "sources": run_ids,
                "status": "proposed", "disposition": None, "decision": None}
        if old and old.get("status") == "approved":
            item.update(status=old["status"], disposition=old.get("disposition"), decision=old.get("decision"))
            if old.get("proposed") != disp:
                item["evidence"] = [*ev, f"The proposal changed from {old.get('proposed')} since the decision; "
                                         "review the decision."]
        out[e.key] = item
    return out


def effective(item: dict[str, Any]) -> str:
    """The disposition planning uses: the approved one, else the proposal (shown as unapproved)."""
    return str(item.get("disposition") or item["proposed"])
