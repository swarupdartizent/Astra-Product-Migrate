"""Cutover planning (E11.F4) and coexistence rules (E15.F1).

The comparison of whole-estate, phased and parallel-run cutover is computed from the plan's own evidence: row
counts from discovery, the target adapter's recorded load rate, the waves and their assignments, the cutover window
in the blueprint, and stated assumptions the user can change. Nothing is scored by opinion: each risk factor says
what it is computed from.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

OPTIONS = ("whole_estate", "phased", "parallel_run")
DEFAULT_ASSUMPTIONS: dict[str, float] = {"extract_hours": 2.0, "reconciliation_minutes_per_entity": 30.0,
                                         "parallel_run_weeks": 4.0,
                       "parallel_hours_per_day": 4.0, "switch_minutes": 60.0}


@dataclass
class Entity:
    name: str
    table: str
    concept: str | None
    rows: int | None
    batch_size: int
    wave: str | None


@dataclass
class Inputs:
    entities: list[Entity]
    requests_per_minute: int | None
    loads_blocked: bool
    window_hours: float | None
    waves: list[str]
    go_no_go: list[dict[str, Any]]
    assumptions: dict[str, float] = field(default_factory=dict)


def window_hours(cutover_window: str | None) -> float | None:
    if not cutover_window:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)\s*h", cutover_window, re.IGNORECASE)
    return float(m.group(1)) if m else None


def load_minutes(e: Entity, rpm: int | None) -> float | None:
    if e.rows is None or not rpm:
        return None
    return math.ceil(e.rows / max(1, e.batch_size)) / rpm


def _steps_for(inp: Inputs, entities: list[Entity], prefix: str, a: dict[str, float]) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []

    def step(key: str, title: str, role: str, minutes: float | None, kind: str = "step",
             basis: str = "") -> None:
        steps.append({"key": f"{prefix}{key}", "title": title, "role": role, "planned_minutes":
                      round(minutes, 1) if minutes is not None else None, "estimate_minutes":
                      round(minutes, 1) if minutes is not None else None, "kind": kind, "basis": basis})

    for c in inp.go_no_go:
        step(f"gonogo:{c['key']}", f"Go/no-go: {c['title']}", c.get("role", "migration_lead"), 5, "go_no_go",
             c.get("basis", ""))
    step("freeze", "Freeze changes in the source system", "customer_operations_manager", 15)
    step("extract", "Final extract from the source", "data_sme", a["extract_hours"] * 60,
         basis="assumption: extract_hours")
    for e in entities:
        lm = load_minutes(e, inp.requests_per_minute)
        step(f"load:{e.name}", f"Load {e.name} ({e.rows if e.rows is not None else '?'} rows)", "data_sme", lm,
             basis=(f"{e.rows} rows / batch {e.batch_size} / {inp.requests_per_minute} requests per minute"
                    if lm is not None else "row count or load rate unknown"))
        step(f"reconcile:{e.name}", f"Reconcile {e.name}", "customer_data_owner",
             a["reconciliation_minutes_per_entity"], basis="assumption: reconciliation_minutes_per_entity")
    step("gonogo:open", "Go/no-go: open the target to users", "migration_lead", 30, "go_no_go")
    step("switch", "Switch users to the target", "customer_operations_manager", a["switch_minutes"],
         basis="assumption: switch_minutes")
    for k, title, role in (("rollback:decide", "Rollback: decide within the window, with the customer data owner",
                            "migration_lead"),
                           ("rollback:source", "Rollback: give users write access to the source again",
                            "customer_operations_manager"),
                           ("rollback:target", "Rollback: withdraw users from the target and record the loaded "
                                               "records for the vendor to remove", "data_sme")):
        step(k, title, role, 30, "rollback")
    return steps


def runbook(option: str, inp: Inputs, a: dict[str, float]) -> list[dict[str, Any]]:
    if option == "phased" and inp.waves:
        out: list[dict[str, Any]] = []
        for w in inp.waves:
            ents = [e for e in inp.entities if (e.wave or inp.waves[-1]) == w]
            if ents:
                out += [{**s, "wave": w} for s in _steps_for(inp, ents, f"{w}:", a)]
        return out
    return [{**s, "wave": None} for s in _steps_for(inp, inp.entities, "", a)]


def _window(steps: list[dict[str, Any]]) -> tuple[float | None, bool]:
    """Hours from freeze to switch (rollback steps excluded); False when a step's duration is unknown."""
    known = True
    total = 0.0
    for s in steps:
        if s["kind"] == "rollback":
            continue
        if s["planned_minutes"] is None:
            known = False
            continue
        total += float(s["planned_minutes"])
    return round(total / 60, 2), known


