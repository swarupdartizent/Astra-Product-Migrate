"""Review items: classification at creation, queue priority, evidence, the explanation of why an item was raised,
precedents and decisions (approve, reject, change, dismiss).

Compliance impact comes from the approval controls of the project's compliance packs: a control whose
`applies_to` names the item's subject type makes the item compliance-relevant, or critical when the control is
compliance-critical; `two_person_approval` (or `min_approvers: 2`) makes it need two people. The database enforces
the approval count, named reviewers on critical items and that requesters and agents cannot approve.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.blueprints import service as blueprints
from astra_migrate.db.models import (
    AgentRun,
    BlueprintVersion,
    Project,
    ReviewApproval,
    ReviewBulkBatch,
    ReviewItem,
    RoleAssignment,
    Tenant,
    User,
)
from astra_migrate.packs import registry as pack_registry
from astra_migrate.packs.schema import ControlType
from astra_migrate.security.rbac import ROLES, P

RISK_WEIGHT = {"low": 1, "medium": 2, "high": 3, "critical": 4}
COMPLIANCE_WEIGHT = {"none": 0, "relevant": 1, "critical": 2}
DECIDED = ("resolved", "rejected", "dismissed")
# Subject types the platform raises items for. Approval controls name these in `applies_to`.
SUBJECT_TYPES = ("decision", "conversion_script", "mapping", "transformation", "configuration", "integration",
                 "report", "security", "retirement", "pattern", "screening", "scope")
ASSISTANT = "review-assistant"


class ReviewError(Exception):
    def __init__(self, status: int, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.status, self.field = status, field


# ------------------------------------------------------------------ classification

@dataclass(frozen=True)
class Compliance:
    level: str = "none"
    controls: tuple[str, ...] = ()
    required_approvals: int = 1


def compliance_for(s: Session, project_id: uuid.UUID, subject_type: str) -> Compliance:
    """Approval controls of the blueprint's compliance packs that govern this subject type."""
    bv = s.scalars(select(BlueprintVersion).where(BlueprintVersion.project_id == project_id,
                                                  BlueprintVersion.status == "approved")
                   .order_by(BlueprintVersion.number.desc())).first() or blueprints.latest(s, project_id)
    if bv is None:
        return Compliance()
    found: list[dict[str, Any]] = []
    for ref in (bv.content or {}).get("compliance_packs") or []:
        try:
            pk = pack_registry.get_by_ref(s, ref, published_only=False)
        except ValueError:
            continue
        if pk is None:
            continue
        m = pack_registry.manifest_of(pk)
        found += [{"id": c.id, "type": c.type.value, "applies_to": list(c.parameters.get("applies_to") or []),
                   "compliance_critical": c.compliance_critical, "two_person_approval": c.two_person_approval,
                   "min_approvers": int(c.parameters.get("min_approvers") or 1)} for c in m.adds.controls]
    return classify(found, subject_type)


def classify(controls: list[dict[str, Any]], subject_type: str) -> Compliance:
    """The compliance impact of a subject type under a set of controls (pure; the release gate scores it)."""
    level, ids, two = "none", [], False
    for c in controls:
        if c["type"] != ControlType.APPROVAL.value or subject_type not in c.get("applies_to", []):
            continue
        ids.append(c["id"])
        level = "critical" if c.get("compliance_critical") or level == "critical" else "relevant"
        two = two or bool(c.get("two_person_approval")) or int(c.get("min_approvers") or 1) >= 2
    return Compliance(level, tuple(sorted(set(ids))), 2 if two else 1)


def pattern_key(prefix: str, *parts: str) -> str:
    """A stable key for 'the same kind of question': names, quoted values and numbers are removed, so items about
    different objects with the same reasons share a key (used for precedents and grouping)."""
    norm = sorted({re.sub(r"\s+", " ", re.sub(r"'[^']*'|\"[^\"]*\"|\[[^\]]*\]|\d+", "", p)).strip().lower()
                   for p in parts if p})
    digest = hashlib.sha256("\n".join(norm).encode()).hexdigest()[:16]
    return f"{prefix}:{digest}"[:200]


