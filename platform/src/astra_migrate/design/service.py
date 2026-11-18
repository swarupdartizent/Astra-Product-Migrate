"""Decisions on design items, and what each stream needs before an item can be approved.

- Only a holder of the stream's owner role decides (data SME for mappings, solution architect otherwise, the
  customer's IT security lead for security profiles).
- Items in the review queue are decided there; items that are blocked cannot be approved.
- A mapping can be approved with its proposed target, with a changed target that exists in the target baseline,
  or as "no target".
- A form needs a passing parity check; an integration (other than a retirement) needs an end-to-end test
  definition; a security profile needs an access decision for every new object; a customer table needs its key.
- Where the project's compliance packs require two people for a stream's subject, approval needs two different
  people: the first approval is recorded and the item is approved by the second.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

import psycopg
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.db.models import ReviewItem, Tenant
from astra_migrate.design import register
from astra_migrate.design.streams import ACCESS
from astra_migrate.review import service as reviews
from astra_migrate.security.rbac import ROLES, P

OWNERS = {"mapping": "data_sme", "configuration": "solution_architect", "form": "solution_architect",
          "code": "solution_architect", "integration": "solution_architect", "report": "solution_architect",
          "page": "solution_architect", "security": "customer_it_security_lead"}
SUBJECT = {"mapping": "mapping", "configuration": "configuration", "form": "form", "code": "conversion_script",
           "integration": "integration", "report": "report", "page": "page", "security": "security"}
TESTABLE = re.compile(r"^/[A-Za-z0-9_\-/{}.?=&%]*$")


class DesignError(Exception):
    def __init__(self, status: int, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.status, self.field = status, field


def can_decide(principal: Any, t: Tenant, project_id: uuid.UUID, stream: str) -> tuple[bool, str]:
    if not principal.has_on_project(P.REVIEW_RESOLVE, t, project_id):
        return False, "You cannot decide design items on this project."
    role = OWNERS[stream]
    if role not in principal.roles_on_project(t, project_id):
        return False, f"{stream.capitalize()} items are decided by the {ROLES[role].label} role."
    return True, ""


def readiness(item: dict[str, Any]) -> str | None:
    """Why the item cannot be approved yet, or None."""
    st = item["stream"]
    tgt = item.get("target") or {}
    if item["status"] == "blocked":
        return "The item is blocked: " + "; ".join(item.get("flags") or item.get("evidence") or [])
    if item["status"] == "in_review":
        return "The item is in the review queue; decide it there."
    if st == "form" and not (item.get("parity") or {}).get("passed"):
        return "The converted form has not passed parity against its golden copy."
    if st == "integration" and not tgt.get("retire") and not item.get("tests"):
        return "Define the interface's end-to-end test first."
    if st == "security" and item.get("missing"):
        return f"{len(item['missing'])} new object(s) have no access decision for this profile."
    if st == "code" and item["source"].get("type") == "user_defined_table" and not item.get("key_columns"):
        return "Declare the table's key first."
    return None


def _baseline_has(baseline: dict[str, Any], table: str, column: str) -> dict[str, Any] | None:
    for o in baseline.get("objects", []):
        if o.get("type") == "table" and f"{o.get('schema') or 'dbo'}.{o['name']}".lower() == table.lower():
            return next(({"table": f"{o.get('schema') or 'dbo'}.{o['name']}", "column": c["name"],
                          "type": c.get("type"), "nullable": c.get("nullable")}
                         for c in o.get("columns") or [] if str(c["name"]).lower() == column.lower()), None)
    return None


def parse_target(value: str, baseline: dict[str, Any]) -> dict[str, Any]:
    parts = [p.strip("[] ") for p in value.strip().split(".")]
    if len(parts) == 2:
        parts = ["dbo", *parts]
    if len(parts) != 3 or not all(parts):
        raise DesignError(422, "Give the target as schema.table.column.", "target")
    hit = _baseline_has(baseline, f"{parts[0]}.{parts[1]}", parts[2])
    if hit is None:
        raise DesignError(422, f"{'.'.join(parts)} is not a column of the pinned target baseline.", "target")
    return hit


def decide(s: Session, tc: psycopg.Connection[Any], principal: Any, t: Tenant, project_id: uuid.UUID, stream: str,
           keys: list[str], action: str, reason: str, who: dict[str, str], baseline: dict[str, Any],
           target: str | None = None, no_target: bool = False) -> dict[str, Any]:
    ok, why = can_decide(principal, t, project_id, stream)
    if not ok:
        raise DesignError(403, why)
    if action in ("reject", "change") and len(reason.strip()) < 10:
        raise DesignError(422, "Give a reason (at least 10 characters).", "reason")
    if action == "change" and (stream != "mapping" or len(keys) != 1):
        raise DesignError(422, "A changed target is given for one mapping at a time.", "keys")
    comp = reviews.compliance_for(s, project_id, SUBJECT[stream])
    done: list[str] = []
    pending: list[str] = []
    refused: list[dict[str, str]] = []
    with tc.transaction():
        for key in keys:
            it = register.get(tc, project_id, stream, key)
            if it is None:
                refused.append({"key": key, "reason": "No such item."})
                continue
            if it["status"] in register.DECIDED:
                refused.append({"key": key, "reason": f"Already {it['status']}."})
                continue
            if it["status"] == "in_review":
                refused.append({"key": key, "reason": "The item is in the review queue; decide it there."})
                continue
            if action == "reject":
                register.update(tc, project_id, stream, key, "rejected",
                                {"decision": register.decision(who, "reject", reason.strip())}, who["by"])
                done.append(key)
                continue
            changes: dict[str, Any] = {}
            if action == "change":
                changes["target"] = parse_target(target or "", baseline)
            elif stream == "mapping" and no_target:
                changes["target"] = None
            elif stream == "mapping" and not it.get("target"):
                refused.append({"key": key, "reason": "No proposed target: change it to a target column or approve "
                                                      "it as not migrated."})
                continue
            blocker = readiness({**it, **changes})
            if blocker:
                refused.append({"key": key, "reason": blocker})
                continue
            approvals = list(it.get("approvals") or [])
            if any(a.get("by_id") == who["by_id"] for a in approvals):
                refused.append({"key": key, "reason": "You approved it already; a second person must approve it."})
                continue
            approvals.append({**who, "action": action, "no_target": no_target})
            if len(approvals) < comp.required_approvals:
                register.update(tc, project_id, stream, key, None, {"approvals": approvals, **changes}, who["by"])
                pending.append(key)
                continue
            register.update(tc, project_id, stream, key, "approved", {
                "approvals": approvals, **changes,
                "decision": register.decision(who, "approve" if action != "change" else "change", reason.strip(),
                                              no_target=no_target, controls=list(comp.controls))}, who["by"])
            done.append(key)
    audit.record(s, principal.actor, f"design.{action}", tenant_id=t.id, project_id=project_id,
                 target_type="project", target_id=str(project_id),
                 details={"stream": stream, "decided": done, "first_approvals": pending, "refused": refused,
                          "reason": reason.strip(), "target": target, "no_target": no_target,
                          "controls": list(comp.controls)})
    return {"decided": done, "awaiting_second_approval": pending, "refused": refused,
            "required_approvals": comp.required_approvals}


def set_security(tc: psycopg.Connection[Any], project_id: uuid.UUID, key: str, entries: dict[str, str],
                 by: str) -> dict[str, Any]:
    it = register.get(tc, project_id, "security", key)
    if it is None:
        raise DesignError(404, "No such security profile item.")
    if it["status"] in register.DECIDED:
        raise DesignError(409, f"The profile is {it['status']}; a new design run reopens it if objects change.")
    known = dict(it.get("entries") or {})
    for obj, access in entries.items():
        if obj not in known:
            raise DesignError(422, f"{obj} is not one of the new objects.", "entries")
        if access not in ACCESS:
            raise DesignError(422, f"Access must be one of {', '.join(ACCESS)}.", "entries")
        known[obj] = access
    missing = [o for o, a in known.items() if a is None]
    return register.update(tc, project_id, "security", key, None, {
        "entries": known, "missing": missing,
        "flags": [f"{len(missing)} object(s) have no access decision"] if missing else []}, by)


def set_key(tc: psycopg.Connection[Any], project_id: uuid.UUID, key: str, columns: list[str], by: str
            ) -> dict[str, Any]:
    it = register.get(tc, project_id, "code", key)
    if it is None or it["source"].get("type") != "user_defined_table":
        raise DesignError(404, "No such customer table.")
    names = {c["name"].lower(): c["name"] for c in it["source"].get("columns") or []}
    bad = [c for c in columns if c.lower() not in names]
    if bad or not columns:
        raise DesignError(422, f"Not columns of the table: {', '.join(bad)}" if bad else "Name at least one column.",
                          "columns")
    return register.update(tc, project_id, "code", key, None, {"key_columns": [names[c.lower()] for c in columns]},
                           by)


def set_test(tc: psycopg.Connection[Any], project_id: uuid.UUID, key: str, steps: list[dict[str, Any]], by: str
             ) -> dict[str, Any]:
    it = register.get(tc, project_id, "integration", key)
    if it is None:
        raise DesignError(404, "No such interface.")
    for i, st in enumerate(steps):
        if not TESTABLE.match(str(st.get("path", ""))):
            raise DesignError(422, "A path starts with / and holds no host.", f"steps.{i}.path")
    flags = [f for f in it.get("flags") or [] if f != "needs an end-to-end test definition"]
    return register.update(tc, project_id, "integration", key, None, {"tests": steps, "flags": flags}, by)


def on_review(s: Session, t: Tenant, r: ReviewItem) -> None:
    """A review-queue decision on a design item updates the register."""
    ref = (r.context or {}).get("design") or {}
    stream, key = ref.get("stream"), ref.get("key")
    if not stream or not key or r.status == "open":
        return
    from astra_migrate.design.jobs import target_of

    b, _ = target_of(s, r.project_id)
    who = {"by": "review queue", "by_id": str(r.resolved_by), "review_item_id": str(r.id)}
    with register.connect(t) as tc, tc.transaction():
        it = register.get(tc, r.project_id, stream, key)
        if it is None or it["status"] != "in_review":
            return
        note = r.resolution_note or ""
        if r.status == "rejected":
            register.update(tc, r.project_id, stream, key, "rejected",
                            {"decision": register.decision(who, "reject", note)}, "review queue")
            return
        if r.status == "dismissed":
            register.update(tc, r.project_id, stream, key, "proposed",
                            {"flags": [*(it.get("flags") or []), "the review was dismissed: decide it here"]},
                            "review queue")
            return
        if r.status == "changes_requested":
            return
        option = r.resolution or ""
        changes: dict[str, Any] = {}
        status = "approved"
        if r.outcome == "changed":
            if stream == "mapping":
                try:
                    changes["target"] = parse_target(r.changed_value or "", b.content if b else {})
                except DesignError as e:
                    register.update(tc, r.project_id, stream, key, "proposed",
                                    {"flags": [*(it.get("flags") or []), f"the reviewer's answer was not used: {e}"]},
                                    "review queue")
                    return
            else:
                changes["target"] = {**(it.get("target") or {}), "retire": False, "design": r.changed_value}
                status = "proposed"
        elif option.startswith("No target"):
            changes["target"] = None
        elif option.startswith(("Rebuild it", "Design a browser")):
            changes["target"] = {**(it.get("target") or {}), "retire": False}
            changes["flags"] = ["a person chose to design a replacement instead of retiring it"]
            status = "proposed"
        register.update(tc, r.project_id, stream, key, status, {
            **changes, "decision": register.decision(who, "approve" if status == "approved" else "redesign", note,
                                                     option=option, outcome=r.outcome)}, "review queue")


def audit_record(s: Session, principal: Any, t: Tenant, project_id: uuid.UUID, action: str,
                 details: dict[str, Any]) -> None:
    audit.record(s, principal.actor, action, tenant_id=t.id, project_id=project_id, target_type="project",
                 target_id=str(project_id), details=details)
