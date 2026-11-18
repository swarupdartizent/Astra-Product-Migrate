"""Work breakdown (E11.F2.S1) and estimate roll-ups (E11.F2.S2).

Each scope item becomes tasks: one per activity of its estimation rule, split into parts so that no task's
likely estimate exceeds the blueprint's maximum (40 hours at most). Tasks have an owner role, a range, the rule
and past tasks behind it, and dependencies: the activities of an item run in order, and an item's first task
waits for the last task of every item it depends on. Keys are stable, so exports and actuals keep matching.
"""

from __future__ import annotations

import itertools
import math
import re
from typing import Any

from astra_migrate.planning.estimation import RuleSet, estimate
from astra_migrate.planning.scope import effective


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def _split(likely: float, max_hours: int) -> int:
    return max(1, math.ceil(likely / max_hours - 1e-9))


def tasks_for(key: str, item: dict[str, Any], rules: list[RuleSet], factors: dict[str, dict[str, Any]],
              max_hours: int) -> tuple[list[tuple[str, dict[str, Any]]], bool]:
    disp = effective(item)
    est, rule = estimate(rules, item["stream"], disp, item["kind"], item.get("props") or {}, factors)
    if est is None or rule is None:
        return [], False
    out: list[tuple[str, dict[str, Any]]] = []
    for act in rule.activities:
        low, likely, high = est.low * act.share, est.likely * act.share, est.high * act.share
        parts = _split(likely, max_hours)
        for i in range(parts):
            tkey = f"{key}|{_slug(act.name)}|{i + 1}"
            out.append((tkey, {
                "scope": key, "element": item["element"], "stream": item["stream"], "segment": item["segment"],
                "disposition": disp, "approved": item.get("status") == "approved",
                "title": f"{act.name}: {item['element']}" + (f" (part {i + 1} of {parts})" if parts > 1 else ""),
                "activity": act.name, "role": act.role, "part": i + 1, "parts": parts,
                "low": round(low / parts, 1), "likely": round(likely / parts, 1), "high": round(high / parts, 1),
                "evidence": {**est.as_dict(), "rule_sources": [s.reference for s in rule.sources],
                             "share": act.share},
                "depends_on": []}))
    for (prev_k, _), (_, body) in itertools.pairwise(out):
        body["depends_on"].append(prev_k)
    return out, True


def control_tasks(matrix: list[dict[str, Any]], rules: list[RuleSet], factors: dict[str, dict[str, Any]]
                  ) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for row in matrix:
        est, rule = estimate(rules, "process", "migrate", "control", {}, factors)
        key = f"control:{row['control']}"
        out.append((row["control_task"], {
            "scope": key, "element": row["control"], "stream": "process", "segment": "controls",
            "disposition": "migrate", "approved": True, "title": f"Operate control {row['control']}: {row['title']}",
            "activity": "Operate control", "role": row["role"], "part": 1, "parts": 1,
            "low": round(est.low, 1) if est else None, "likely": round(est.likely, 1) if est else None,
            "high": round(est.high, 1) if est else None,
            "evidence": ({**est.as_dict(), "rule_sources": [s.reference for s in rule.sources]} if est and rule
                         else {"rule": None, "note": "No estimation rule covers control operation."}),
            "control": row["control"], "depends_on": []}))
    return out


def build(scope: dict[str, dict[str, Any]], edges: list[tuple[str, str]], rules: list[RuleSet],
          factors: dict[str, dict[str, Any]], max_hours: int, matrix: list[dict[str, Any]]
          ) -> tuple[dict[str, dict[str, Any]], list[str]]:
    tasks: dict[str, dict[str, Any]] = {}
    first: dict[str, str] = {}
    last: dict[str, str] = {}
    unestimated: list[str] = []
    for key in sorted(scope):
        made, ok = tasks_for(key, scope[key], rules, factors, max_hours)
        if not ok:
            unestimated.append(key)
            continue
        for k, b in made:
            tasks[k] = b
        first[key], last[key] = made[0][0], made[-1][0]
    for src, dst in edges:
        if src in first and dst in last and last[dst] not in tasks[first[src]]["depends_on"]:
            tasks[first[src]]["depends_on"].append(last[dst])
    for k, b in control_tasks(matrix, rules, factors):
        tasks[k] = b
    for b in tasks.values():
        b["depends_on"] = sorted(b["depends_on"])
    return tasks, unestimated


def rollup(tasks: dict[str, dict[str, Any]], waves: dict[str, str]) -> dict[str, Any]:
    """Totals by stream, segment and wave (E11.F2.S2). Tasks without an estimate are counted separately."""
    def add(bucket: dict[str, dict[str, float]], name: str, t: dict[str, Any]) -> None:
        b = bucket.setdefault(name, {"low": 0.0, "likely": 0.0, "high": 0.0, "tasks": 0})
        b["tasks"] += 1
        for f in ("low", "likely", "high"):
            b[f] = round(b[f] + float(t.get(f) or 0), 1)

    out: dict[str, Any] = {"total": {}, "by_stream": {}, "by_segment": {}, "by_wave": {}, "by_role": {},
                           "unestimated_tasks": 0}
    for t in tasks.values():
        if t.get("likely") is None:
            out["unestimated_tasks"] += 1
            continue
        add(out["total"], "all", t)
        add(out["by_stream"], t["stream"], t)
        add(out["by_segment"], t["segment"], t)
        add(out["by_role"], t["role"], t)
        add(out["by_wave"], waves.get(t["scope"], "unassigned" if not t["scope"].startswith("control:")
                                      else "programme"), t)
    out["total"] = out["total"].get("all", {"low": 0.0, "likely": 0.0, "high": 0.0, "tasks": 0})
    return out
