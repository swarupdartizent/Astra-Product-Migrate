"""Release gate (E22.F1.S2): evaluate the golden suites, compare with the previous released scorecard, and record
the release as released, or as blocked with what fell."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.api.errors import conflict, forbidden, invalid, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import Release, User
from astra_migrate.evaluation import calibration, engine
from astra_migrate.security.principal import CurrentPrincipal, Principal
from astra_migrate.security.rbac import P

router = APIRouter(tags=["releases"])
DB = Annotated[Session, Depends(get_session)]


def _can(principal: Principal) -> bool:
    return principal.has_platform(P.GOLDEN_RUN)


def _latest(s: Session) -> Release | None:
    return s.scalars(select(Release).where(Release.status == "released").order_by(Release.created_at.desc())).first()


def _out(s: Session, r: Release, full: bool = False) -> dict[str, Any]:
    u = s.get(User, r.recorded_by)
    out = {"id": str(r.id), "name": r.name, "status": r.status, "baseline_release": r.baseline_release,
           "regressions": r.regressions, "improved": r.improved, "reason": r.reason,
           "recorded_by": u.display_name if u else None,
           "created_at": r.created_at.isoformat() if r.created_at else None,
           "engine_digest": r.scorecard.get("engine_digest"),
           "suites": {k: {"digest": v["digest"], "measures": v["measures"]}
                      for k, v in (r.scorecard.get("suites") or {}).items()}}
    if not full:
        out.pop("suites")
    return out


@router.get("/releases")
def list_releases(principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    if not principal.has_platform(P.TENANT_READ) and not _can(principal):
        raise forbidden()
    return {"releases": [_out(s, r) for r in s.scalars(select(Release).order_by(Release.created_at.desc())
                                                         .limit(100))], "can_record": _can(principal)}


@router.get("/releases/evaluation")
def preview(principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Score the golden suites now and compare with the latest released scorecard, without recording."""
    if not _can(principal):
        raise forbidden("You cannot run the release evaluation.")
    card = engine.run()
    base = _latest(s)
    return {"baseline_release": base.name if base else None, **engine.compare(base.scorecard if base else None, card),
            "suites": card["suites"], "engine_digest": card["engine_digest"]}


class ReleaseIn(BaseModel):
    name: str = Field(min_length=2, max_length=60, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    reason: str = Field(min_length=10, max_length=2000)


@router.post("/releases", status_code=201)
def record(body: ReleaseIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Evaluate and record a release. It is released only if no measure of any golden suite fell below the
    previous released scorecard; otherwise it is recorded as blocked, with each regression."""
    if not _can(principal):
        raise forbidden("You cannot record releases.")
    if s.scalar(select(Release.id).where(Release.name == body.name, Release.status == "released")) is not None:
        raise conflict("This release name is already released")
    try:
        card = engine.run()
    except ValueError as e:
        raise invalid("suites", str(e)) from e
    base = _latest(s)
    res = engine.compare(base.scorecard if base else None, card)
    r = Release(name=body.name, status="released" if res["passed"] else "blocked", scorecard=card,
                baseline_release=base.name if base else None, regressions=res["regressions"],
                improved=res["improved"], reason=body.reason.strip(), recorded_by=principal.user.id)
    s.add(r)
    s.flush()
    audit.record(s, principal.actor, f"release.{r.status}", target_type="release", target_id=r.name,
                 details={"baseline": r.baseline_release, "regressions": r.regressions,
                          "improved": len(r.improved), "engine_digest": card["engine_digest"]})
    return _out(s, r, full=True)


@router.get("/releases/{release_id}")
def get_release(release_id: str, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    if not principal.has_platform(P.TENANT_READ) and not _can(principal):
        raise forbidden()
    import uuid as _uuid

    try:
        r = s.get(Release, _uuid.UUID(release_id))
    except ValueError:
        r = None
    if r is None:
        raise not_found("Release")
    return _out(s, r, full=True)


# ------------------------------------------------------------------ confidence calibration (E22.F1.S3)

@router.get("/evaluation/calibration")
def confidence_calibration(principal: CurrentPrincipal, s: DB, tenant_id: uuid.UUID | None = None,
                           since: datetime | None = None) -> dict[str, Any]:
    """How well each agent's and platform rule's stated confidence matches reviewers' decisions: calibration error,
    Brier score, reliability bins and accuracy above each review threshold. Counts and rates only."""
    if not (principal.has_platform(P.GOLDEN_RUN) or principal.has_platform(P.TENANT_READ)):
        raise forbidden("You cannot read evaluation results.")
    return calibration.report(s, tenant_id=tenant_id, since=since)