def new_item(s: Session, *, tenant_id: uuid.UUID, project_id: uuid.UUID, kind: str, title: str, question: str,
             options: list[str], owner_role: str, requested_by: dict[str, Any], context: dict[str, Any],
             subject_type: str = "decision", stream: str | None = None, segment: str | None = None,
             risk: str = "medium", confidence: float | None = None, pattern: str | None = None,
             evidence: list[dict[str, Any]] | None = None, agent_run_id: uuid.UUID | None = None,
             owner_user_id: uuid.UUID | None = None, compliance: Compliance | None = None) -> ReviewItem:
    c = compliance or compliance_for(s, project_id, subject_type)
    item = ReviewItem(tenant_id=tenant_id, project_id=project_id, kind=kind, title=title[:300], question=question,
                      options=options, context=context, owner_role=owner_role, owner_user_id=owner_user_id,
                      requested_by=requested_by, agent_run_id=agent_run_id, status="open", stream=stream,
                      segment=segment[:100] if segment else None, subject_type=subject_type, risk=risk,
                      confidence=confidence, compliance=c.level, compliance_controls=list(c.controls),
                      required_approvals=c.required_approvals, pattern_key=pattern, evidence=evidence or [])
    s.add(item)
    return item


# ------------------------------------------------------------------ priority

def priority(r: ReviewItem) -> tuple[int, list[str]]:
    """Queue order: risk first, then compliance impact, then low confidence. Unknown confidence counts as 0.5."""
    conf = 0.5 if r.confidence is None else r.confidence
    score = RISK_WEIGHT.get(r.risk, 2) * 100 + COMPLIANCE_WEIGHT.get(r.compliance, 0) * 30 + round((1 - conf) * 20)
    reasons = [f"{r.risk} risk"]
    if r.compliance != "none":
        reasons.append(f"compliance {r.compliance} ({', '.join(r.compliance_controls)})")
    reasons.append("confidence not stated" if r.confidence is None else f"confidence {round(conf * 100)}%")
    return score, reasons


# ------------------------------------------------------------------ who may decide

def approvals(s: Session, r: ReviewItem) -> list[ReviewApproval]:
    return list(s.scalars(select(ReviewApproval).where(ReviewApproval.item_id == r.id)
                          .order_by(ReviewApproval.created_at)))


def can_decide(s: Session, principal: Any, t: Tenant, r: ReviewItem) -> tuple[bool, str]:
    if r.status != "open":
        return False, f"The item is {r.status.replace('_', ' ')}."
    if not principal.has_on_project(P.REVIEW_RESOLVE, t, r.project_id):
        return False, "You cannot decide review items on this project."
    uid = principal.user.id
    if str(r.requested_by.get("id")) == str(uid):
        return False, "You requested this item, so someone else decides it."
    named = r.owner_user_id is not None and r.owner_user_id == uid
    label = ROLES[r.owner_role].label if r.owner_role in ROLES else r.owner_role
    if not named and r.owner_role not in principal.roles_on_project(t, r.project_id):
        return False, f"This item is owned by the {label} role."
    if r.compliance == "critical":
        if r.owner_user_id is None:
            return False, "This item is compliance-critical: a named reviewer must be assigned first."
        if r.required_approvals == 1 and not named:
            return False, "This item is compliance-critical: only its named reviewer decides it."
    if any(a.user_id == uid for a in approvals(s, r)):
        return False, "You have approved this item; a second person must approve it too."
    return True, ""


