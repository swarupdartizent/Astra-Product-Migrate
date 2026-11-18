"""Planning workbench (E16.F2.S1): one view of the plan for the timeline, the task list and the dependency graph,
and edits that re-run the constraint solver.

Edits are applied together in one tenant transaction, then the wave solver runs on the edited plan, so the person
sees immediately which constraints the edit breaks and the options to fix them.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

import psycopg
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from astra_migrate.planning import deps, scope, service, store
from astra_migrate.planning.estimation import ROLES
from astra_migrate.planning.service import PlanError

PLAN_KINDS = ("scope", "edge", "task", "wave", "pin")


class Move(BaseModel):
    op: Literal["move"]
    scope_key: str
    wave: str | None = Field(description="Pin the item to this wave; null lets the solver place it")


class AddDependency(BaseModel):
    op: Literal["add_dependency"]
    src: str = Field(description="The element whose work comes later")
    dst: str = Field(description="The element it depends on")
    reason: str = Field(min_length=10, max_length=2000)


class RemoveDependency(BaseModel):
    op: Literal["remove_dependency"]
    key: str
    reason: str = Field(min_length=10, max_length=2000)


class TaskEdit(BaseModel):
    op: Literal["task"]
    key: str
    role: Literal[ROLES] | None = None  # type: ignore[valid-type]
    low: float | None = Field(default=None, ge=0)
    likely: float | None = Field(default=None, ge=0)
    high: float | None = Field(default=None, ge=0)
    reason: str = Field(min_length=10, max_length=2000)

    @model_validator(mode="after")
    def _something(self) -> TaskEdit:
        if self.role is None and self.low is None and self.likely is None and self.high is None:
            raise ValueError("Change the role or the estimate.")
        return self


Edit = Move | AddDependency | RemoveDependency | TaskEdit


class EditError(Exception):
    def __init__(self, index: int, field: str, message: str) -> None:
        super().__init__(message)
        self.index, self.field = index, field


def _stale(tc: psycopg.Connection[Any], project_id: uuid.UUID) -> bool:
    row = tc.execute(
        "SELECT max(updated_at) FILTER (WHERE kind = ANY(%s)), max(updated_at) FILTER (WHERE kind = 'wave_plan') "
        "FROM estate.plan_items WHERE project_id = %s", (list(PLAN_KINDS), project_id)).fetchone()
    return bool(row and row[0] and (row[1] is None or row[0] > row[1]))


def view(tc: psycopg.Connection[Any], project_id: uuid.UUID) -> dict[str, Any]:
    sc = store.items(tc, project_id, "scope")
    tasks = store.items(tc, project_id, "task")
    edges = store.items(tc, project_id, "edge")
    pins = {k: str(b["wave"]) for k, b in store.items(tc, project_id, "pin").items()}
    waves = service.ordered_waves(tc, project_id)
    plan = store.get(tc, project_id, "wave_plan", "current")
    assign = service.assignments_from(plan)
    act = deps.active(edges)
    depth = deps.order(set(sc), act)
    hours = service.scope_hours(tasks)
    per_scope: dict[str, dict[str, Any]] = {}
    for t in tasks.values():
        a = per_scope.setdefault(t["scope"], {"tasks": 0, "low": 0.0, "likely": 0.0, "high": 0.0, "overridden": 0})
        a["tasks"] += 1
        a["overridden"] += 1 if t.get("override") else 0
        for k in ("low", "likely", "high"):
            a[k] += float(t.get(k) or 0)
    needs: dict[str, list[str]] = {}
    for src, dst in act:
        needs.setdefault(src, []).append(dst)
    items = []
    for k, b in sorted(sc.items()):
        a = per_scope.get(k, {"tasks": 0, "low": 0.0, "likely": 0.0, "high": 0.0, "overridden": 0})
        items.append({"key": k, "element": b["element"], "kind": b["kind"], "stream": b["stream"],
                      "segment": b.get("segment"), "disposition": scope.effective(b), "status": b["status"],
                      "wave": assign.get(k), "pinned_wave": pins.get(k), "depth": depth.get(k, 0),
                      "tasks": a["tasks"], "overridden_tasks": a["overridden"],
                      "low": round(a["low"], 1), "likely": round(a["likely"], 1), "high": round(a["high"], 1),
                      "roles": {r: round(h, 1) for r, h in sorted(hours.get(k, {}).items())},
                      "depends_on": sorted(needs.get(k, []))})
    load = (plan or {}).get("load") or {}
    return {
        "waves": [{"key": k, "name": w.get("name"), "start": w.get("start"), "end": w.get("end"),
                   "cutover": w.get("cutover"), "capacity": w.get("capacity") or {}, "load": load.get(k, {}),
                   "items": sorted(i for i, wk in assign.items() if wk == k)} for k, w in waves],
        "items": items,
        # items with estimated work that the solver has not placed yet, and items with no estimated work at all
        "unplaced": sorted(k for k in sc if k in hours and k not in assign),
        "unestimated": sorted(k for k in sc if k not in hours),
        "edges": [{"key": k, "src": e["src"], "dst": e["dst"], "source": e.get("source"),
                   "kinds": e.get("kinds") or [], "removed": e.get("removed")} for k, e in sorted(edges.items())],
        "cycles": deps.cycles(set(sc), act),
        "plan": plan, "stale": _stale(tc, project_id), "roles": list(ROLES),
    }


def apply(tc: psycopg.Connection[Any], project_id: uuid.UUID, edits: list[Edit], who: dict[str, str],
          by: str, max_task_hours: int) -> list[str]:
    """Apply edits in order inside one transaction. Any invalid edit stops everything (nothing is saved)."""
    done: list[str] = []
    with tc.transaction():
        for i, e in enumerate(edits):
            sc = store.items(tc, project_id, "scope")
            if isinstance(e, Move):
                if e.scope_key not in sc:
                    raise EditError(i, "scope_key", "Not in the scope register.")
                if e.wave is None:
                    store.delete(tc, project_id, "pin", e.scope_key)
                    done.append(f"unpinned {e.scope_key}")
                else:
                    if store.get(tc, project_id, "wave", e.wave) is None:
                        raise EditError(i, "wave", "No such wave.")
                    store.put(tc, project_id, "pin", e.scope_key, {"wave": e.wave, **who}, by)
                    done.append(f"pinned {e.scope_key} to {e.wave}")
            elif isinstance(e, AddDependency):
                if e.src == e.dst:
                    raise EditError(i, "dst", "An element cannot depend on itself.")
                for f, v in (("src", e.src), ("dst", e.dst)):
                    if v not in sc:
                        raise EditError(i, f, "Not in the scope register.")
                key = f"{e.src}->{e.dst}"
                old = store.get(tc, project_id, "edge", key)
                body = ({**old, "removed": None} if old and old.get("source") != "person" else
                        {"src": e.src, "dst": e.dst, "kinds": ["person"], "source": "person", "removed": None,
                         "added": {**who, "reason": e.reason.strip()}})
                store.put(tc, project_id, "edge", key, body, by)
                done.append(f"added dependency {key}")
            elif isinstance(e, RemoveDependency):
                old = store.get(tc, project_id, "edge", e.key)
                if old is None:
                    raise EditError(i, "key", "No such dependency.")
                if old.get("source") == "person":
                    store.delete(tc, project_id, "edge", e.key)
                else:
                    store.put(tc, project_id, "edge", e.key, {**old, "removed": {**who, "reason": e.reason.strip()}},
                              by)
                done.append(f"removed dependency {e.key}")
            else:
                t = store.get(tc, project_id, "task", e.key)
                if t is None:
                    raise EditError(i, "key", "No such task.")
                low = e.low if e.low is not None else t.get("low")
                likely = e.likely if e.likely is not None else t.get("likely")
                high = e.high if e.high is not None else t.get("high")
                if None not in (low, likely, high) and not (low <= likely <= high):  # type: ignore[operator]
                    raise EditError(i, "likely", "An estimate needs low ≤ likely ≤ high.")
                if likely is not None and likely > max_task_hours:
                    raise EditError(i, "likely", f"Tasks are at most {max_task_hours} hours (likely). Split the work "
                                                 "instead.")
                override = {"role": e.role, "low": e.low, "likely": e.likely, "high": e.high,
                            "reason": e.reason.strip(), **who,
                            "original": t.get("override", {}).get("original") or
                            {k: t.get(k) for k in ("role", "low", "likely", "high")}}
                store.put(tc, project_id, "task", e.key, {**t, "role": e.role or t["role"], "low": low,
                                                          "likely": likely, "high": high, "override": override}, by)
                done.append(f"changed task {e.key}")
    return done


def edit_and_solve(s: Session, tc: psycopg.Connection[Any], project_id: uuid.UUID, edits: list[Edit],
                   who: dict[str, str], by: str) -> dict[str, Any]:
    inp = service.inputs(s, project_id)
    done = apply(tc, project_id, edits, who, by, inp.max_task_hours)
    solve_error = None
    try:
        service.solve_waves(s, tc, inp, project_id, by)
    except PlanError as e:
        solve_error = str(e)
    return {"applied": done, "solve_error": solve_error, "solved_at": datetime.now(UTC).isoformat(),
            **view(tc, project_id)}
