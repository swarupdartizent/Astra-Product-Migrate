"""Control matrix (E11.F3.S1): every control of the blueprint's compliance packs, with the task that operates it,
the plan tasks it governs and the lifecycle gates where it applies."""

from __future__ import annotations

from typing import Any

from astra_migrate.packs.schema import PLACEMENT, ControlType, Manifest

OWNER = {ControlType.APPROVAL: "migration_lead", ControlType.GATE: "migration_lead",
         ControlType.EVIDENCE: "test_engineer", ControlType.DATA_HANDLING: "customer_it_security_lead",
         ControlType.RESIDENCY: "customer_it_security_lead", ControlType.RETENTION: "customer_data_owner"}
# What an approval control's `applies_to` governs in the plan.
APPLIES = {"mapping": {"data"}, "transformation": {"data"}, "conversion_script": {"customizations"},
           "configuration": {"configuration"}, "integration": {"integrations"}, "report": {"reports"},
           "security": {"users_security"}}
DEFAULT_GATES = {ControlType.DATA_HANDLING: ["build_rehearse", "cutover"], ControlType.EVIDENCE: ["cutover"],
                 ControlType.RESIDENCY: ["configure"], ControlType.RETENTION: ["decommission"],
                 ControlType.APPROVAL: ["design", "build_rehearse"]}


def governed(control_type: ControlType, params: dict[str, Any], tasks: dict[str, dict[str, Any]]) -> list[str]:
    if control_type == ControlType.APPROVAL:
        streams: set[str] = set()
        for a in params.get("applies_to") or []:
            streams |= APPLIES.get(str(a), set())
        return sorted(k for k, t in tasks.items() if t["stream"] in streams and not k.startswith("control:"))
    if control_type == ControlType.DATA_HANDLING:
        return sorted(k for k, t in tasks.items() if t["stream"] == "data" and not k.startswith("control:"))
    if control_type == ControlType.RETENTION:
        return sorted(k for k, t in tasks.items() if t.get("disposition") in ("archive", "retire"))
    return []


def matrix(packs: list[Manifest], tasks: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    rows = []
    for m in sorted(packs, key=lambda p: p.name):
        for c in m.adds.controls:
            gov = governed(c.type, c.parameters, tasks or {})
            rows.append({"control": c.id, "pack": m.ref, "type": c.type.value, "title": c.title, "rule": c.rule,
                         "evidence_required": c.evidence_required, "placement": PLACEMENT[c.type],
                         "gates": [c.gate] if c.gate else DEFAULT_GATES.get(c.type, []),
                         "role": OWNER[c.type], "control_task": f"control:{c.id}|operate|1",
                         "tasks": gov[:200], "task_count": len(gov),
                         "compliance_critical": c.compliance_critical, "two_person_approval": c.two_person_approval,
                         "sources": [s.reference for s in c.sources]})
    return rows