def assign_reviewer(s: Session, principal: Any, t: Tenant, r: ReviewItem, user_id: uuid.UUID | None) -> None:
    if r.status != "open":
        raise ReviewError(409, f"The item is {r.status.replace('_', ' ')}.")
    if user_id is not None:
        u = s.get(User, user_id)
        if u is None or u.kind != "person" or not u.is_active:
            raise ReviewError(422, "Choose an active person.", "user_id")
        if str(r.requested_by.get("id")) == str(user_id):
            raise ReviewError(422, "The person who requested the item cannot review it.", "user_id")
        if user_id not in holders(s, t, r.project_id, r.owner_role):
            label = ROLES[r.owner_role].label if r.owner_role in ROLES else r.owner_role
            raise ReviewError(422, f"The reviewer must hold the {label} role on this project.", "user_id")
    before = r.owner_user_id
    r.owner_user_id = user_id
    audit.record(s, principal.actor, "review.reviewer_assigned", tenant_id=t.id, project_id=r.project_id,
                 target_type="review_item", target_id=str(r.id),
                 details={"from": str(before) if before else None, "to": str(user_id) if user_id else None})


def holders(s: Session, t: Tenant, project_id: uuid.UUID, role: str) -> set[uuid.UUID]:
    return set(s.scalars(select(RoleAssignment.user_id).where(
        RoleAssignment.role == role,
        ((RoleAssignment.scope_type == "project") & (RoleAssignment.scope_id == project_id))
        | ((RoleAssignment.scope_type == "tenant") & (RoleAssignment.scope_id == t.id)))))


# ------------------------------------------------------------------ decisions

@dataclass
class Decided:
    recorded: str  # approval_recorded | approved | rejected | changed | changes_requested | dismissed
    follow_up_error: str | None = None


def decide(s: Session, principal: Any, t: Tenant, r: ReviewItem, action: str, option: str | None, note: str,
           changed_value: str | None, bulk_batch_id: uuid.UUID | None = None) -> Decided:
    ok, why = can_decide(s, principal, t, r)
    if not ok:
        raise ReviewError(409 if r.status != "open" else 403, why)
    note = note.strip()
    now, uid = datetime.now(UTC), principal.user.id
    result: Decided
    if action == "approve":
        if option not in r.options:
            raise ReviewError(422, "Choose one of the item's options.", "option")
        prior = approvals(s, r)
        if prior and prior[0].option != option:
            raise ReviewError(409, f"The first approver chose '{prior[0].option}'. Approve the same option, or "
                                   "reject the item with a reason.")
        complete = len(prior) + 1 >= r.required_approvals
        if complete and r.compliance == "critical" and r.owner_user_id not in {a.user_id for a in prior} | {uid}:
            raise ReviewError(409, "The named reviewer must be one of the approvers of a compliance-critical item.")
        s.add(ReviewApproval(item_id=r.id, user_id=uid, option=option, note=note, bulk_batch_id=bulk_batch_id))
        s.flush()
        if not complete:
            _audit(s, principal, t, r, "review.approval_recorded", {"option": option, "note": note,
                                                                    "approvals": len(prior) + 1,
                                                                    "bulk_batch": str(bulk_batch_id)
                                                                    if bulk_batch_id else None})
            return Decided("approval_recorded")
        r.status, r.outcome, r.resolution = "resolved", "approved", option
        result = Decided("approved")
    elif action == "reject":
        _need_reason(note)
        r.status, r.outcome = "rejected", "rejected"
        result = Decided("rejected")
    elif action == "dismiss":
        _need_reason(note)
        r.status, r.outcome = "dismissed", "dismissed"
        result = Decided("dismissed")
    elif action == "change":
        _need_reason(note)
        result = _change(s, principal, t, r, note, (changed_value or "").strip() or None)
    else:
        raise ReviewError(422, "Unknown action.", "action")
    r.resolution_note, r.resolved_by, r.resolved_at = note, uid, now
    s.flush()
    if (r.context or {}).get("design"):
        from astra_migrate.design.service import on_review

        on_review(s, t, r)
    _audit(s, principal, t, r, f"review.{result.recorded}",
           {"option": r.resolution, "note": note, "changed_value": r.changed_value, "outcome": r.outcome,
            "bulk_batch": str(bulk_batch_id) if bulk_batch_id else None,
            "approvals": [str(a.user_id) for a in approvals(s, r)], "follow_up_run": str(r.follow_up_run_id)
            if r.follow_up_run_id else None, "follow_up_error": result.follow_up_error})
    return result


