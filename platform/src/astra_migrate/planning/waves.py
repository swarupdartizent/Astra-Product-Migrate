"""Waves checked by a constraint solver (E11.F3.S2).

People define waves (dates, cutover day, capacity per role) and may pin scope items to a wave. OR-Tools CP-SAT
assigns every scope item to exactly one wave so that:
  - each item comes no earlier than the items it depends on (hard);
  - work per role per wave fits the wave's capacity (soft: overflow is measured, never hidden);
  - pins are kept (soft: a broken pin is reported).
Nothing is ever dropped: when the plan does not fit, the solver reports every broken constraint and the options
that would make it fit (more capacity, another wave, a different cutover date). Calendar checks (cutover inside
a freeze period or outside its wave, finishing after the target date) are reported alongside.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Any

from ortools.sat.python import cp_model

SOLVE_SECONDS = 20.0


def _d(v: Any) -> date | None:
    if v is None or isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def calendar_checks(waves: list[tuple[str, dict[str, Any]]], freezes: list[dict[str, Any]],
                    target_completion: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    broken: list[dict[str, Any]] = []
    options: list[dict[str, Any]] = []
    for key, w in waves:
        start, end, cut = _d(w.get("start")), _d(w.get("end")), _d(w.get("cutover"))
        if start and end and end < start:
            broken.append({"constraint": "wave_dates", "wave": key, "detail": f"Wave {key} ends before it starts."})
        if cut and start and end and not start <= cut <= end:
            broken.append({"constraint": "cutover_in_wave", "wave": key,
                           "detail": f"Cutover {cut} is outside wave {key} ({start} to {end})."})
        for f in freezes:
            fs, fe = _d(f.get("start")), _d(f.get("end"))
            if cut and fs and fe and fs <= cut <= fe:
                broken.append({"constraint": "freeze_period", "wave": key,
                               "detail": f"Cutover {cut} of wave {key} falls in the freeze period {fs} to {fe}"
                                         + (f" ({f.get('reason')})" if f.get("reason") else "") + "."})
                options.append({"option": "move_cutover", "wave": key, "to": str(fe + timedelta(days=1)),
                                "detail": f"Move wave {key}'s cutover to {fe + timedelta(days=1)}, after the freeze."})
    tc = _d(target_completion)
    ends = [d for d in (_d(w.get("end")) for _, w in waves) if d is not None]
    last = max(ends) if ends else None
    if tc and last and last > tc:
        broken.append({"constraint": "target_completion", "wave": None,
                       "detail": f"The last wave ends {last}, after the target completion date {tc}."})
        options.append({"option": "move_target", "detail": f"Agree a target completion of {last} or later, or "
                                                            "shorten the waves."})
    return broken, options


def solve(items: dict[str, dict[str, float]], deps: list[tuple[str, str]],
          waves: list[tuple[str, dict[str, Any]]], pins: dict[str, str]) -> dict[str, Any]:
    """items: scope key -> hours per role. waves: ordered (key, {capacity: {role: hours}})."""
    if not waves:
        return {"status": "no_waves", "fits": False, "assignments": {}, "broken": [
            {"constraint": "waves", "wave": None, "detail": "No waves are defined."}], "options": [
            {"option": "add_wave", "detail": "Define at least one wave with dates and capacity."}], "load": {}}
    m = cp_model.CpModel()
    keys = sorted(items)
    W = range(len(waves))
    roles = sorted({r for h in items.values() for r in h} | {r for _, w in waves for r in w.get("capacity", {})})
    x = {(i, w): m.new_bool_var(f"x_{n}_{w}") for n, i in enumerate(keys) for w in W}
    idx = {}
    for n, i in enumerate(keys):
        m.add_exactly_one(x[i, w] for w in W)
        idx[i] = m.new_int_var(0, len(waves) - 1, f"idx_{n}")
        m.add(idx[i] == sum(w * x[i, w] for w in W))
    for src, dst in deps:
        if src in idx and dst in idx and src != dst:
            m.add(idx[src] >= idx[dst])
    total = int(sum(math.ceil(h) for hs in items.values() for h in hs.values())) + 1
    slack = {}
    for w in W:
        cap = waves[w][1].get("capacity", {})
        for r in roles:
            demand = [(math.ceil(items[i].get(r, 0)), x[i, w]) for i in keys if items[i].get(r, 0) > 0]
            if not demand:
                continue
            s = m.new_int_var(0, total, f"slack_{w}_{r}")
            slack[w, r] = s
            m.add(sum(h * v for h, v in demand) <= int(cap.get(r, 0)) + s)
    wave_index = {k: n for n, (k, _) in enumerate(waves)}
    pin_miss = []
    for i, wk in pins.items():
        if i in idx and wk in wave_index:
            pin_miss.append(1 - x[i, wave_index[wk]])
    m.minimize(1000 * sum(slack.values()) + 100_000 * sum(pin_miss) + sum(idx.values()))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = SOLVE_SECONDS
    solver.parameters.num_workers = 4
    status: Any = solver.solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        cyc = "Dependencies cannot be ordered across waves." if status == cp_model.INFEASIBLE else \
            "The solver found no assignment in time."
        return {"status": solver.status_name().lower(), "fits": False, "assignments": {},
                "broken": [{"constraint": "dependencies", "wave": None, "detail": cyc}], "options": [], "load": {}}
    assign = {i: waves[solver.value(idx[i])][0] for i in keys}
    broken: list[dict[str, Any]] = []
    options: list[dict[str, Any]] = []
    load: dict[str, dict[str, dict[str, float]]] = {}
    for w in W:
        wk, wd = waves[w]
        for r in roles:
            used = sum(items[i].get(r, 0) for i in keys if assign[i] == wk)
            if used or wd.get("capacity", {}).get(r):
                load.setdefault(wk, {})[r] = {"hours": round(used, 1),
                                              "capacity": float(wd.get("capacity", {}).get(r, 0))}
            over_h = int(solver.value(slack[w, r])) if (w, r) in slack else 0
            if over_h > 0:
                broken.append({"constraint": "capacity", "wave": wk, "role": r, "over_by_hours": over_h,
                               "detail": f"Wave {wk} needs {over_h} more {r} hour(s) than its capacity."})
                options.append({"option": "add_capacity", "wave": wk, "role": r, "hours": over_h,
                                "detail": f"Add {over_h} hour(s) of {r} capacity to wave {wk}."})
    over = sum(o["hours"] for o in options if o["option"] == "add_capacity")
    if over:
        options.append({"option": "add_wave", "hours": over,
                        "detail": f"Add a wave after {waves[-1][0]} for about {over} hour(s) of work, and let the "
                                  "solver move work into it."})
    for i, wk in sorted(pins.items()):
        if i in assign and assign[i] != wk:
            broken.append({"constraint": "pin", "wave": wk, "item": i,
                           "detail": f"{i} is pinned to wave {wk} but its dependencies place it in {assign[i]}."})
            options.append({"option": "unpin", "item": i, "detail": f"Unpin {i} or move its dependencies earlier."})
    return {"status": solver.status_name().lower(), "fits": not broken, "assignments": assign,
            "broken": broken, "options": options, "load": load, "objective": solver.objective_value}
