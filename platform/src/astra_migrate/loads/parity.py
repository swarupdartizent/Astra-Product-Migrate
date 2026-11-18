"""Parity comparisons (E14.F2.S1, S3, S4): results produced by both systems, compared case by case.

The source and target results are files (CSV or a JSON array of objects), for example re-rated premiums, report
outputs, workflow replay outcomes or a closed accounting period. A spec names the key fields and the fields to
compare: amounts are compared to the cent, numbers exactly, text exactly after trimming. Every difference keeps the
case's inputs and both outputs; a person approves a difference (with their name recorded) or marks it fixed.
Reports and period closes also compare each amount's grand total to the cent.
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

KIND_FIELDS = {  # what each kind must compare, at least one of
    "rating": "premium or rated amounts",
    "report": "report columns, with totals to the cent",
    "workflow": "tasks, routing and outcome",
    "period_close": "ledger, receivables, payables and commissions",
}
MAX_ROWS = 200_000
CENT = Decimal("0.01")


class FieldSpec(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: Literal["money", "number", "text"] = "text"
    target_name: str | None = Field(default=None, max_length=200, description="When the target names it differently")


class Spec(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=10)
    fields: list[FieldSpec] = Field(min_length=1, max_length=100)
    inputs: list[str] = Field(default_factory=list, max_length=50, description="Fields shown as the case's inputs")

    @model_validator(mode="after")
    def _distinct(self) -> Spec:
        names = [f.name for f in self.fields]
        if len(set(names)) != len(names) or set(names) & set(self.keys):
            raise ValueError("compared fields must be distinct and not keys")
        return self


class ParityInputError(ValueError):
    pass


def parse(data: bytes, name: str) -> list[dict[str, Any]]:
    text = data.decode("utf-8-sig")
    if name.lower().endswith(".json"):
        try:
            rows: Any = json.loads(text)
        except ValueError as e:
            raise ParityInputError(f"{name} is not valid JSON: {e}") from e
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise ParityInputError(f"{name} must be a JSON array of objects.")
    elif name.lower().endswith(".csv"):
        rows = list(csv.DictReader(io.StringIO(text)))
    else:
        raise ParityInputError("Use a .csv or .json file.")
    if len(rows) > MAX_ROWS:
        raise ParityInputError(f"{name} has more than {MAX_ROWS} rows.")
    return [dict(r) for r in rows]


def _norm(v: Any, t: str) -> str | None:
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return None
    if t in ("money", "number"):
        try:
            d = Decimal(str(v).replace(",", "").strip())
        except InvalidOperation:
            return f"not a number: {v}"
        return str(d.quantize(CENT, rounding=ROUND_HALF_UP)) if t == "money" else str(d.normalize())
    return str(v).strip()


@dataclass
class Case:
    key: str
    kind: str
    field: str
    source: str | None
    target: str | None
    inputs: dict[str, Any]


def compare(kind: str, spec: Spec, source: list[dict[str, Any]], target: list[dict[str, Any]]
            ) -> tuple[list[Case], dict[str, Any]]:
    for side, rows in (("source", source), ("target", target)):
        if rows:
            missing = [k for k in spec.keys if k not in rows[0]]
            if missing:
                raise ParityInputError(f"The {side} file has no key field(s): {', '.join(missing)}")

    def key(r: dict[str, Any]) -> str:
        return "|".join(str(r.get(k, "")).strip() for k in spec.keys)

    src = {key(r): r for r in source}
    tgt = {key(r): r for r in target}
    if len(src) != len(source) or len(tgt) != len(target):
        raise ParityInputError("Key fields must identify each case once in each file.")
    cases: list[Case] = []
    for k in sorted(set(src) | set(tgt)):
        s, t = src.get(k), tgt.get(k)
        inputs = {f: (s or t or {}).get(f) for f in spec.inputs}
        if s is None or t is None:
            cases.append(Case(k, "missing_in_target" if t is None else "missing_in_source", "*", None, None, inputs))
            continue
        for f in spec.fields:
            a, b = _norm(s.get(f.name), f.type), _norm(t.get(f.target_name or f.name), f.type)
            if a != b:
                cases.append(Case(k, "difference", f.name, a, b, inputs))
    totals = {}
    if kind in ("report", "period_close", "rating"):
        for f in spec.fields:
            if f.type != "money":
                continue
            st = sum((Decimal(x) for r in source if (x := _norm(r.get(f.name), "money")) and not x.startswith("not")),
                     Decimal(0))
            tt = sum((Decimal(x) for r in target if (x := _norm(r.get(f.target_name or f.name), "money"))
                      and not x.startswith("not")), Decimal(0))
            totals[f.name] = {"source": str(st), "target": str(tt), "difference": str(tt - st)}
            if st != tt:
                cases.append(Case("TOTAL", "difference", f.name, str(st), str(tt), {}))
    summary = {"cases": len(set(src) | set(tgt)), "differences": len(cases), "totals": totals,
               "missing_in_target": sum(1 for c in cases if c.kind == "missing_in_target"),
               "missing_in_source": sum(1 for c in cases if c.kind == "missing_in_source")}
    return cases, summary