def compare(inp: Inputs, coexistence_ok: bool) -> list[dict[str, Any]]:
    a = {**DEFAULT_ASSUMPTIONS, **inp.assumptions}
    total_rows = sum(e.rows or 0 for e in inp.entities)
    out = []
    for opt in OPTIONS:
        steps = runbook(opt, inp, a)
        longest: float
        share: float | None
        if opt == "phased" and inp.waves:
            windows = []
            for w in inp.waves:
                ws = [s for s in steps if s["wave"] == w]
                if ws:
                    windows.append((w, *_window(ws)))
            longest = max((h or 0 for _, h, _ in windows), default=0.0)
            known = all(k for _, _, k in windows)
            n_windows = len(windows)
            share = max((sum(e.rows or 0 for e in inp.entities if (e.wave or inp.waves[-1]) == w) for w in
                         inp.waves), default=0) / total_rows if total_rows else None
        else:
            hours, known = _window(steps)
            longest = hours or 0.0
            n_windows, share = 1, 1.0 if total_rows else None
        effort_h = round(sum(float(s["planned_minutes"] or 0) for s in steps if s["kind"] != "rollback") / 60, 1)
        if opt == "parallel_run":
            effort_h = round(effort_h + a["parallel_run_weeks"] * 5 * a["parallel_hours_per_day"], 1)
        duration_days = (a["parallel_run_weeks"] * 7) if opt == "parallel_run" else None
        constraints = []
        if inp.window_hours is not None:
            fits = known and longest <= inp.window_hours
            constraints.append({"constraint": "cutover_window", "ok": fits,
                                "detail": f"Longest window {longest} h against the allowed {inp.window_hours} h"
                                          + ("" if known else " (some step durations are unknown)") + "."})
        if opt == "phased":
            constraints.append({"constraint": "coexistence_rules", "ok": coexistence_ok,
                                "detail": "A system of record is named for every shared entity in every phase."
                                if coexistence_ok else "Coexistence rules are missing for some shared entities "
                                                       "and phases."})
            if len(inp.waves) < 2:
                constraints.append({"constraint": "waves", "ok": False,
                                    "detail": "Phased cutover needs at least two waves."})
        if inp.loads_blocked:
            constraints.append({"constraint": "target_loads", "ok": False,
                                "detail": "Loads to the target are Blocked until its load API is documented."})
        factors: list[dict[str, Any]] = [
            {"factor": "blast_radius", "value": round(share, 3) if share is not None else None,
             "detail": "Share of all rows moved in the largest single window (from discovery row counts)."},
            {"factor": "coexistence_periods", "value": max(0, n_windows - 1) if opt == "phased" else
             (1 if opt == "parallel_run" else 0),
             "detail": "Periods where two systems hold live data for the same entities."},
            {"factor": "fits_window", "value": next((c["ok"] for c in constraints
                                                     if c["constraint"] == "cutover_window"), None),
             "detail": "Whether the longest window fits the blueprint's cutover window."},
        ]
        level = 1
        if share is not None:
            level += 2 if share > 0.5 else (1 if share > 0.2 else 0)
        level += 1 if factors[1]["value"] else 0
        level += 1 if factors[2]["value"] is False else 0
        out.append({"option": opt, "windows": n_windows, "longest_window_hours": longest,
                    "durations_known": known, "elapsed_days": duration_days, "effort_hours": effort_h,
                    "risk": min(5, level), "risk_factors": factors, "constraints": constraints,
                    "ok": all(c["ok"] for c in constraints), "steps": len(steps)})
    return out


def coexistence_needed(entities: list[Entity], waves: list[str]) -> list[tuple[str, str]]:
    """(entity, wave) pairs that need a system-of-record rule: every shared entity, every phase but the last."""
    shared = sorted({e.name for e in entities if e.concept})
    return [(e, w) for w in waves[:-1] for e in shared]


def coexistence_warnings(rules: dict[str, dict[str, Any]], needed: list[tuple[str, str]],
                         final_cutover: date | None, today: date) -> list[dict[str, Any]]:
    out = []
    for ent, w in needed:
        r = rules.get(f"{ent}:{w}")
        if r is None:
            out.append({"key": f"{ent}:{w}", "level": "error",
                        "detail": f"No system of record is named for {ent} after wave {w}."})
            continue
        end = date.fromisoformat(str(r["end_date"])[:10]) if r.get("end_date") else None
        if end is None:
            out.append({"key": f"{ent}:{w}", "level": "error", "detail": f"Coexistence for {ent} after wave {w} "
                                                                        "has no end date."})
        elif final_cutover and end < final_cutover:
            out.append({"key": f"{ent}:{w}", "level": "warning",
                        "detail": f"Coexistence for {ent} ends {end}, before the last wave cuts over "
                                  f"({final_cutover}): the end date is at risk."})
        elif end < today:
            out.append({"key": f"{ent}:{w}", "level": "warning",
                        "detail": f"Coexistence for {ent} was due to end {end} and is still in the plan."})
        elif (end - today).days <= 14:
            out.append({"key": f"{ent}:{w}", "level": "warning",
                        "detail": f"Coexistence for {ent} ends in {(end - today).days} day(s); check the exit "
                                  "reconciliation is ready."})
        if not (r.get("exit_reconciliation") or "").strip():
            out.append({"key": f"{ent}:{w}", "level": "error",
                        "detail": f"Coexistence for {ent} after wave {w} has no exit reconciliation."})
    return out
