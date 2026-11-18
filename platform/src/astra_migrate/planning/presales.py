"""Pre-sales estimate (E11.F5.S4): a scope outline, waves and an effort range from a questionnaire and, when
given, a sample extract. Clearly an estimate: every assumption is listed, and it uses the same estimation rules
the delivery plan uses."""

from __future__ import annotations

import math
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from astra_migrate.planning.estimation import RuleSet, estimate

LABEL = "ESTIMATE: pre-sales sizing from a questionnaire, not a delivery plan"


class Questionnaire(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tables: int = Field(ge=0, le=1_000_000)
    customer_tables: int = Field(default=0, ge=0, le=1_000_000)
    code_objects: int = Field(default=0, ge=0, le=1_000_000, description="Procedures, functions and triggers")
    reports: int = Field(default=0, ge=0, le=1_000_000)
    interfaces: int = Field(default=0, ge=0, le=100_000)
    configuration_items: int = Field(default=0, ge=0, le=1_000_000)
    rows_millions: float = Field(default=0, ge=0, le=1_000_000)
    avg_columns: float | None = Field(default=None, ge=1, le=5000)
    team_hours_per_week: float = Field(default=200, gt=0, le=100_000)
    wave_weeks: int = Field(default=8, ge=1, le=104)


# The disposition assumed for each kind of element before discovery: stated in the output.
ASSUMED = [("tables", "data", "migrate", "table"), ("customer_tables", "customizations", "rebuild", "table"),
           ("code_objects", "customizations", "rebuild", "procedure"), ("reports", "reports", "rebuild", "view"),
           ("interfaces", "integrations", "rebuild", "interface"),
           ("configuration_items", "configuration", "migrate", "configuration")]


def sample_counts(objects: list[dict[str, Any]]) -> dict[str, Any]:
    tables = [o for o in objects if o.get("type") in ("table", "user_defined_table")]
    code = [o for o in objects if o.get("type") in ("procedure", "function", "trigger")]
    cols = [len(o.get("columns") or []) for o in tables if o.get("columns")]
    return {"tables": len([o for o in tables if o.get("type") == "table"]),
            "customer_tables": len([o for o in tables if o.get("type") == "user_defined_table"]),
            "code_objects": len(code), "reports": len([o for o in objects if o.get("type") == "view"]),
            "avg_columns": round(sum(cols) / len(cols), 1) if cols else None}


def run(q: Questionnaire, rules: list[RuleSet], sample: dict[str, Any] | None) -> dict[str, Any]:
    assumptions: list[str] = []
    counts = q.model_dump()
    if sample:
        for k in ("tables", "customer_tables", "code_objects", "reports"):
            if sample.get(k) is not None and sample[k] > counts[k]:
                assumptions.append(f"{k.replace('_', ' ')}: the sample extract has {sample[k]}, more than the "
                                   f"questionnaire's {counts[k]}; the sample's count is used.")
                counts[k] = sample[k]
        if sample.get("avg_columns") and not q.avg_columns:
            counts["avg_columns"] = sample["avg_columns"]
            assumptions.append(f"Columns per table: {sample['avg_columns']} on average, from the sample extract.")
    if not counts.get("avg_columns"):
        counts["avg_columns"] = 15.0
        assumptions.append("Columns per table: 15 assumed (no sample extract and none given).")
    n_tables = counts["tables"] + counts["customer_tables"]
    rows_per_table = (q.rows_millions * 1_000_000 / n_tables) if n_tables else 0
    assumptions.append(f"Rows are spread evenly: {rows_per_table:,.0f} per table.")
    assumptions.append("No element is assumed unused: discovery usually retires some, which lowers the effort.")
    outline, total = [], {"low": 0.0, "likely": 0.0, "high": 0.0}
    missing = []
    for field, stream, disp, kind in ASSUMED:
        n = int(counts[field])
        if n == 0:
            continue
        est, _rule = estimate(rules, stream, disp, kind, {"columns": counts["avg_columns"], "rows": rows_per_table},
                              {})
        assumptions.append(f"{field.replace('_', ' ')} are assumed to {disp.replace('_', ' ')}.")
        if est is None:
            missing.append(f"{stream}/{disp}")
            outline.append({"elements": field, "count": n, "stream": stream, "disposition": disp, "hours": None})
            continue
        h = {f: round(getattr(est, f) * n, 1) for f in ("low", "likely", "high")}
        for f in total:
            total[f] = round(total[f] + h[f], 1)
        outline.append({"elements": field, "count": n, "stream": stream, "disposition": disp, "hours": h,
                        "rule": est.rule, "pack": est.pack})
    per_wave = q.team_hours_per_week * q.wave_weeks
    waves = max(1, math.ceil(total["likely"] / per_wave)) if total["likely"] else 0
    wave_plan = []
    remaining = total["likely"]
    for i in range(waves):
        take = min(per_wave, remaining)
        wave_plan.append({"wave": f"W{i + 1}", "weeks": q.wave_weeks, "likely_hours": round(take, 1)})
        remaining -= take
    return {"label": LABEL, "scope_outline": outline, "effort_hours": total,
            "waves": wave_plan, "duration_weeks": waves * q.wave_weeks,
            "assumptions": assumptions, "unestimated": missing,
            "basis": [{"pack": r.pack, "calibrated": r.estimation.calibrated, "basis": r.estimation.basis}
                      for r in rules]}