def _change(s: Session, principal: Any, t: Tenant, r: ReviewItem, note: str, value: str | None) -> Decided:
    """A change goes back to the agent that asked, with the reviewer's note. Items raised by platform rules have
    no agent to send back to, so the reviewer's changed answer is the decision."""
    r.changed_value, r.outcome = value, "changed"
    if r.requested_by.get("type") == "agent" and r.agent_run_id:
        r.status = "changes_requested"
        run = s.get(AgentRun, r.agent_run_id)
        p = s.get(Project, r.project_id)
        err = None
        if run is None or p is None:
            err = "The agent run that raised the item no longer exists."
        else:
            from astra_migrate.agents import registry as agent_registry
            from astra_migrate.agents.jobs import start_run

            objective = (f"A reviewer asked for changes to your request '{r.title}' (review item {r.id}).\n"
                         f"Reviewer's note: {note}\n"
                         + (f"Reviewer's suggested answer: {value}\n" if value else "")
                         + "Revise your work with this note and, if a decision is still needed, ask for it again.")
            try:
                r.follow_up_run_id = start_run(s, p, run.agent_name, objective, principal.actor,
                                               parent_run_id=r.agent_run_id).id
            except agent_registry.AgentError as e:
                err = str(e)
        if err:
            r.context = {**r.context, "follow_up_error": err}
        return Decided("changes_requested", err)
    if r.required_approvals > 1:
        raise ReviewError(409, "Two people must approve this item. Approve one of its options, or reject it with "
                               "a reason.")
    if not value:
        raise ReviewError(422, "Give the changed answer: no agent raised this item, so your answer is the decision.",
                          "changed_value")
    r.status, r.resolution = "resolved", value
    return Decided("changed")


def _need_reason(note: str) -> None:
    if len(note) < 10:
        raise ReviewError(422, "Give a reason (at least 10 characters).", "note")


def _audit(s: Session, principal: Any, t: Tenant, r: ReviewItem, action: str, details: dict[str, Any]) -> None:
    audit.record(s, principal.actor, action, tenant_id=t.id, project_id=r.project_id, target_type="review_item",
                 target_id=str(r.id), details={"kind": r.kind, "title": r.title, "owner_role": r.owner_role,
                                               "compliance": r.compliance, "controls": r.compliance_controls,
                                               "requested_by": r.requested_by, **details})


# ------------------------------------------------------------------ bulk approval (E16.F1.S5)

BULK_MIN, BULK_MAX = 2, 200


def bulk_candidates(s: Session, principal: Any, t: Tenant, project_id: uuid.UUID, pattern_key: str
                    ) -> dict[str, Any]:
    """The open items of one evidence pattern, split into those this reviewer can approve together and those that
    must be decided one by one, each with the reason. The options offered are those every eligible item has."""
    rows = list(s.scalars(select(ReviewItem).where(ReviewItem.project_id == project_id,
                                                   ReviewItem.pattern_key == pattern_key,
                                                   ReviewItem.status == "open")))
    rows.sort(key=lambda r: (-priority(r)[0], r.created_at))
    eligible: list[ReviewItem] = []
    excluded: list[tuple[ReviewItem, str]] = []
    for r in rows:
        why = _bulk_refusal(s, principal, t, r)
        if why:
            excluded.append((r, why))
        else:
            eligible.append(r)
    options = [o for o in (eligible[0].options if eligible else []) if all(o in r.options for r in eligible)]
    prior: dict[str, str] = {}
    for r in eligible:
        first = approvals(s, r)
        if first:
            prior[str(r.id)] = first[0].option
    return {"pattern_key": pattern_key, "eligible": eligible, "excluded": excluded, "options": options,
            "first_approver_options": prior,
            "can_bulk": len(eligible) >= BULK_MIN and bool(options),
            "reason": None if len(eligible) >= BULK_MIN and options else
            ("Fewer than two items of this pattern can be approved together." if len(eligible) < BULK_MIN
             else "The items of this pattern share no option.")}


def _bulk_refusal(s: Session, principal: Any, t: Tenant, r: ReviewItem) -> str | None:
    if r.compliance == "critical":
        return "Compliance-critical: decide it on its own, with its named reviewer."
    ok, why = can_decide(s, principal, t, r)
    return None if ok else why


