"""Planning (E11, E15.F1, E19): scope, dependencies, tasks and estimates, controls, waves, risks, cutover,
coexistence, baselines, exports, gaps and pre-sales estimates."""

from __future__ import annotations

import base64
import binascii
import csv
import io
import json
import re
import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

import yaml
from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.api.errors import Problem, conflict, forbidden, invalid, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import Gap, PlanBaseline, PresalesEstimate, Programme, Project, Tenant, User
from astra_migrate.packs import registry
from astra_migrate.packs.schema import PackType
from astra_migrate.planning import baseline as plan_baseline
from astra_migrate.planning import (
    controls,
    cutover,
    estimation,
    exports,
    presales,
    scope,
    service,
    store,
    wbs,
    workbench,
)
from astra_migrate.planning.estimation import DISPOSITIONS, ROLES
from astra_migrate.planning.service import PlanError
from astra_migrate.security.principal import CurrentPrincipal, Principal, project_for
from astra_migrate.security.rbac import P

router = APIRouter(tags=["planning"])
DB = Annotated[Session, Depends(get_session)]
MAX_UPLOAD = 25 * 1024 * 1024


def _ctx(s: Session, principal: Principal, project_id: uuid.UUID, perm: P | None = None) -> tuple[Tenant, Project]:
    return project_for(s, principal, project_id, perm)


def _who(principal: Principal) -> dict[str, str]:
    return {"by": principal.user.display_name, "by_id": str(principal.user.id), "at": datetime.now(UTC).isoformat()}


def _plan_error(e: PlanError) -> Problem:
    return Problem(409, "plan-input", "The plan cannot be produced yet", str(e))


def _user_name(s: Session, uid: Any) -> str | None:
    if not uid:
        return None
    u = s.get(User, uuid.UUID(str(uid)))
    return u.display_name if u else None


def _person(s: Session, uid: uuid.UUID | None, field: str) -> None:
    if uid is None:
        return
    u = s.get(User, uid)
    if u is None or u.kind != "person" or not u.is_active:
        raise invalid(field, "Choose an active person.")


# ------------------------------------------------------------------ overview

@router.get("/projects/{project_id}/plan")
def overview(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id)
    try:
        inp = service.inputs(s, p.id)
    except PlanError as e:
        return {"ready": False, "problem": str(e), "can_manage": principal.has_on_project(P.STAGE_MANAGE, t, p.id)}
    with store.connect(t) as tc:
        counts = dict(tc.execute("SELECT kind, count(*) FROM estate.plan_items WHERE project_id = %s GROUP BY kind",
                                 (p.id,)).fetchall())
        tasks = store.items(tc, p.id, "task")
        wp = store.get(tc, p.id, "wave_plan", "current")
        choice = store.get(tc, p.id, "cutover_choice", "current")
        sc = store.items(tc, p.id, "scope")
    latest = s.scalars(select(PlanBaseline).where(PlanBaseline.project_id == p.id)
                       .order_by(PlanBaseline.number.desc())).first()
    approved = s.scalars(select(PlanBaseline).where(PlanBaseline.project_id == p.id,
                                                    PlanBaseline.status == "approved")).first()
    return {
        "ready": True, "blueprint_version": inp.blueprint_version, "notes": inp.notes,
        "missing_packs": inp.missing_packs,
        "estimation": [{"pack": r.pack, "calibrated": r.estimation.calibrated, "basis": r.estimation.basis,
                        "rules": len(r.estimation.rules)} for r in inp.rules],
        "compliance_packs": [m.ref for m in inp.compliance], "max_task_hours": inp.max_task_hours,
        "discovery_run_id": str(inp.discovery.id) if inp.discovery else None,
        "delta_run_id": str(inp.delta.id) if inp.delta else None, "target_adapter": inp.target_ref,
        "counts": counts, "scope_approved": sum(1 for b in sc.values() if b["status"] == "approved"),
        "estimate": wbs.rollup(tasks, service.assignments_from(wp))["total"] if tasks else None,
        "waves_fit": wp.get("fits") if wp else None, "cutover_choice": choice,
        "latest_baseline": _baseline_out(s, latest) if latest else None,
        "approved_baseline_id": str(approved.id) if approved else None,
        "baseline_awaiting_approval": bool(latest and latest.status == "proposed"),
        "can_approve_waiting": bool(latest and latest.status == "proposed"
                                    and latest.proposed_by != principal.user.id
                                    and principal.has_on_project(P.PLAN_APPROVE, t, p.id)),
        "can_manage": principal.has_on_project(P.STAGE_MANAGE, t, p.id),
        "can_approve": principal.has_on_project(P.PLAN_APPROVE, t, p.id)}


# ------------------------------------------------------------------ scope (E11.F1.S1)

@router.post("/projects/{project_id}/plan/scope/generate")
def generate_scope(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Propose a disposition, with evidence, for every element of the newest discovery. Decisions already made
    are kept."""
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    try:
        inp = service.inputs(s, p.id)
        with store.connect(t) as tc:
            res = service.generate_scope(tc, inp, p.id, principal.user.display_name)
    except PlanError as e:
        raise _plan_error(e) from e
    audit.record(s, principal.actor, "plan.scope_generated", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={k: v for k, v in res.items() if k != "dropped"})
    return res


@router.get("/projects/{project_id}/plan/scope")
def list_scope(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB, stream: str | None = None,
               disposition: str | None = None, status: str | None = None, q: str | None = None,
               offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 100
               ) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id)
    with store.connect(t) as tc:
        sc = store.items(tc, p.id, "scope")
    rows = [{"key": k, **b, "effective": scope.effective(b)} for k, b in sc.items()]
    if stream:
        rows = [r for r in rows if r["stream"] == stream]
    if disposition:
        rows = [r for r in rows if r["effective"] == disposition]
    if status:
        rows = [r for r in rows if r["status"] == status]
    if q:
        rows = [r for r in rows if q.lower() in r["element"].lower()]
    rows.sort(key=lambda r: (r["stream"], r["element"].lower()))
    return {"total": len(rows), "offset": offset, "dispositions": list(DISPOSITIONS),
            "counts": {d: sum(1 for b in sc.values() if scope.effective(b) == d) for d in DISPOSITIONS},
            "pending": sum(1 for b in sc.values() if b["status"] != "approved"),
            "items": rows[offset:offset + limit]}


class DecisionIn(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=5000)
    disposition: Literal[DISPOSITIONS] | None = Field(  # type: ignore[valid-type]
        default=None, description="Leave empty to approve each item's proposal")
    reason: str = Field(min_length=10, max_length=2000)


@router.post("/projects/{project_id}/plan/scope/decisions")
def decide_scope(project_id: uuid.UUID, body: DecisionIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Approve proposals, or set a different disposition, with a reason. Only people decide."""
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    who = _who(principal)
    with store.connect(t) as tc:
        sc = store.items(tc, p.id, "scope")
        unknown = [k for k in body.keys if k not in sc]
        if unknown:
            raise invalid("keys", f"Not in the scope register: {', '.join(unknown[:5])}")
        changed = {}
        for k in body.keys:
            b = sc[k]
            disp = body.disposition or b["proposed"]
            changed[k] = {**b, "status": "approved", "disposition": disp,
                          "decision": {**who, "reason": body.reason.strip(), "changed": disp != b["proposed"]}}
        with tc.transaction():
            store.put_many(tc, p.id, "scope", changed, principal.user.display_name)
    audit.record(s, principal.actor, "plan.scope_decided", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"items": len(changed), "disposition": body.disposition,
                                               "reason": body.reason.strip(), "keys": body.keys[:50]})
    return {"decided": len(changed)}


