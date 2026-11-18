"""Project stages and their gates (E02.F1.S3, E02.F2.S2).

Stage moves are checked here, in deterministic code, whoever asks: a person on the project dashboard
or the Orchestrator agent through its tool. A model can ask for a move; it can never skip a gate.

Evidence that later increments produce (discovery coverage, an approved plan, execution and
reconciliation results) is looked up by `_evidence`. Until a project has that evidence the gate stays
closed and says what is missing.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.blueprints import service as blueprints
from astra_migrate.db.models import STAGE_STATUSES, Project, ProjectStage, Tenant

STAGES: list[tuple[str, str]] = [
    ("blueprint", "Blueprint"),
    ("discovery", "Discovery"),
    ("planning", "Planning"),
    ("execution", "Execution"),
    ("validation", "Validation and reconciliation"),
    ("cutover", "Cutover"),
]
STAGE_KEYS = [k for k, _ in STAGES]
STAGE_TITLES = dict(STAGES)

# What must exist before a stage can be marked done, beyond the previous stage being done.
_DONE_EVIDENCE = {
    "discovery": "No discovery coverage report has been produced for this project.",
    "planning": "No approved migration plan exists for this project.",
    "execution": "No execution results have been recorded for this project.",
    "validation": "No signed-off reconciliation exists for this project.",
    "cutover": "No completed cutover with go/no-go sign-off exists for this project.",
}


@dataclass(frozen=True)
class GateResult:
    allowed: bool
    reasons: list[str]


class StageError(ValueError):
    pass


def _evidence(session: Session, project: Project, stage: str) -> bool:
    """True when the evidence a stage needs to be done exists. Each increment that produces
    evidence (I5 discovery, I7 plans, I9 execution, I10 reconciliation, I11 cutover) adds its check."""
    return False


def current(session: Session, project_id: uuid.UUID) -> dict[str, ProjectStage]:
    return {r.stage: r for r in session.scalars(select(ProjectStage).where(ProjectStage.project_id == project_id))}


def status_of(rows: dict[str, ProjectStage], stage: str) -> str:
    r = rows.get(stage)
    return r.status if r else "not_started"


def check(session: Session, tenant: Tenant, project: Project, stage: str, to_status: str, note: str) -> GateResult:
    if stage not in STAGE_KEYS:
        raise StageError(f"Unknown stage '{stage}'. Stages are: {', '.join(STAGE_KEYS)}.")
    if to_status not in STAGE_STATUSES:
        raise StageError(f"Unknown status '{to_status}'. Use one of: {', '.join(STAGE_STATUSES)}.")
    rows = current(session, project.id)
    reasons: list[str] = []
    idx = STAGE_KEYS.index(stage)
    prev = STAGE_KEYS[idx - 1] if idx > 0 else None
    if to_status == "blocked" and len(note.strip()) < 10:
        reasons.append("Say why the stage is blocked (at least 10 characters).")
    if to_status in ("in_progress", "done") and prev and status_of(rows, prev) != "done":
        reasons.append(f"{STAGE_TITLES[prev]} must be done first.")
    if to_status == "done":
        if stage == "blueprint":
            gate = blueprints.planning_gate(session, tenant, project)
            if not gate["ready"]:
                reasons.append(f"The blueprint is not ready: {gate['reason']}")
        elif not _evidence(session, project, stage):
            reasons.append(_DONE_EVIDENCE[stage])
    if stage == "planning" and to_status == "in_progress":
        gate = blueprints.planning_gate(session, tenant, project)
        if not gate["ready"]:
            reasons.append(f"Planning cannot start: {gate['reason']}")
    return GateResult(not reasons, reasons)


def move(session: Session, tenant: Tenant, project: Project, stage: str, to_status: str, note: str,
         actor: audit.Actor) -> GateResult:
    """Apply a stage move if its gate allows it. Every attempt, allowed or refused, is audited."""
    res = check(session, tenant, project, stage, to_status, note)
    rows = current(session, project.id)
    before = status_of(rows, stage)
    details: dict[str, Any] = {"stage": stage, "from": before, "to": to_status, "note": note.strip()[:1000]}
    if not res.allowed:
        audit.record(session, actor, "stage.move_refused", outcome="denied", tenant_id=tenant.id,
                     project_id=project.id, target_type="stage", target_id=stage,
                     details={**details, "reasons": res.reasons})
        return res
    row = rows.get(stage)
    actor_d = {"type": actor.type, "id": actor.id, "name": actor.name}
    if row is None:
        session.add(ProjectStage(project_id=project.id, stage=stage, status=to_status, note=note.strip(),
                                 updated_by=actor_d))
    else:
        row.status, row.note, row.updated_by, row.updated_at = to_status, note.strip(), actor_d, datetime.now(UTC)
    session.flush()
    audit.record(session, actor, "stage.moved", tenant_id=tenant.id, project_id=project.id, target_type="stage",
                 target_id=stage, details=details)
    return res


def overview(session: Session, project_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = current(session, project_id)
    out = []
    for key, title in STAGES:
        r = rows.get(key)
        out.append({"stage": key, "title": title, "status": r.status if r else "not_started",
                    "note": r.note if r else "", "updated_by": (r.updated_by or {}).get("name") if r else None,
                    "updated_by_type": (r.updated_by or {}).get("type") if r else None,
                    "updated_at": r.updated_at if r else None})
    return out
