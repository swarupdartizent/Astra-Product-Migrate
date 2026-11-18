"""Estimation rules (E11.F2.S2): ranges per unit of work, shipped in pattern packs.

A pattern pack's `content.estimation` holds the rules. Each rule covers one stream and disposition (optionally
narrowed to element kinds), gives hours as a low/likely/high range per unit and a fixed part, and splits the work
into activities with owner roles. The pack states its basis and whether it is calibrated; the planner says so on
every estimate. Actual effort that flows back from delivery tools calibrates later estimates (`calibrate`).
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

DISPOSITIONS = ("migrate", "rebuild", "replace_with_standard", "agentify", "archive", "retire")
STREAMS = ("data", "configuration", "customizations", "integrations", "reports", "users_security", "process",
           "agentification", "platform")
ROLES = ("migration_lead", "data_sme", "solution_architect", "test_engineer", "customer_data_owner",
         "customer_it_security_lead", "customer_operations_manager")
MIN_CALIBRATION_SAMPLES = 3


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Range(_M):
    low: float = Field(ge=0)
    likely: float = Field(ge=0)
    high: float = Field(ge=0)

    @model_validator(mode="after")
    def _order(self) -> Range:
        if not self.low <= self.likely <= self.high:
            raise ValueError("a range needs low <= likely <= high")
        return self


class Activity(_M):
    name: str = Field(min_length=3, max_length=80)
    role: Literal[ROLES]  # type: ignore[valid-type]
    share: float = Field(gt=0, le=1)


class SourceRef(_M):
    reference: str = Field(min_length=2)
    url: str | None = None


class EstimationRule(_M):
    id: Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$")]
    stream: Literal[STREAMS]  # type: ignore[valid-type]
    disposition: Literal[DISPOSITIONS]  # type: ignore[valid-type]
    kinds: list[str] = Field(default_factory=list, description="Element kinds this rule is limited to")
    unit: Literal["element", "column", "kilo_rows"] = "element"
    per_unit: Range
    fixed: Range = Range(low=0, likely=0, high=0)
    activities: list[Activity] = Field(min_length=1)
    sources: list[SourceRef] = Field(default_factory=list)

    @model_validator(mode="after")
    def _shares(self) -> EstimationRule:
        if abs(sum(a.share for a in self.activities) - 1.0) > 0.001:
            raise ValueError(f"{self.id}: activity shares must add up to 1")
        return self


class Estimation(_M):
    basis: str = Field(min_length=10, description="Where the numbers come from")
    calibrated: bool = Field(description="False until the numbers have been checked against delivered work")
    rules: list[EstimationRule] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique(self) -> Estimation:
        ids = [r.id for r in self.rules]
        if len(ids) != len(set(ids)):
            raise ValueError("estimation rule ids must be unique")
        return self


def parse(content: dict[str, Any]) -> Estimation | None:
    raw = content.get("estimation")
    return Estimation.model_validate(raw) if raw is not None else None


@dataclass
class RuleSet:
    pack: str
    estimation: Estimation

    def match(self, stream: str, disposition: str, kind: str) -> EstimationRule | None:
        cands = [r for r in self.estimation.rules if r.stream == stream and r.disposition == disposition]
        specific = [r for r in cands if kind in r.kinds]
        general = [r for r in cands if not r.kinds]
        found = specific or general
        return found[0] if found else None


def size_of(rule: EstimationRule, props: dict[str, Any]) -> float:
    if rule.unit == "column":
        return float(props.get("columns") or 1)
    if rule.unit == "kilo_rows":
        return float(props.get("rows") or 0) / 1000.0
    return 1.0


@dataclass
class Estimate:
    rule: str | None
    pack: str | None
    size: float
    unit: str
    low: float
    likely: float
    high: float
    calibration: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"rule": self.rule, "pack": self.pack, "size": round(self.size, 3), "unit": self.unit,
                "low": round(self.low, 1), "likely": round(self.likely, 1), "high": round(self.high, 1),
                "calibration": self.calibration}


def estimate(rules: list[RuleSet], stream: str, disposition: str, kind: str, props: dict[str, Any],
             factors: dict[str, dict[str, Any]]) -> tuple[Estimate | None, EstimationRule | None]:
    for rs in rules:
        rule = rs.match(stream, disposition, kind)
        if rule is None:
            continue
        size = size_of(rule, props)
        low = rule.fixed.low + rule.per_unit.low * size
        likely = rule.fixed.likely + rule.per_unit.likely * size
        high = rule.fixed.high + rule.per_unit.high * size
        cal = factors.get(rule.id, {})
        f = float(cal.get("factor", 1.0))
        return Estimate(rule.id, rs.pack, size, rule.unit, low * f, likely * f, high * f, cal), rule
    return None, None


def calibrate(samples: dict[str, list[tuple[str, float, float]]]) -> dict[str, dict[str, Any]]:
    """rule id -> (task key, estimated likely, actual) samples => a correction factor, once there are enough.
    The factor is the median of actual / estimate; the evidence names the past tasks used."""
    out: dict[str, dict[str, Any]] = {}
    for rule_id, rows in samples.items():
        usable = [(k, est, act) for k, est, act in rows if est and est > 0]
        if len(usable) < MIN_CALIBRATION_SAMPLES:
            out[rule_id] = {"factor": 1.0, "samples": len(usable), "past_tasks": [k for k, _, _ in usable][:10],
                            "note": f"Not calibrated: {len(usable)} past task(s) with actuals; "
                                    f"{MIN_CALIBRATION_SAMPLES} are needed."}
            continue
        factor = statistics.median(act / est for _, est, act in usable)
        out[rule_id] = {"factor": round(factor, 3), "samples": len(usable),
                        "past_tasks": [k for k, _, _ in usable][:10],
                        "note": f"Calibrated on {len(usable)} past task(s): median actual/estimate {factor:.2f}."}
    return out