# ------------------------------------------------------------------ dependencies (E11.F1.S2)

@router.get("/projects/{project_id}/plan/scope/keys")
def scope_keys(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
               q: Annotated[str | None, Query(max_length=200)] = None,
               limit: Annotated[int, Query(ge=1, le=200)] = 50) -> list[dict[str, Any]]:
    """A short list of scope items for pickers (pins, dependencies)."""
    t, p = _ctx(s, principal, project_id)
    with store.connect(t) as tc:
        sc = store.items(tc, p.id, "scope")
    rows = [{"key": k, "element": b["element"], "stream": b["stream"], "disposition": scope.effective(b)}
            for k, b in sorted(sc.items()) if not q or q.lower() in f"{k} {b['element']}".lower()]
    return rows[:limit]


# ------------------------------------------------------------------ planning workbench (E16.F2.S1)

@router.get("/projects/{project_id}/plan/workbench")
def plan_workbench(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """The plan as one view for the timeline, the task list and the dependency graph."""
    t, p = _ctx(s, principal, project_id)
    with store.connect(t) as tc:
        out = workbench.view(tc, p.id)
    return {**out, "can_edit": principal.has_on_project(P.STAGE_MANAGE, t, p.id)}


class WorkbenchEditsIn(BaseModel):
    edits: list[Annotated[workbench.Edit, Field(discriminator="op")]] = Field(min_length=1, max_length=100)


@router.post("/projects/{project_id}/plan/workbench/edits")
def plan_workbench_edits(project_id: uuid.UUID, body: WorkbenchEditsIn, principal: CurrentPrincipal, s: DB
                         ) -> dict[str, Any]:
    """Apply edits (moves, dependencies, task role and estimate changes) together, then re-run the constraint
    solver. If any edit is invalid, nothing is saved."""
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    try:
        with store.connect(t) as tc:
            out = workbench.edit_and_solve(s, tc, p.id, list(body.edits), _who(principal),
                                           principal.user.display_name)
    except workbench.EditError as e:
        raise invalid(f"edits.{e.index}.{e.field}", str(e)) from e
    except PlanError as e:
        raise _plan_error(e) from e
    plan = out.get("plan") or {}
    audit.record(s, principal.actor, "plan.workbench_edited", tenant_id=t.id, project_id=p.id,
                 target_type="project", target_id=str(p.id),
                 details={"edits": [e.model_dump() for e in body.edits], "applied": out["applied"],
                          "fits": plan.get("fits"), "broken": len(plan.get("broken") or []),
                          "solve_error": out["solve_error"]})
    return {**out, "can_edit": True}


@router.get("/projects/{project_id}/plan/dependencies")
def dependencies(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id)
    with store.connect(t) as tc:
        return service.dependency_view(tc, p.id)


class EdgeIn(BaseModel):
    src: str = Field(description="The element whose work comes later")
    dst: str = Field(description="The element it depends on")
    reason: str = Field(min_length=10, max_length=2000)


@router.post("/projects/{project_id}/plan/dependencies", status_code=201)
def add_edge(project_id: uuid.UUID, body: EdgeIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    if body.src == body.dst:
        raise invalid("dst", "An element cannot depend on itself.")
    key = f"{body.src}->{body.dst}"
    with store.connect(t) as tc:
        sc = store.items(tc, p.id, "scope")
        for f, v in (("src", body.src), ("dst", body.dst)):
            if v not in sc:
                raise invalid(f, "Not in the scope register.")
        with tc.transaction():
            store.put(tc, p.id, "edge", key, {"src": body.src, "dst": body.dst, "kinds": ["person"],
                                              "source": "person", "removed": None,
                                              "added": {**_who(principal), "reason": body.reason.strip()}},
                      principal.user.display_name)
        view = service.dependency_view(tc, p.id)
    audit.record(s, principal.actor, "plan.dependency_added", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"edge": key, "reason": body.reason.strip()})
    return view


class RemoveEdgeIn(BaseModel):
    key: str
    reason: str = Field(min_length=10, max_length=2000)


@router.post("/projects/{project_id}/plan/dependencies/remove")
def remove_edge_body(project_id: uuid.UUID, body: RemoveEdgeIn, principal: CurrentPrincipal, s: DB
                     ) -> dict[str, Any]:
    """Remove a dependency, with the reason in the body (so it is not kept in URLs and access logs)."""
    return remove_edge(project_id, body.key, body.reason, principal, s)


@router.delete("/projects/{project_id}/plan/dependencies", deprecated=True)
def remove_edge(project_id: uuid.UUID, key: str, reason: Annotated[str, Query(min_length=10, max_length=2000)],
                principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Remove a dependency. A discovered one is kept as removed, with who and why, so it does not come back."""
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    with store.connect(t) as tc:
        e = store.get(tc, p.id, "edge", key)
        if e is None:
            raise not_found("Dependency")
        with tc.transaction():
            if e.get("source") == "person":
                store.delete(tc, p.id, "edge", key)
            else:
                store.put(tc, p.id, "edge", key, {**e, "removed": {**_who(principal), "reason": reason.strip()}},
                          principal.user.display_name)
        view = service.dependency_view(tc, p.id)
    audit.record(s, principal.actor, "plan.dependency_removed", tenant_id=t.id, project_id=p.id,
                 target_type="project", target_id=str(p.id), details={"edge": key, "reason": reason.strip()})
    return view


# ------------------------------------------------------------------ tasks and estimates (E11.F2)

@router.post("/projects/{project_id}/plan/tasks/generate")
def generate_tasks(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    try:
        inp = service.inputs(s, p.id)
        with store.connect(t) as tc:
            res = service.generate_tasks(tc, inp, p.id, principal.user.display_name)
    except PlanError as e:
        raise _plan_error(e) from e
    audit.record(s, principal.actor, "plan.tasks_generated", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"tasks": res["tasks"], "unestimated": len(res["unestimated"])})
    return res


@router.get("/projects/{project_id}/plan/tasks")
def list_tasks(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB, stream: str | None = None,
               role: str | None = None, wave: str | None = None, q: str | None = None,
               offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=500)] = 100
               ) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id)
    with store.connect(t) as tc:
        tasks = store.items(tc, p.id, "task")
        assign = service.assignments(tc, p.id)
    rows = [{"key": k, **b, "wave": assign.get(b["scope"])} for k, b in sorted(tasks.items())]
    if stream:
        rows = [r for r in rows if r["stream"] == stream]
    if role:
        rows = [r for r in rows if r["role"] == role]
    if wave:
        rows = [r for r in rows if r["wave"] == wave]
    if q:
        rows = [r for r in rows if q.lower() in r["title"].lower()]
    return {"total": len(rows), "offset": offset, "roles": list(ROLES), "items": rows[offset:offset + limit]}


@router.get("/projects/{project_id}/plan/estimates")
def estimates(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Ranges rolled up by stream, segment, wave and role, with the estimation packs behind them."""
    t, p = _ctx(s, principal, project_id)
    try:
        inp = service.inputs(s, p.id)
    except PlanError as e:
        raise _plan_error(e) from e
    with store.connect(t) as tc:
        tasks = store.items(tc, p.id, "task")
        out = wbs.rollup(tasks, service.assignments(tc, p.id))
        out["calibration"] = service.factors(tc)
    out["estimation"] = [{"pack": r.pack, "calibrated": r.estimation.calibrated, "basis": r.estimation.basis}
                         for r in inp.rules]
    return out


# ------------------------------------------------------------------ controls (E11.F3.S1)

@router.get("/projects/{project_id}/plan/controls")
def control_matrix(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id)
    try:
        inp = service.inputs(s, p.id)
    except PlanError as e:
        raise _plan_error(e) from e
    with store.connect(t) as tc:
        tasks = store.items(tc, p.id, "task")
    rows = controls.matrix(inp.compliance, tasks)
    for r in rows:
        r["control_task_exists"] = r["control_task"] in tasks
    return {"packs": [m.ref for m in inp.compliance], "controls": rows,
            "complete": all(r["control_task_exists"] and r["gates"] for r in rows)}


# ------------------------------------------------------------------ waves (E11.F3.S2)

class WaveIn(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    start: date
    end: date
    cutover: date | None = None
    capacity: dict[Literal[ROLES], float] = Field(default_factory=dict)  # type: ignore[valid-type]


@router.get("/projects/{project_id}/plan/waves")
def get_waves(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id)
    with store.connect(t) as tc:
        return {"waves": [{"key": k, **w} for k, w in service.ordered_waves(tc, p.id)],
                "pins": store.items(tc, p.id, "pin"), "plan": store.get(tc, p.id, "wave_plan", "current"),
                "roles": list(ROLES)}


@router.put("/projects/{project_id}/plan/waves/{key}")
def put_wave(project_id: uuid.UUID, key: Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")],
             body: WaveIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}", key):
        raise invalid("key", "Use letters, digits, '-' or '_' (up to 40).")
    if body.end < body.start:
        raise invalid("end", "A wave ends on or after its start.")
    if any(v < 0 for v in body.capacity.values()):
        raise invalid("capacity", "Capacity cannot be negative.")
    with store.connect(t) as tc, tc.transaction():
        store.put(tc, p.id, "wave", key, body.model_dump(mode="json"), principal.user.display_name)
    audit.record(s, principal.actor, "plan.wave_saved", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"wave": key, **body.model_dump(mode="json")})
    return get_waves(project_id, principal, s)


@router.delete("/projects/{project_id}/plan/waves/{key}")
def delete_wave(project_id: uuid.UUID, key: str, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    with store.connect(t) as tc, tc.transaction():
        if not store.delete(tc, p.id, "wave", key):
            raise not_found("Wave")
    audit.record(s, principal.actor, "plan.wave_deleted", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"wave": key})
    return get_waves(project_id, principal, s)


class PinIn(BaseModel):
    scope_key: str
    wave: str | None = Field(description="null removes the pin")


@router.post("/projects/{project_id}/plan/pins")
def pin(project_id: uuid.UUID, body: PinIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    with store.connect(t) as tc:
        if store.get(tc, p.id, "scope", body.scope_key) is None:
            raise invalid("scope_key", "Not in the scope register.")
        with tc.transaction():
            if body.wave is None:
                store.delete(tc, p.id, "pin", body.scope_key)
            else:
                if store.get(tc, p.id, "wave", body.wave) is None:
                    raise invalid("wave", "No such wave.")
                store.put(tc, p.id, "pin", body.scope_key, {"wave": body.wave, **_who(principal)},
                          principal.user.display_name)
    return get_waves(project_id, principal, s)


@router.post("/projects/{project_id}/plan/waves/solve")
def solve(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Place every scope item in a wave with the constraint solver; report every broken constraint and the options
    that would make the plan fit. No work is dropped."""
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    try:
        inp = service.inputs(s, p.id)
        with store.connect(t) as tc:
            res = service.solve_waves(s, tc, inp, p.id, principal.user.display_name)
    except PlanError as e:
        raise _plan_error(e) from e
    audit.record(s, principal.actor, "plan.waves_solved", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"fits": res["fits"], "broken": len(res["broken"]),
                                               "status": res["status"]})
    return res


# ------------------------------------------------------------------ risks (E11.F3.S3)

class RiskIn(BaseModel):
    title: str = Field(min_length=5, max_length=300)
    detail: str = Field(default="", max_length=4000)
    likelihood: int = Field(ge=1, le=5)
    impact: int = Field(ge=1, le=5)
    owner_user_id: uuid.UUID | None = None
    mitigation_task: str | None = None


class RiskPatch(BaseModel):
    status: Literal["accepted", "rejected", "closed"] | None = None
    likelihood: int | None = Field(default=None, ge=1, le=5)
    impact: int | None = Field(default=None, ge=1, le=5)
    owner_user_id: uuid.UUID | None = None
    mitigation_task: str | None = None
    note: str = Field(default="", max_length=2000)


def _risk_out(s: Session, k: str, r: dict[str, Any]) -> dict[str, Any]:
    return {"key": k, **r, "score": int(r["likelihood"]) * int(r["impact"]),
            "owner_name": _user_name(s, r.get("owner_user_id"))}


@router.get("/projects/{project_id}/plan/risks")
def risks(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    t, p = _ctx(s, principal, project_id)
    with store.connect(t) as tc:
        rs = store.items(tc, p.id, "risk")
    return sorted((_risk_out(s, k, r) for k, r in rs.items()), key=lambda r: (-r["score"], r["key"]))


@router.post("/projects/{project_id}/plan/risks", status_code=201)
def add_risk(project_id: uuid.UUID, body: RiskIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """A risk a person records is accepted into the register; risks the planner or agents find arrive as
    proposals that a person accepts or rejects."""
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    _person(s, body.owner_user_id, "owner_user_id")
    with store.connect(t) as tc:
        if body.mitigation_task and store.get(tc, p.id, "task", body.mitigation_task) is None:
            raise invalid("mitigation_task", "No such task in the plan.")
        n = 1 + len([k for k in store.items(tc, p.id, "risk") if k.startswith("R-")])
        key = f"R-{n:03d}"
        r = {"title": body.title.strip(), "detail": body.detail.strip(), "likelihood": body.likelihood,
             "impact": body.impact, "owner_user_id": str(body.owner_user_id) if body.owner_user_id else None,
             "mitigation_task": body.mitigation_task, "status": "accepted", "source": "person",
             "decision": {**_who(principal), "note": "Recorded by a person."}}
        with tc.transaction():
            store.put(tc, p.id, "risk", key, r, principal.user.display_name)
    audit.record(s, principal.actor, "plan.risk_added", tenant_id=t.id, project_id=p.id, target_type="risk",
                 target_id=key, details={"title": r["title"], "score": body.likelihood * body.impact})
    return _risk_out(s, key, r)


@router.patch("/projects/{project_id}/plan/risks/{key}")
def update_risk(project_id: uuid.UUID, key: str, body: RiskPatch, principal: CurrentPrincipal, s: DB
                ) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    with store.connect(t) as tc:
        r = store.get(tc, p.id, "risk", key)
        if r is None:
            raise not_found("Risk")
        if body.status in ("accepted", "rejected") and r["status"] != "proposed":
            raise conflict(f"The risk is already {r['status']}.")
        if body.status == "closed" and r["status"] != "accepted":
            raise conflict("Only accepted risks can be closed.")
        if body.status and len(body.note.strip()) < 5:
            raise invalid("note", "Say why.")
        if "owner_user_id" in body.model_fields_set:
            _person(s, body.owner_user_id, "owner_user_id")
            r["owner_user_id"] = str(body.owner_user_id) if body.owner_user_id else None
        if body.mitigation_task is not None:
            if store.get(tc, p.id, "task", body.mitigation_task) is None:
                raise invalid("mitigation_task", "No such task in the plan.")
            r["mitigation_task"] = body.mitigation_task
        for f in ("likelihood", "impact"):
            if getattr(body, f) is not None:
                r[f] = getattr(body, f)
        if body.status:
            r["status"] = body.status
            r["decision"] = {**_who(principal), "note": body.note.strip()}
        with tc.transaction():
            store.put(tc, p.id, "risk", key, r, principal.user.display_name)
    audit.record(s, principal.actor, "plan.risk_updated", tenant_id=t.id, project_id=p.id, target_type="risk",
                 target_id=key, details=body.model_dump(mode="json", exclude_unset=True))
    return _risk_out(s, key, r)


# ------------------------------------------------------------------ cutover (E11.F4) and coexistence (E15.F1)

class Assumptions(BaseModel):
    extract_hours: float | None = Field(default=None, ge=0, le=1000)
    reconciliation_minutes_per_entity: float | None = Field(default=None, ge=0, le=10_000)
    parallel_run_weeks: float | None = Field(default=None, ge=0, le=104)
    parallel_hours_per_day: float | None = Field(default=None, ge=0, le=24)
    switch_minutes: float | None = Field(default=None, ge=0, le=10_000)

    def given(self) -> dict[str, float]:
        return {str(k): float(v) for k, v in self.model_dump().items() if v is not None}


def _cutover_ctx(s: Session, principal: Principal, project_id: uuid.UUID, perm: P | None, a: dict[str, float]
                 ) -> tuple[Tenant, Project, Any, cutover.Inputs, dict[str, Any]]:
    t, p = _ctx(s, principal, project_id, perm)
    try:
        inp = service.inputs(s, p.id)
    except PlanError as e:
        raise _plan_error(e) from e
    with store.connect(t) as tc:
        ci = service.cutover_inputs(s, tc, inp, p.id, a)
        co = service.coexistence(tc, ci, p.id)
    return t, p, inp, ci, co


@router.post("/projects/{project_id}/plan/cutover/compare")
def compare_cutover(project_id: uuid.UUID, body: Assumptions, principal: CurrentPrincipal, s: DB
                    ) -> dict[str, Any]:
    """Whole-estate, phased and parallel-run cutover side by side: duration, effort, risk and constraints."""
    _, p, inp, ci, co = _cutover_ctx(s, principal, project_id, None, body.given())
    return {"options": cutover.compare(ci, co["complete"]),
            "assumptions": {**cutover.DEFAULT_ASSUMPTIONS, **body.given()},
            "inputs": {"entities": [e.__dict__ for e in ci.entities], "requests_per_minute": ci.requests_per_minute,
                       "loads_blocked": ci.loads_blocked, "window_hours": ci.window_hours, "waves": ci.waves,
                       "blueprint_strategy": inp.cutover_strategy}}


class ChoiceIn(BaseModel):
    option: Literal["whole_estate", "phased", "parallel_run"]
    reason: str = Field(min_length=15, max_length=4000)
    assumptions: Assumptions = Field(default_factory=Assumptions)


@router.put("/projects/{project_id}/plan/cutover/choice")
def choose_cutover(project_id: uuid.UUID, body: ChoiceIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Record the chosen strategy with its reason and the comparison it was chosen from."""
    t, p, _, ci, co = _cutover_ctx(s, principal, project_id, P.STAGE_MANAGE, body.assumptions.given())
    comparison = cutover.compare(ci, co["complete"])
    choice: dict[str, Any] = {"option": body.option, "reason": body.reason.strip(), **_who(principal),
              "assumptions": {**cutover.DEFAULT_ASSUMPTIONS, **body.assumptions.given()},
              "comparison": comparison}
    with store.connect(t) as tc, tc.transaction():
        store.put(tc, p.id, "cutover_choice", "current", choice, principal.user.display_name)
    audit.record(s, principal.actor, "plan.cutover_chosen", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"option": body.option, "reason": body.reason.strip()})
    return choice


@router.post("/projects/{project_id}/plan/runbook/generate")
def generate_runbook(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    with store.connect(t) as tc:
        choice = store.get(tc, p.id, "cutover_choice", "current")
    if choice is None:
        raise conflict("Choose a cutover strategy first", "The runbook follows the chosen strategy.")
    _, _, _, ci, _ = _cutover_ctx(s, principal, project_id, None, choice.get("assumptions") or {})
    a = {**cutover.DEFAULT_ASSUMPTIONS, **(choice.get("assumptions") or {})}
    steps = cutover.runbook(choice["option"], ci, a)
    with store.connect(t) as tc:
        old = store.items(tc, p.id, "runbook_step")
        rows = {}
        for n, st in enumerate(steps):
            prev = old.get(st["key"])
            if prev and prev.get("rehearsals"):
                st = {**st, "rehearsals": prev["rehearsals"], "planned_minutes": prev["planned_minutes"]}
            rows[st["key"]] = {**st, "order": n, "rehearsals": st.get("rehearsals", [])}
        with tc.transaction():
            store.put_many(tc, p.id, "runbook_step", rows, principal.user.display_name, replace=True)
    audit.record(s, principal.actor, "plan.runbook_generated", tenant_id=t.id, project_id=p.id,
                 target_type="project", target_id=str(p.id), details={"option": choice["option"],
                                                                      "steps": len(rows)})
    return runbook(project_id, principal, s)


@router.get("/projects/{project_id}/plan/runbook")
def runbook(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id)
    with store.connect(t) as tc:
        steps = sorted(store.items(tc, p.id, "runbook_step").values(), key=lambda x: x["order"])
        choice = store.get(tc, p.id, "cutover_choice", "current")
    main = [x for x in steps if x["kind"] != "rollback"]
    return {"option": choice["option"] if choice else None, "steps": steps,
            "planned_hours": round(sum(float(x["planned_minutes"] or 0) for x in main) / 60, 2),
            "unknown_durations": [x["key"] for x in steps if x["planned_minutes"] is None]}


class RehearsalIn(BaseModel):
    name: str = Field(min_length=2, max_length=60, pattern=r"^[A-Za-z0-9][A-Za-z0-9 ._-]*$")
    timings: dict[str, float] = Field(min_length=1, description="Step key to minutes taken in the rehearsal")


@router.post("/projects/{project_id}/plan/runbook/rehearsals")
def record_rehearsal(project_id: uuid.UUID, body: RehearsalIn, principal: CurrentPrincipal, s: DB
                     ) -> dict[str, Any]:
    """Rehearsal timings replace each step's planned duration; the history and the first estimate are kept."""
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    with store.connect(t) as tc:
        steps = store.items(tc, p.id, "runbook_step")
        unknown = [k for k in body.timings if k not in steps]
        if unknown:
            raise invalid("timings", f"Not runbook steps: {', '.join(unknown[:5])}")
        if any(v < 0 for v in body.timings.values()):
            raise invalid("timings", "Minutes cannot be negative.")
        with tc.transaction():
            for k, minutes in body.timings.items():
                tc.execute("INSERT INTO estate.rehearsal_timings(project_id, rehearsal, step_key, minutes, "
                           "recorded_by) VALUES (%s,%s,%s,%s,%s) ON CONFLICT (project_id, rehearsal, step_key) DO "
                           "UPDATE SET minutes = excluded.minutes, recorded_by = excluded.recorded_by, "
                           "recorded_at = now()", (p.id, body.name, k, minutes, principal.user.display_name))
                st = steps[k]
                hist = [h for h in st.get("rehearsals", []) if h["rehearsal"] != body.name]
                hist.append({"rehearsal": body.name, "minutes": minutes, **_who(principal)})
                store.put(tc, p.id, "runbook_step", k, {**st, "rehearsals": hist, "planned_minutes": minutes},
                          principal.user.display_name)
    audit.record(s, principal.actor, "plan.rehearsal_recorded", tenant_id=t.id, project_id=p.id,
                 target_type="project", target_id=str(p.id), details={"rehearsal": body.name,
                                                                      "steps": len(body.timings)})
    return runbook(project_id, principal, s)


@router.get("/projects/{project_id}/plan/coexistence")
def get_coexistence(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    *_, co = _cutover_ctx(s, principal, project_id, None, {})
    return co


class CoexistenceIn(BaseModel):
    entity: str = Field(min_length=1, max_length=100)
    wave: str = Field(min_length=1, max_length=40)
    system_of_record: Literal["source", "target"]
    end_date: date
    exit_reconciliation: str = Field(min_length=10, max_length=4000)


@router.put("/projects/{project_id}/plan/coexistence")
def put_coexistence(project_id: uuid.UUID, body: CoexistenceIn, principal: CurrentPrincipal, s: DB
                    ) -> dict[str, Any]:
    t, p, _, _, co = _cutover_ctx(s, principal, project_id, P.STAGE_MANAGE, {})
    key = f"{body.entity}:{body.wave}"
    if key not in co["needed"]:
        raise invalid("entity", "Coexistence rules are for shared entities (bound to a concept) in every phase but "
                                "the last; this pair is not one.")
    with store.connect(t) as tc, tc.transaction():
        store.put(tc, p.id, "coexistence", key, {**body.model_dump(mode="json"), **_who(principal)},
                  principal.user.display_name)
    audit.record(s, principal.actor, "plan.coexistence_set", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details=body.model_dump(mode="json"))
    return get_coexistence(project_id, principal, s)


# ------------------------------------------------------------------ baselines (E11.F5.S1)

def _baseline_out(s: Session, b: PlanBaseline) -> dict[str, Any]:
    return {"id": str(b.id), "number": b.number, "digest": b.digest, "summary": b.summary, "changes": b.changes,
            "reason": b.reason, "status": b.status, "proposed_by": _user_name(s, b.proposed_by),
            "decided_by": _user_name(s, b.decided_by), "decided_at": b.decided_at, "decision_note": b.decision_note,
            "created_at": b.created_at}


@router.get("/projects/{project_id}/plan/baselines")
def list_baselines(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    _, p = _ctx(s, principal, project_id)
    return [_baseline_out(s, b) for b in s.scalars(select(PlanBaseline).where(PlanBaseline.project_id == p.id)
                                                   .order_by(PlanBaseline.number.desc()))]


def _approved(s: Session, project_id: uuid.UUID) -> PlanBaseline | None:
    return s.scalars(select(PlanBaseline).where(PlanBaseline.project_id == project_id,
                                                PlanBaseline.status == "approved")).first()


def _snapshot_of(tc: Any, baseline_id: uuid.UUID) -> dict[str, dict[str, Any]]:
    row = tc.execute("SELECT items FROM estate.plan_snapshots WHERE baseline_id = %s", (baseline_id,)).fetchone()
    return dict(row[0]) if row else {}


class BaselineIn(BaseModel):
    reason: str = Field(min_length=10, max_length=4000)


@router.post("/projects/{project_id}/plan/baselines", status_code=201)
def propose_baseline(project_id: uuid.UUID, body: BaselineIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Freeze the current plan as a proposed baseline. It shows its changes against the approved one, and needs a
    second person to approve it."""
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    if s.scalar(select(PlanBaseline.id).where(PlanBaseline.project_id == p.id,
                                              PlanBaseline.status == "proposed")) is not None:
        raise conflict("A proposed baseline is waiting for a decision")
    with store.connect(t) as tc:
        items = {k: v for k, v in store.snapshot(tc, p.id).items() if not k.startswith("wave_plan/")}
        if not any(k.startswith("task/") for k in items):
            raise conflict("Generate tasks first", "A baseline freezes a plan with tasks.")
        prev = _approved(s, p.id)
        changes = plan_baseline.diff(_snapshot_of(tc, prev.id), items) if prev else None
        if prev is not None and changes is not None and changes["same"]:
            raise conflict("Nothing changed since the approved baseline")
        number = (s.scalar(select(func.max(PlanBaseline.number)).where(PlanBaseline.project_id == p.id)) or 0) + 1
        b = PlanBaseline(tenant_id=t.id, project_id=p.id, number=number, digest=plan_baseline.digest(items),
                         summary=plan_baseline.summary(items),
                         changes=({"against": prev.number, **changes["counts"]} if prev and changes else {}),
                         reason=body.reason.strip(), status="proposed", proposed_by=principal.user.id)
        s.add(b)
        s.flush()
        with tc.transaction():
            tc.execute("INSERT INTO estate.plan_snapshots(baseline_id, project_id, items) VALUES (%s,%s,%s)",
                       (b.id, p.id, json.dumps(items, default=str)))
    audit.record(s, principal.actor, "plan.baseline_proposed", tenant_id=t.id, project_id=p.id,
                 target_type="plan_baseline", target_id=str(b.id),
                 details={"number": number, "digest": b.digest, "reason": b.reason, "changes": b.changes})
    return _baseline_out(s, b)


class BaselineDecisionIn(BaseModel):
    approve: bool
    note: str = Field(min_length=10, max_length=2000)


@router.post("/plan-baselines/{baseline_id}/decision")
def decide_baseline(baseline_id: uuid.UUID, body: BaselineDecisionIn, principal: CurrentPrincipal, s: DB
                    ) -> dict[str, Any]:
    b = s.get(PlanBaseline, baseline_id, with_for_update=True)
    if b is None:
        raise not_found("Plan baseline")
    t, p = _ctx(s, principal, b.project_id, P.PLAN_APPROVE)
    if b.status != "proposed":
        raise conflict(f"The baseline is {b.status}.")
    if b.proposed_by == principal.user.id:
        raise forbidden("The person who proposed a baseline cannot approve it.")
    if body.approve:
        inp = service.inputs(s, p.id)
        with store.connect(t) as tc:
            snap = _snapshot_of(tc, b.id)
        choice = snap.get("cutover_choice/current")
        phased = (choice or {}).get("option") == "phased" or (not choice and inp.cutover_strategy == "phased")
        if phased:
            _, _, _, ci, co = _cutover_ctx(s, principal, p.id, None, {})
            if not co["complete"]:
                raise Problem(409, "coexistence", "A phased plan needs coexistence rules",
                              "Name a system of record, an end date and an exit reconciliation for every shared "
                              "entity in every phase.",
                              errors=[{"field": w["key"], "message": w["detail"]} for w in co["warnings"]
                                      if w["level"] == "error"][:50])
        old = _approved(s, p.id)
        if old is not None:
            old.status = "superseded"
    b.status = "approved" if body.approve else "rejected"
    b.decided_by, b.decided_at, b.decision_note = principal.user.id, datetime.now(UTC), body.note.strip()
    s.flush()
    audit.record(s, principal.actor, f"plan.baseline_{b.status}", tenant_id=t.id, project_id=p.id,
                 target_type="plan_baseline", target_id=str(b.id),
                 details={"number": b.number, "digest": b.digest, "note": body.note.strip()})
    return _baseline_out(s, b)


@router.get("/projects/{project_id}/plan/diff")
def plan_diff(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
              baseline_id: uuid.UUID | None = None) -> dict[str, Any]:
    """The current plan against a baseline (default: the approved one)."""
    t, p = _ctx(s, principal, project_id)
    b = s.get(PlanBaseline, baseline_id) if baseline_id else _approved(s, p.id)
    if b is None or b.project_id != p.id:
        raise not_found("Baseline")
    with store.connect(t) as tc:
        current = {k: v for k, v in store.snapshot(tc, p.id).items() if not k.startswith("wave_plan/")}
        d = plan_baseline.diff(_snapshot_of(tc, b.id), current)
    return {"baseline": _baseline_out(s, b), **d}


# ------------------------------------------------------------------ exports and actuals (E11.F5.S2)

@router.get("/projects/{project_id}/plan/export")
def export_plan(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB, format: Literal["jira", "ado"],
                target: Annotated[str, Query(min_length=1, max_length=200,
                                             description="Jira project key or Azure DevOps area path")]) -> Response:
    t, p = _ctx(s, principal, project_id)
    with store.connect(t) as tc:
        tasks = store.items(tc, p.id, "task")
    if not tasks:
        raise conflict("Generate tasks first")
    body = exports.jira_csv(tasks, target) if format == "jira" else exports.ado_csv(tasks, target)
    audit.record(s, principal.actor, "plan.exported", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"format": format, "tasks": len(tasks), "target": target})
    return Response(body, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="plan-{format}-{p.id}.csv"'})


class ActualsIn(BaseModel):
    filename: str = Field(min_length=5, max_length=255, pattern=r"(?i)^[^/\\]+\.csv$")
    content_base64: str = Field(min_length=4)


@router.post("/projects/{project_id}/plan/actuals")
def import_actuals(project_id: uuid.UUID, body: ActualsIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Logged effort from a Jira or Azure DevOps export. Matched by task key; it calibrates later estimates."""
    t, p = _ctx(s, principal, project_id, P.STAGE_MANAGE)
    try:
        data = base64.b64decode(body.content_base64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise invalid("content_base64", "The file content is not valid base64.") from e
    if len(data) > MAX_UPLOAD:
        raise invalid("content_base64", "Imports are limited to 25 MB.")
    try:
        rows = exports.parse_actuals(data)
    except exports.ImportError_ as e:
        raise invalid("content_base64", str(e)) from e
    with store.connect(t) as tc:
        tasks = store.items(tc, p.id, "task")
        matched = [(k, h) for k, h in rows if k in tasks]
        with tc.transaction(), tc.cursor() as cur:
            cur.executemany(
                "INSERT INTO estate.plan_actuals(project_id, task_key, rule_id, estimate, hours, source) "
                "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (project_id, task_key) DO UPDATE SET hours = excluded.hours, "
                "source = excluded.source, imported_at = now()",
                [(p.id, k, tasks[k]["evidence"].get("rule"), tasks[k].get("likely"), h, body.filename)
                 for k, h in matched])
    unmatched = [k for k, _ in rows if k not in tasks]
    audit.record(s, principal.actor, "plan.actuals_imported", tenant_id=t.id, project_id=p.id, target_type="project",
                 target_id=str(p.id), details={"file": body.filename, "matched": len(matched),
                                               "unmatched": len(unmatched)})
    return {"rows": len(rows), "matched": len(matched), "unmatched": unmatched[:100],
            "hours": round(sum(h for _, h in matched), 2)}


# ------------------------------------------------------------------ gaps (E19.F1)

class GapIn(BaseModel):
    title: str = Field(min_length=5, max_length=300)
    detail: str = Field(default="", max_length=4000)
    scope_key: str | None = Field(default=None, max_length=400)


class GapPatch(BaseModel):
    route: Literal["configuration", "customer_extension", "vendor_product_change", "process_change"] | None = None
    owner_user_id: uuid.UUID | None = None
    vendor_ref: str | None = Field(default=None, max_length=100)
    blocks_waves: list[str] | None = None
    status: Literal["open", "closed"] | None = None
    close_note: str | None = Field(default=None, max_length=4000)


def _gap_out(s: Session, g: Gap) -> dict[str, Any]:
    return {"id": str(g.id), "project_id": str(g.project_id), "title": g.title, "detail": g.detail,
            "scope_key": g.scope_key, "route": g.route, "owner_user_id": str(g.owner_user_id) if g.owner_user_id
            else None, "owner_name": _user_name(s, g.owner_user_id), "product": g.product, "vendor_ref": g.vendor_ref,
            "blocks_waves": g.blocks_waves, "status": g.status, "close_note": g.close_note,
            "closed_by": _user_name(s, g.closed_by), "closed_at": g.closed_at,
            "created_by": _user_name(s, g.created_by), "created_at": g.created_at}


@router.get("/projects/{project_id}/gaps")
def list_gaps(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB, status: str | None = None
              ) -> list[dict[str, Any]]:
    _, p = _ctx(s, principal, project_id)
    stmt = select(Gap).where(Gap.project_id == p.id)
    if status:
        stmt = stmt.where(Gap.status == status)
    return [_gap_out(s, g) for g in s.scalars(stmt.order_by(Gap.created_at))]


@router.post("/projects/{project_id}/gaps", status_code=201)
def add_gap(project_id: uuid.UUID, body: GapIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = _ctx(s, principal, project_id, P.BLUEPRINT_EDIT)
    if body.scope_key:
        with store.connect(t) as tc:
            if store.get(tc, p.id, "scope", body.scope_key) is None:
                raise invalid("scope_key", "Not in the scope register.")
    g = Gap(tenant_id=t.id, project_id=p.id, title=body.title.strip(), detail=body.detail.strip(),
            scope_key=body.scope_key, blocks_waves=[], status="open", created_by=principal.user.id)
    s.add(g)
    s.flush()
    audit.record(s, principal.actor, "gap.created", tenant_id=t.id, project_id=p.id, target_type="gap",
                 target_id=str(g.id), details={"title": g.title})
    return _gap_out(s, g)


@router.patch("/gaps/{gap_id}")
def update_gap(gap_id: uuid.UUID, body: GapPatch, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Route a gap and give it an owner. A gap cannot close without both (also enforced in the database)."""
    g = s.get(Gap, gap_id, with_for_update=True)
    if g is None:
        raise not_found("Gap")
    t, p = _ctx(s, principal, g.project_id, P.BLUEPRINT_EDIT)
    if g.status == "closed" and body.status != "open":
        raise conflict("The gap is closed.")
    if "owner_user_id" in body.model_fields_set:
        _person(s, body.owner_user_id, "owner_user_id")
        g.owner_user_id = body.owner_user_id
    if body.route is not None:
        g.route = body.route
        if body.route == "vendor_product_change":
            inp = service.inputs(s, p.id)
            g.product = inp.target_ref.split("@")[0] if inp.target_ref else None
    if body.vendor_ref is not None:
        g.vendor_ref = body.vendor_ref.strip() or None
    if body.blocks_waves is not None:
        with store.connect(t) as tc:
            waves = set(store.items(tc, p.id, "wave"))
        bad = [w for w in body.blocks_waves if w not in waves]
        if bad:
            raise invalid("blocks_waves", f"No such wave(s): {', '.join(bad)}")
        g.blocks_waves = sorted(set(body.blocks_waves))
    if body.status == "closed":
        missing = [f for f, v in (("route", g.route), ("owner_user_id", g.owner_user_id)) if not v]
        if missing:
            raise Problem(409, "gap-incomplete", "A gap cannot close without a route and an owner",
                          errors=[{"field": f, "message": "Required before closing."} for f in missing])
        if not (body.close_note or "").strip():
            raise invalid("close_note", "Say how the gap was resolved.")
        g.status, g.close_note = "closed", (body.close_note or "").strip()
        g.closed_by, g.closed_at = principal.user.id, datetime.now(UTC)
    elif body.status == "open":
        g.status, g.closed_by, g.closed_at = "open", None, None
    s.flush()
    audit.record(s, principal.actor, "gap.updated", tenant_id=t.id, project_id=p.id, target_type="gap",
                 target_id=str(g.id), details=body.model_dump(mode="json", exclude_unset=True))
    return _gap_out(s, g)


@router.get("/programmes/{programme_id}/vendor-changes")
def vendor_changes(programme_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
                   format: Literal["json", "csv"] = "json") -> Any:
    """Open vendor product changes across the programme's customers, ranked by the migrations they block
    (E19.F1.S2)."""
    if not (principal.has_platform(P.PROGRAMME_MANAGE)
            or any(g.role == "programme_owner" and g.scope_type == "programme" and g.scope_id == programme_id
                   for g in principal.grants)):
        raise forbidden()
    prog = s.get(Programme, programme_id)
    if prog is None:
        raise not_found("Programme")
    rows = s.execute(select(Gap, Tenant.name, Project.name).join(Tenant, Tenant.id == Gap.tenant_id)
                     .join(Project, Project.id == Gap.project_id)
                     .where(Tenant.programme_id == programme_id, Gap.status == "open",
                            Gap.route == "vendor_product_change")).all()
    groups: dict[str, dict[str, Any]] = {}
    for g, tenant_name, project_name in rows:
        key = (g.vendor_ref or g.title).strip().lower()
        e = groups.setdefault(key, {"change": g.vendor_ref or g.title, "product": g.product, "customers": set(),
                                    "projects": set(), "waves_blocked": 0, "gaps": []})
        e["customers"].add(tenant_name)
        e["projects"].add(project_name)
        e["waves_blocked"] += len(g.blocks_waves)
        e["gaps"].append(str(g.id))
    ranked = sorted(({**e, "customers": sorted(e["customers"]), "projects": sorted(e["projects"]),
                      "customer_count": len(e["customers"])} for e in groups.values()),
                    key=lambda e: (-e["customer_count"], -e["waves_blocked"], e["change"].lower()))
    for i, e in enumerate(ranked):
        e["rank"] = i + 1
    audit.record(s, principal.actor, "gap.vendor_changes_viewed", target_type="programme",
                 target_id=str(programme_id), details={"format": format, "changes": len(ranked)})
    if format == "csv":
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(["rank", "change", "product", "customers_blocked", "waves_blocked", "customers"])
        for e in ranked:
            w.writerow([e["rank"], e["change"], e["product"] or "", e["customer_count"], e["waves_blocked"],
                        "; ".join(e["customers"])])
        return Response(buf.getvalue(), media_type="text/csv", headers={
            "Content-Disposition": f'attachment; filename="vendor-changes-{programme_id}.csv"'})
    return {"programme": prog.name, "changes": ranked}


# ------------------------------------------------------------------ pre-sales (E11.F5.S4)

class PresalesIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    programme_id: uuid.UUID | None = None
    estimation_packs: list[str] = Field(min_length=1, max_length=5)
    questionnaire: presales.Questionnaire
    sample_extract_yaml: str | None = Field(default=None, max_length=20_000_000,
                                            description="Optional estate metadata in astra.baseline/v1 format")


@router.post("/presales-estimates", status_code=201)
def create_presales(body: PresalesIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    if not principal.has_platform(P.PRESALES) and not any(g.role in ("sales_engineer", "migration_lead")
                                                           for g in principal.grants):
        raise forbidden()
    rules = []
    for i, ref in enumerate(body.estimation_packs):
        try:
            pk = registry.get_by_ref(s, ref, published_only=False)
        except ValueError as e:
            raise invalid(f"estimation_packs.{i}", str(e)) from e
        m = registry.manifest_of(pk) if pk else None
        est = estimation.parse(m.content) if m is not None and m.type == PackType.PATTERN else None
        if est is None or m is None:
            raise invalid(f"estimation_packs.{i}", f"{ref} is not a pattern pack with estimation rules.")
        rules.append(estimation.RuleSet(m.ref, est))
    sample = None
    if body.sample_extract_yaml:
        try:
            raw = yaml.safe_load(body.sample_extract_yaml)
            from astra_migrate.adapters.contract import Baseline

            objs = Baseline.model_validate(raw).model_dump(mode="json", by_alias=True)["objects"]
        except (yaml.YAMLError, ValidationError) as e:
            raise invalid("sample_extract_yaml", "The sample extract must be estate metadata in astra.baseline/v1 "
                                                 f"format: {str(e)[:200]}") from e
        sample = presales.sample_counts(objs)
    result = presales.run(body.questionnaire, rules, sample)
    row = PresalesEstimate(name=body.name.strip(), programme_id=body.programme_id,
                         estimation_packs=[r.pack for r in rules], questionnaire=body.questionnaire.model_dump(),
                         sample=sample, result=result, created_by=principal.user.id)
    s.add(row)
    s.flush()
    audit.record(s, principal.actor, "presales.estimated", target_type="presales_estimate", target_id=str(row.id),
                 details={"name": row.name, "likely_hours": result["effort_hours"]["likely"]})
    return _presales_out(s, row)


def _presales_out(s: Session, e: PresalesEstimate) -> dict[str, Any]:
    return {"id": str(e.id), "name": e.name, "programme_id": str(e.programme_id) if e.programme_id else None,
            "estimation_packs": e.estimation_packs, "questionnaire": e.questionnaire, "sample": e.sample,
            "result": e.result, "created_by": _user_name(s, e.created_by), "created_at": e.created_at}


@router.get("/presales-estimates")
def list_presales(principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    if not principal.has_platform(P.PRESALES) and not any(g.role in ("sales_engineer", "migration_lead")
                                                           for g in principal.grants):
        raise forbidden()
    return [_presales_out(s, e) for e in s.scalars(select(PresalesEstimate)
                                                   .order_by(PresalesEstimate.created_at.desc()).limit(100))]


@router.get("/presales-estimates/{estimate_id}")
def get_presales(estimate_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    e = s.get(PresalesEstimate, estimate_id)
    if e is None:
        raise not_found("Pre-sales estimate")
    if not principal.has_platform(P.PRESALES) and e.created_by != principal.user.id:
        raise forbidden()
    return _presales_out(s, e)