def bulk_approve(s: Session, principal: Any, t: Tenant, project_id: uuid.UUID, pattern_key: str, option: str,
                 note: str, item_ids: list[uuid.UUID]) -> dict[str, Any]:
    """Approve the listed items with one option and one reason. All or nothing: if any listed item cannot be
    approved this way (it changed since the reviewer looked), nothing is recorded and the items are named."""
    note = note.strip()
    _need_reason(note)
    ids = list(dict.fromkeys(item_ids))
    if not BULK_MIN <= len(ids) <= BULK_MAX:
        raise ReviewError(422, f"Approve between {BULK_MIN} and {BULK_MAX} items together.", "item_ids")
    rows = {r.id: r for r in s.scalars(select(ReviewItem).where(ReviewItem.id.in_(ids)).with_for_update())}
    problems: list[str] = []
    for i in ids:
        r = rows.get(i)
        if r is None or r.project_id != project_id:
            problems.append(f"{i}: not an item of this project")
            continue
        if r.pattern_key != pattern_key:
            problems.append(f"{r.title}: has a different evidence pattern")
            continue
        why = _bulk_refusal(s, principal, t, r)
        if why:
            problems.append(f"{r.title}: {why}")
        elif option not in r.options:
            problems.append(f"{r.title}: '{option}' is not one of its options")
        else:
            first = approvals(s, r)
            if first and first[0].option != option:
                problems.append(f"{r.title}: its first approver chose '{first[0].option}'")
    if problems:
        raise ReviewError(409, "Nothing was approved. These items cannot be approved together now: "
                          + "; ".join(problems[:20]) + ("; ..." if len(problems) > 20 else ""))
    batch = ReviewBulkBatch(tenant_id=t.id, project_id=project_id, pattern_key=pattern_key, option=option, note=note,
                            item_ids=[str(i) for i in ids], decided_by=principal.user.id)
    s.add(batch)
    s.flush()
    outcome: dict[str, int] = {}
    for i in ids:
        res = decide(s, principal, t, rows[i], "approve", option, note, None, bulk_batch_id=batch.id)
        outcome[res.recorded] = outcome.get(res.recorded, 0) + 1
    audit.record(s, principal.actor, "review.bulk_approved", tenant_id=t.id, project_id=project_id,
                 target_type="review_bulk_batch", target_id=str(batch.id),
                 details={"pattern_key": pattern_key, "option": option, "note": note, "items": len(ids),
                          "outcome": outcome})
    return {"batch_id": batch.id, "items": len(ids), "approved": outcome.get("approved", 0),
            "approval_recorded": outcome.get("approval_recorded", 0)}


# ------------------------------------------------------------------ precedents (E21.F1.S1)

def precedents(s: Session, r: ReviewItem, limit: int = 10) -> dict[str, Any]:
    """Earlier decided items in the same tenant with the same pattern key, with source project and outcome."""
    if not r.pattern_key:
        return {"pattern_key": None, "items": [], "outcomes": {}}
    base = select(ReviewItem).where(ReviewItem.tenant_id == r.tenant_id, ReviewItem.pattern_key == r.pattern_key,
                                    ReviewItem.id != r.id, ReviewItem.status.in_(DECIDED))
    outcomes: dict[str | None, int] = {k: int(v) for k, v in s.execute(select(ReviewItem.outcome, func.count()).where(
        ReviewItem.tenant_id == r.tenant_id, ReviewItem.pattern_key == r.pattern_key, ReviewItem.id != r.id,
        ReviewItem.status.in_(DECIDED)).group_by(ReviewItem.outcome)).all()}
    items = []
    for x in s.scalars(base.order_by(ReviewItem.resolved_at.desc().nulls_last()).limit(limit)):
        proj = s.get(Project, x.project_id)
        by = s.get(User, x.resolved_by) if x.resolved_by else None
        items.append({"item_id": str(x.id), "project_id": str(x.project_id),
                      "project_name": proj.name if proj else None, "same_project": x.project_id == r.project_id,
                      "title": x.title, "outcome": x.outcome or x.status, "resolution": x.resolution,
                      "changed_value": x.changed_value, "note": x.resolution_note,
                      "decided_by": by.display_name if by else None,
                      "decided_at": x.resolved_at.isoformat() if x.resolved_at else None})
    return {"pattern_key": r.pattern_key, "items": items,
            "outcomes": {str(k or "unknown"): int(v) for k, v in outcomes.items()}}


