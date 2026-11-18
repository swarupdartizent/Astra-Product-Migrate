"""Plan baselines and re-plan diffs (E11.F5.S1)."""

from __future__ import annotations

import hashlib
import json
from typing import Any

# Volatile fields that do not change what the plan says.
IGNORED = {"solved_at", "objective", "evidence"}


def _clean(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items() if k not in IGNORED}
    if isinstance(v, list):
        return [_clean(x) for x in v]
    return v


def digest(items: dict[str, dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(_clean(items), sort_keys=True, default=str).encode()).hexdigest()


def summary(items: dict[str, dict[str, Any]]) -> dict[str, Any]:
    kinds: dict[str, int] = {}
    hours = {"low": 0.0, "likely": 0.0, "high": 0.0}
    for k, b in items.items():
        kind = k.split("/", 1)[0]
        kinds[kind] = kinds.get(kind, 0) + 1
        if kind == "task":
            for f in hours:
                hours[f] = round(hours[f] + float(b.get(f) or 0), 1)
    return {"items": kinds, "hours": hours}


def _fields(a: dict[str, Any], b: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for f in sorted(set(a) | set(b)):
        if f in IGNORED:
            continue
        if _clean(a.get(f)) != _clean(b.get(f)):
            out.append({"field": f, "before": a.get(f), "after": b.get(f)})
    return out


def diff(before: dict[str, dict[str, Any]], after: dict[str, dict[str, Any]]) -> dict[str, Any]:
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = []
    for k in sorted(set(before) & set(after)):
        f = _fields(before[k], after[k])
        if f:
            changed.append({"item": k, "fields": f[:20]})
    by_kind: dict[str, dict[str, int]] = {}
    groups: list[tuple[str, list[str]]] = [("added", added), ("removed", removed),
                                           ("changed", [str(c["item"]) for c in changed])]
    for what, names in groups:
        for k in names:
            by_kind.setdefault(k.split("/", 1)[0], {"added": 0, "removed": 0, "changed": 0})[what] += 1
    return {"added": added[:500], "removed": removed[:500], "changed": changed[:500], "by_kind": by_kind,
            "counts": {"added": len(added), "removed": len(removed), "changed": len(changed)},
            "same": not (added or removed or changed)}
