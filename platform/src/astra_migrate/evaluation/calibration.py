"""Confidence calibration (E22.F1.S3): how well the confidence an agent or platform rule states matches what
reviewers then decide.

A decided review item scores when it carries a confidence and its suggested option is known: it is *right* when the
reviewer approved exactly the suggested option, and *wrong* when the reviewer rejected it, changed it or approved a
different option. Dismissed items do not score (nobody judged the suggestion). Items without a recorded suggestion
are counted as unscored, never guessed.

Per source it reports the expected calibration error (ECE: the item-weighted mean gap between stated confidence and
observed accuracy over ten equal-width bins), the Brier score, mean confidence against accuracy, the reliability
bins, and the accuracy of the items at or above each review threshold, so a threshold can be set on evidence.
Only counts and rates leave the tenant boundary; no item text is reported.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate.db.models import ReviewItem
from astra_migrate.review.service import DECIDED

BINS = 10
THRESHOLDS = (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95)
MIN_ITEMS = 20  # below this, the figures are shown but marked as too few to trust


@dataclass(frozen=True)
class Scored:
    source: str
    kind: str  # agent | platform
    confidence: float
    right: bool


def suggested_option(r: ReviewItem) -> str | None:
    ctx = r.context or {}
    if ctx.get("suggested"):
        return str(ctx["suggested"])
    if (ctx.get("design") or {}).get("stream") and r.options:
        return str(r.options[0])  # design proposals list their suggestion first (items raised before I14)
    return None


def score_item(r: ReviewItem) -> Scored | None | str:
    """A Scored row, None when the item does not score (open, dismissed, no confidence), or 'unscored' when it was
    judged but its suggestion was not recorded."""
    if r.confidence is None or r.status not in DECIDED or r.status == "dismissed":
        return None
    sug = suggested_option(r)
    if sug is None:
        return "unscored"
    req = r.requested_by or {}
    kind = "agent" if req.get("type") == "agent" else "platform"
    name = str((r.context or {}).get("agent") or req.get("name") or "unknown")
    right = r.status == "resolved" and r.outcome == "approved" and r.resolution == sug
    return Scored(name, kind, float(r.confidence), right)


def summarise(rows: list[Scored]) -> dict[str, Any]:
    """Pure: calibration figures for one source."""
    n = len(rows)
    bins = []
    ece = 0.0
    for b in range(BINS):
        lo, hi = b / BINS, (b + 1) / BINS
        inb = [x for x in rows if lo <= x.confidence < hi or (b == BINS - 1 and x.confidence == 1.0)]
        if not inb:
            bins.append({"low": lo, "high": hi, "items": 0, "mean_confidence": None, "accuracy": None})
            continue
        conf = sum(x.confidence for x in inb) / len(inb)
        bin_acc = sum(1 for x in inb if x.right) / len(inb)
        ece += len(inb) / n * abs(bin_acc - conf)
        bins.append({"low": lo, "high": hi, "items": len(inb), "mean_confidence": round(conf, 4),
                     "accuracy": round(bin_acc, 4)})
    mean_conf = sum(x.confidence for x in rows) / n if n else None
    acc = sum(1 for x in rows if x.right) / n if n else None
    thresholds = []
    for t in THRESHOLDS:
        above = [x for x in rows if x.confidence >= t]
        thresholds.append({"threshold": t, "items": len(above),
                           "accuracy": round(sum(1 for x in above if x.right) / len(above), 4) if above else None})
    gap = (mean_conf - acc) if n and mean_conf is not None and acc is not None else None
    return {"items": n, "right": sum(1 for x in rows if x.right),
            "ece": round(ece, 4) if n else None,
            "brier": round(sum((x.confidence - (1.0 if x.right else 0.0)) ** 2 for x in rows) / n, 4) if n else None,
            "mean_confidence": round(mean_conf, 4) if mean_conf is not None else None,
            "accuracy": round(acc, 4) if acc is not None else None,
            "direction": None if gap is None else "overconfident" if gap > 0.05 else "underconfident" if gap < -0.05
            else "calibrated",
            "enough_items": n >= MIN_ITEMS, "bins": bins, "thresholds": thresholds}


def report(s: Session, *, tenant_id: uuid.UUID | None = None, since: datetime | None = None) -> dict[str, Any]:
    stmt = select(ReviewItem).where(ReviewItem.confidence.is_not(None), ReviewItem.status.in_(DECIDED))
    if tenant_id is not None:
        stmt = stmt.where(ReviewItem.tenant_id == tenant_id)
    if since is not None:
        stmt = stmt.where(ReviewItem.resolved_at >= since)
    by: dict[tuple[str, str], list[Scored]] = {}
    unscored: dict[str, int] = {}
    for r in s.scalars(stmt.execution_options(yield_per=500)):
        sc = score_item(r)
        if sc is None:
            continue
        if sc == "unscored":
            req = r.requested_by or {}
            name = str((r.context or {}).get("agent") or req.get("name") or "unknown")
            unscored[name] = unscored.get(name, 0) + 1
            continue
        assert isinstance(sc, Scored)
        by.setdefault((sc.source, sc.kind), []).append(sc)
    sources = [{"source": name, "kind": kind, **summarise(rows)} for (name, kind), rows in by.items()]
    sources.sort(key=lambda x: (-(x["ece"] or 0), x["source"]))
    return {"sources": sources, "unscored": dict(sorted(unscored.items())), "bins": BINS,
            "min_items": MIN_ITEMS, "thresholds": list(THRESHOLDS),
            "rule": "Right = the reviewer approved exactly the suggested option. Rejected, changed or another "
                    "option = wrong. Dismissed items do not score."}