# ------------------------------------------------------------------ why (recorded evidence)

def why(s: Session, r: ReviewItem) -> list[str]:
    """Why the item was raised, built only from what was recorded with it. No model is involved."""
    ctx = r.context or {}
    req = r.requested_by or {}
    lines = [f"Raised by {req.get('name', 'unknown')} ({req.get('type', 'unknown')}) on "
             f"{r.created_at:%d %b %Y %H:%M} UTC." if r.created_at else
             f"Raised by {req.get('name', 'unknown')} ({req.get('type', 'unknown')})."]
    if ctx.get("why_needed"):
        lines.append(f"The agent said the decision is needed because: {ctx['why_needed']}")
    if ctx.get("reasons"):
        lines.append("Automatic conversion stopped because: " + " ".join(str(x) for x in ctx["reasons"]))
    adv = ctx.get("advice")
    if isinstance(adv, dict):
        lines.append(f"The blueprint chose {adv.get('chosen')}; the version delta suggests {adv.get('recommended')}.")
        lines += [str(x) for x in adv.get("reasons") or []]
    if "unused" in ctx:
        lines.append(f"{ctx['unused']} element(s) showed no direct or indirect use over {ctx.get('evidence_days')} "
                     "day(s) of activity evidence.")
    if ctx.get("rules") and r.kind == "screening_flag":
        lines.append(f"Screening rules matched: {', '.join(map(str, ctx['rules']))} (severity "
                     f"{ctx.get('severity', 'unknown')}).")
    if r.compliance != "none":
        lines.append(f"Compliance {r.compliance}: governed by {', '.join(r.compliance_controls)}; it needs "
                     f"{r.required_approvals} approver(s)"
                     + (" including a named reviewer." if r.compliance == "critical" else "."))
    score, reasons = priority(r)
    lines.append(f"Queue priority {score}: " + ", ".join(reasons) + ".")
    return lines


def assistant_objective(r: ReviewItem, question: str) -> str:
    return (f"A reviewer is looking at review item {r.id} ('{r.title}') and asks:\n{question.strip()}\n\n"
            "Explain why the item was proposed, using get_review_item and get_review_precedents. Say what the "
            "evidence shows and what it does not. You cannot approve, reject or change the item; the reviewer "
            "decides.")


def record_assistant_run(r: ReviewItem, run_id: uuid.UUID, question: str, by: str) -> None:
    runs = list((r.context or {}).get("assistant_runs") or [])
    runs.append({"run_id": str(run_id), "question": question.strip()[:2000], "by": by,
                 "at": datetime.now(UTC).isoformat()})
    r.context = {**(r.context or {}), "assistant_runs": runs[-20:]}


def tool_view(s: Session, r: ReviewItem) -> dict[str, Any]:
    """What the Review Assistant may read about an item: metadata and recorded evidence, no sample values."""
    return {"id": str(r.id), "kind": r.kind, "subject_type": r.subject_type, "title": r.title,
            "question": r.question, "options": list(r.options), "status": r.status, "risk": r.risk,
            "confidence": r.confidence, "compliance": r.compliance, "controls": r.compliance_controls,
            "required_approvals": r.required_approvals, "approvals_so_far": len(approvals(s, r)),
            "owner_role": r.owner_role, "requested_by": {k: r.requested_by.get(k) for k in ("type", "name")},
            "stream": r.stream, "segment": r.segment,
            "context": {k: v for k, v in (r.context or {}).items() if k not in ("assistant_runs", "flag_id")},
            "evidence": r.evidence, "why": why(s, r)}
