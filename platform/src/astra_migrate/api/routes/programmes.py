"""Installed-base programmes (E18): set-up, pods and waves, customers, consent and fleet scans, the Complexity Index,
the portfolio planner, the programme owner's view and commercial metering. Partners only ever see their own
customers."""

from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from astra_migrate import audit, programme
from astra_migrate.api.errors import conflict, forbidden, invalid, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import (
    AdapterRun,
    BandContract,
    BlueprintTemplate,
    CustomerConsent,
    FleetScan,
    Partner,
    Pod,
    PortfolioPlan,
    Programme,
    ProgrammeWave,
    SourceConnection,
    Tenant,
    User,
)
from astra_migrate.packs import registry as pack_registry
from astra_migrate.programme import ProgrammeError
from astra_migrate.security.principal import CurrentPrincipal, Principal
from astra_migrate.security.rbac import P

router = APIRouter(tags=["programmes"])
DB = Annotated[Session, Depends(get_session)]
KEY = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$"


def _err(e: ProgrammeError) -> Exception:
    if e.status == 422:
        return invalid(e.field or "body", str(e))
    if e.status == 403:
        return forbidden(str(e))
    return conflict("The programme cannot be changed this way", str(e))


def _prog(s: Session, principal: Principal, programme_id: uuid.UUID, perm: P
          ) -> tuple[Programme, set[uuid.UUID] | None]:
    prog = s.get(Programme, programme_id)
    if prog is None:
        raise not_found("Programme")
    try:
        return prog, programme.visible_partners(principal, s, programme_id, perm)
    except ProgrammeError as e:
        raise _err(e) from e


def _manage(s: Session, principal: Principal, programme_id: uuid.UUID) -> Programme:
    prog, partners = _prog(s, principal, programme_id, P.PROGRAMME_MANAGE)
    if partners is not None:
        raise forbidden("Only the programme owner changes the programme.")
    return prog


def _detail(s: Session, principal: Principal, prog: Programme, partners: set[uuid.UUID] | None) -> dict[str, Any]:
    ps = [p for p in s.scalars(select(Partner).where(Partner.programme_id == prog.id).order_by(Partner.name))
          if partners is None or p.id in partners]
    waves = s.scalars(select(ProgrammeWave).where(ProgrammeWave.programme_id == prog.id)
                      .order_by(ProgrammeWave.start_date, ProgrammeWave.key))
    try:
        can_manage = programme.visible_partners(principal, s, prog.id, P.PROGRAMME_MANAGE) is None
    except ProgrammeError:
        can_manage = False
    try:
        programme.visible_partners(principal, s, prog.id, P.PRESALES)
        can_scan = True
    except ProgrammeError:
        can_scan = False
    return {"id": str(prog.id), "name": prog.name, "description": prog.description,
            "source_adapter": prog.source_adapter, "target_adapter": prog.target_adapter,
            "blueprint_template": prog.blueprint_template, "packs": list(prog.packs or []),
            "segments": list(prog.segments or []), "band_effort_weeks": prog.band_effort_weeks,
            "mci": {"measures": [{"key": k, "label": lab} for k, lab, *_ in programme.MEASURES],
                    **programme.config_of(prog)},
            "partners": [{"id": str(p.id), "name": p.name,
                          "pods": [{"id": str(x.id), "name": x.name, "capacity": x.capacity} for x in
                                   s.scalars(select(Pod).where(Pod.partner_id == p.id).order_by(Pod.name))]}
                         for p in ps],
            "waves": [{"key": w.key, "name": w.name, "start": w.start_date.isoformat(), "end": w.end_date.isoformat()}
                      for w in waves],
            "customers": [{"id": str(t.id), "name": t.name, "partner_id": str(t.partner_id) if t.partner_id else None,
                           "segment": t.segment} for t in programme.customers(s, prog.id, partners)],
            "scope": "programme" if partners is None else "partner", "can_manage": can_manage, "can_scan": can_scan}


@router.get("/programmes/{programme_id}")
def get_programme(programme_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    prog, partners = _prog(s, principal, programme_id, P.TENANT_READ)
    return _detail(s, principal, prog, partners)


class SetupIn(BaseModel):
    source_adapter: str | None = Field(default=None, max_length=120)
    target_adapter: str | None = Field(default=None, max_length=120)
    blueprint_template: str | None = Field(default=None, max_length=100)
    packs: list[str] = Field(default_factory=list, max_length=50)
    segments: list[str] = Field(default_factory=list, max_length=50)
    mci_config: dict[str, Any] = Field(default_factory=dict)
    band_effort_weeks: dict[Literal["simple", "medium", "complex"], float] | None = None


@router.put("/programmes/{programme_id}/setup")
def setup(programme_id: uuid.UUID, body: SetupIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """The programme's shared playbook: source and target adapters, the blueprint template every customer starts
    from, the packs they share, the segments and the Complexity Index settings."""
    prog = _manage(s, principal, programme_id)
    for field, ref in (("source_adapter", body.source_adapter), ("target_adapter", body.target_adapter),
                       *[(f"packs.{i}", r) for i, r in enumerate(body.packs)]):
        if ref is None:
            continue
        try:
            found = pack_registry.get_by_ref(s, ref, published_only=False)
        except ValueError as e:
            raise invalid(field, str(e)) from e
        if found is None:
            raise invalid(field, f"{ref} is not in the pack registry.")
    if body.blueprint_template and s.scalar(select(BlueprintTemplate.id).where(
            BlueprintTemplate.name == body.blueprint_template)) is None:
        raise invalid("blueprint_template", "No such blueprint template.")
    segs = [x.strip() for x in body.segments if x.strip()]
    if len(set(segs)) != len(segs):
        raise invalid("segments", "Segment names must be distinct.")
    in_use = {t.segment for t in programme.customers(s, prog.id, None) if t.segment}
    if in_use - set(segs):
        raise invalid("segments", f"Customers still use: {', '.join(sorted(in_use - set(segs)))}.")
    try:
        cfg = programme.validate_config(body.mci_config)
    except ProgrammeError as e:
        raise _err(e) from e
    weeks: dict[str, Any] = ({str(k): v for k, v in body.band_effort_weeks.items()} if body.band_effort_weeks
                             else dict(prog.band_effort_weeks))
    if any(v <= 0 or v > 104 for v in weeks.values()):
        raise invalid("band_effort_weeks", "Weeks per band are between 0 and 104.")
    before = programme.config_of(prog)
    prog.source_adapter, prog.target_adapter, prog.blueprint_template = (body.source_adapter, body.target_adapter,
                                                                         body.blueprint_template)
    if programme.config_from(cfg) != before:
        # Every set of weights is kept: the starting one is recorded before the first change, then the new one.
        programme.ensure_versions(s, prog, principal.user.id)
        prog.mci_config = cfg
        s.flush()
        programme.record_version(s, prog, principal.user.id, "manual", "Changed by hand in the programme set-up.")
    prog.packs, prog.segments, prog.band_effort_weeks = body.packs, segs, weeks
    s.flush()
    audit.record(s, principal.actor, "programme.setup", target_type="programme", target_id=str(prog.id),
                 details=body.model_dump())
    return _detail(s, principal, prog, None)


class PodIn(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    capacity: int = Field(ge=1, le=50, description="Customers the pod migrates at once in a wave")


@router.post("/programmes/{programme_id}/partners/{partner_id}/pods", status_code=201)
def add_pod(programme_id: uuid.UUID, partner_id: uuid.UUID, body: PodIn, principal: CurrentPrincipal, s: DB
            ) -> dict[str, Any]:
    prog = _manage(s, principal, programme_id)
    partner = s.get(Partner, partner_id)
    if partner is None or partner.programme_id != prog.id:
        raise not_found("Partner")
    pod = Pod(partner_id=partner.id, name=body.name.strip(), capacity=body.capacity)
    s.add(pod)
    try:
        s.flush()
    except IntegrityError as e:
        raise conflict("This partner already has a pod with this name") from e
    audit.record(s, principal.actor, "programme.pod_added", target_type="programme", target_id=str(prog.id),
                 details={"partner": partner.name, "pod": pod.name, "capacity": pod.capacity})
    return _detail(s, principal, prog, None)


@router.delete("/programmes/{programme_id}/pods/{pod_id}")
def delete_pod(programme_id: uuid.UUID, pod_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    prog = _manage(s, principal, programme_id)
    pod = s.get(Pod, pod_id)
    partner = s.get(Partner, pod.partner_id) if pod else None
    if pod is None or partner is None or partner.programme_id != prog.id:
        raise not_found("Pod")
    s.delete(pod)
    s.flush()
    audit.record(s, principal.actor, "programme.pod_removed", target_type="programme", target_id=str(prog.id),
                 details={"pod": pod.name})
    return _detail(s, principal, prog, None)


class WaveIn(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    start: date
    end: date


@router.put("/programmes/{programme_id}/waves/{key}")
def put_wave(programme_id: uuid.UUID, key: Annotated[str, Field(pattern=KEY)], body: WaveIn,
             principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    prog = _manage(s, principal, programme_id)
    if body.end < body.start:
        raise invalid("end", "A wave ends on or after its start.")
    w = s.scalar(select(ProgrammeWave).where(ProgrammeWave.programme_id == prog.id, ProgrammeWave.key == key))
    if w is None:
        s.add(ProgrammeWave(programme_id=prog.id, key=key, name=body.name.strip(), start_date=body.start,
                            end_date=body.end))
    else:
        w.name, w.start_date, w.end_date = body.name.strip(), body.start, body.end
    s.flush()
    audit.record(s, principal.actor, "programme.wave_saved", target_type="programme", target_id=str(prog.id),
                 details={"wave": key, **body.model_dump(mode="json")})
    return _detail(s, principal, prog, None)


@router.delete("/programmes/{programme_id}/waves/{key}")
def delete_wave(programme_id: uuid.UUID, key: str, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    prog = _manage(s, principal, programme_id)
    w = s.scalar(select(ProgrammeWave).where(ProgrammeWave.programme_id == prog.id, ProgrammeWave.key == key))
    if w is None:
        raise not_found("Wave")
    s.delete(w)
    s.flush()
    return _detail(s, principal, prog, None)


class CustomerIn(BaseModel):
    partner_id: uuid.UUID | None
    segment: str | None = Field(default=None, max_length=100)


@router.put("/programmes/{programme_id}/customers/{tenant_id}")
def assign_customer(programme_id: uuid.UUID, tenant_id: uuid.UUID, body: CustomerIn, principal: CurrentPrincipal,
                    s: DB) -> dict[str, Any]:
    """Assign a customer to one partner (and a segment). Partners then see only their own customers."""
    prog = _manage(s, principal, programme_id)
    t = s.get(Tenant, tenant_id)
    if t is None or t.programme_id != prog.id:
        raise not_found("Customer of this programme")
    if body.partner_id is not None:
        partner = s.get(Partner, body.partner_id)
        if partner is None or partner.programme_id != prog.id:
            raise invalid("partner_id", "Choose a partner of this programme.")
    if body.segment and body.segment not in (prog.segments or []):
        raise invalid("segment", f"Segments are: {', '.join(prog.segments or []) or 'none set'}.")
    before = {"partner": str(t.partner_id) if t.partner_id else None, "segment": t.segment}
    t.partner_id, t.segment = body.partner_id, body.segment
    s.flush()
    audit.record(s, principal.actor, "programme.customer_assigned", tenant_id=t.id, target_type="tenant",
                 target_id=str(t.id), details={"before": before, "partner": str(body.partner_id)
                                               if body.partner_id else None, "segment": body.segment})
    return _detail(s, principal, prog, None)


# ------------------------------------------------------------------ consent and fleet scans (E18.F2.S1)

def _customer(s: Session, principal: Principal, tenant_id: uuid.UUID, perm: P) -> tuple[Tenant, Programme]:
    t = s.get(Tenant, tenant_id)
    if t is None or t.programme_id is None:
        raise not_found("Customer of a programme")
    prog, partners = _prog(s, principal, t.programme_id, perm)
    if partners is not None and t.partner_id not in partners:
        raise not_found("Customer of a programme")
    return t, prog


def _consent_out(s: Session, c: CustomerConsent) -> dict[str, Any]:
    by, rb = s.get(User, c.recorded_by), s.get(User, c.revoked_by) if c.revoked_by else None
    return {"id": str(c.id), "signatory_name": c.signatory_name, "signatory_title": c.signatory_title,
            "scope": c.scope, "reference": c.reference, "recorded_by": by.display_name if by else None,
            "recorded_at": c.recorded_at.isoformat() if c.recorded_at else None, "active": c.revoked_at is None,
            "revoked_at": c.revoked_at.isoformat() if c.revoked_at else None,
            "revoked_by": rb.display_name if rb else None, "revoke_reason": c.revoke_reason}


class ConsentIn(BaseModel):
    signatory_name: str = Field(min_length=2, max_length=200)
    signatory_title: str = Field(min_length=2, max_length=200)
    scope: str = Field(min_length=20, max_length=4000, description="What the customer agreed to be read")
    reference: str = Field(min_length=3, max_length=1000, description="Where the signed consent is kept")


@router.post("/tenants/{tenant_id}/consents", status_code=201)
def record_consent(tenant_id: uuid.UUID, body: ConsentIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, _prog_ = _customer(s, principal, tenant_id, P.PRESALES)
    c = CustomerConsent(tenant_id=t.id, signatory_name=body.signatory_name.strip(),
                        signatory_title=body.signatory_title.strip(), scope=body.scope.strip(),
                        reference=body.reference.strip(), recorded_by=principal.user.id)
    s.add(c)
    s.flush()
    audit.record(s, principal.actor, "fleet.consent_recorded", tenant_id=t.id, target_type="consent",
                 target_id=str(c.id), details=body.model_dump())
    return _consent_out(s, c)


@router.get("/tenants/{tenant_id}/consents")
def list_consents(tenant_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    t, _prog_ = _customer(s, principal, tenant_id, P.TENANT_READ)
    return [_consent_out(s, c) for c in s.scalars(select(CustomerConsent).where(CustomerConsent.tenant_id == t.id)
                                                  .order_by(CustomerConsent.recorded_at.desc()))]


class RevokeIn(BaseModel):
    reason: str = Field(min_length=10, max_length=2000)


@router.post("/consents/{consent_id}/revoke")
def revoke_consent(consent_id: uuid.UUID, body: RevokeIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    c = s.get(CustomerConsent, consent_id)
    if c is None:
        raise not_found("Consent")
    t, _prog_ = _customer(s, principal, c.tenant_id, P.PRESALES)
    if c.revoked_at is not None:
        raise conflict("The consent is already revoked")
    c.revoked_at, c.revoked_by, c.revoke_reason = datetime.now(UTC), principal.user.id, body.reason.strip()
    s.flush()
    audit.record(s, principal.actor, "fleet.consent_revoked", tenant_id=t.id, target_type="consent",
                 target_id=str(c.id), details={"reason": c.revoke_reason})
    return _consent_out(s, c)


class ScanIn(BaseModel):
    connection_id: uuid.UUID


def _scan_out(s: Session, sc: FleetScan) -> dict[str, Any]:
    return {"id": str(sc.id), "tenant_id": str(sc.tenant_id), "status": sc.status, "status_detail": sc.status_detail,
            "measures": sc.measures, "mci": sc.mci, "job_id": str(sc.job_id) if sc.job_id else None,
            "consent_id": str(sc.consent_id), "requested_by": sc.requested_by.get("name"),
            "created_at": sc.created_at.isoformat() if sc.created_at else None,
            "finished_at": sc.finished_at.isoformat() if sc.finished_at else None}


@router.post("/tenants/{tenant_id}/fleet-scans", status_code=201)
def start_scan(tenant_id: uuid.UUID, body: ScanIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """A light scan: metadata and counts only, through a checked read-only connection, after the customer's
    consent is recorded."""
    t, _prog_ = _customer(s, principal, tenant_id, P.PRESALES)
    consent = s.scalars(select(CustomerConsent).where(CustomerConsent.tenant_id == t.id,
                                                      CustomerConsent.revoked_at.is_(None))
                        .order_by(CustomerConsent.recorded_at.desc())).first()
    if consent is None:
        raise conflict("No consent", "Record the customer's consent before scanning their estate.")
    conn = s.get(SourceConnection, body.connection_id)
    if conn is None or conn.tenant_id != t.id:
        raise invalid("connection_id", "Choose a source connection of this customer.")
    if s.scalar(select(AdapterRun.id).where(AdapterRun.connection_id == conn.id, AdapterRun.kind == "check",
                                            AdapterRun.status == "succeeded")) is None:
        raise conflict("Check the connection first", "Scans run only after a check proved the account is read-only.")
    return _scan_out(s, programme.start_scan(s, t, conn, consent.id, principal.actor))


@router.get("/tenants/{tenant_id}/fleet-scans")
def list_scans(tenant_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> list[dict[str, Any]]:
    t, _prog_ = _customer(s, principal, tenant_id, P.TENANT_READ)
    return [_scan_out(s, x) for x in s.scalars(select(FleetScan).where(FleetScan.tenant_id == t.id)
                                               .order_by(FleetScan.created_at.desc()).limit(50))]


@router.get("/programmes/{programme_id}/fleet")
def fleet(programme_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """The Complexity Index and band of every visible customer, and per segment."""
    prog, partners = _prog(s, principal, programme_id, P.TENANT_READ)
    rows: list[dict[str, Any]] = []
    for t in programme.customers(s, prog.id, partners):
        sc = programme.latest_scan(s, t.id)
        consent = s.scalar(select(CustomerConsent.id).where(CustomerConsent.tenant_id == t.id,
                                                            CustomerConsent.revoked_at.is_(None)).limit(1))
        rows.append({"customer_id": str(t.id), "customer": t.name, "segment": t.segment,
                     "partner_id": str(t.partner_id) if t.partner_id else None, "consent": consent is not None,
                     "scan": _scan_out(s, sc) if sc else None,
                     "index": programme.band_of(s, prog, t.id, sc)})
    segs: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        if r["index"]:
            segs.setdefault(r["segment"] or "(no segment)", []).append(r["index"])
    segments = []
    for seg, ms in sorted(segs.items()):
        mean = round(sum(m["score"] for m in ms) / len(ms), 1)
        prog_band = programme.config_of(prog)["bands"]
        segments.append({"segment": seg, "customers": len(ms), "mean_score": mean,
                         "band": "simple" if mean < prog_band["simple"] else "medium"
                         if mean < prog_band["medium"] else "complex",
                         "bands": {b: sum(1 for m in ms if m["band"] == b) for b in ("simple", "medium", "complex")}})
    return {"customers": rows, "segments": segments, "scope": "programme" if partners is None else "partner",
            "weights_version": programme.current_version(s, prog)}


# ------------------------------------------------------------------ index versions, recalibration, contracts

def _version_out(s: Session, v: Any) -> dict[str, Any]:
    u = s.get(User, v.created_by)
    return {"number": v.number, "source": v.source, "after_wave": v.after_wave, "weights": v.weights,
            "ranges": v.ranges, "bands": v.bands, "basis": v.basis, "reason": v.reason,
            "created_by": u.display_name if u else None,
            "created_at": v.created_at.isoformat() if v.created_at else None}


@router.get("/programmes/{programme_id}/mci/versions")
def mci_versions(programme_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Every weights version of the programme's Complexity Index, newest first, and the contracted bands the
    caller can see. Until the first change there is no stored version: the current weights are the starting
    assumptions."""
    prog, partners = _prog(s, principal, programme_id, P.TENANT_READ)
    visible = {t.id: t for t in programme.customers(s, prog.id, partners)}
    contracts = [c for c in s.scalars(select(BandContract).where(BandContract.programme_id == prog.id)
                                      .order_by(BandContract.contracted_at)) if c.tenant_id in visible]
    out = []
    for c in contracts:
        u = s.get(User, c.contracted_by)
        out.append({"customer_id": str(c.tenant_id), "customer": visible[c.tenant_id].name, "band": c.band,
                    "score": float(c.score), "weights_version": c.weights_version, "reference": c.reference,
                    "contracted_by": u.display_name if u else None,
                    "contracted_at": c.contracted_at.isoformat() if c.contracted_at else None})
    vs = programme.versions(s, prog)
    if partners is not None:  # partners see weights and dates, not which customers informed a recalibration
        hidden = ("customers_used", "band_changes", "skipped")
        items = [{**_version_out(s, v), "basis": {k: x for k, x in (v.basis or {}).items() if k not in hidden}}
                 for v in reversed(vs)]
    else:
        items = [_version_out(s, v) for v in reversed(vs)]
    return {"versions": items, "current_version": vs[-1].number if vs else None,
            "current": programme.config_of(prog), "contracts": out,
            "can_manage": partners is None and _can_manage(s, principal, prog.id)}


def _can_manage(s: Session, principal: Principal, programme_id: uuid.UUID) -> bool:
    try:
        return programme.visible_partners(principal, s, programme_id, P.PROGRAMME_MANAGE) is None
    except ProgrammeError:
        return False


class RecalibrateIn(BaseModel):
    after_wave: str = Field(pattern=KEY, description="Customers planned in this wave and earlier inform the fit")
    apply: bool = Field(default=False, description="false previews the proposal; true stores it as a new version")
    reason: str | None = Field(default=None, min_length=10, max_length=2000, description="Required to apply")


@router.post("/programmes/{programme_id}/mci/recalibration")
def recalibrate(programme_id: uuid.UUID, body: RecalibrateIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Propose (or apply) Complexity Index weights fitted to actual effort after a wave. Applying stores a new,
    dated weights version; contracted bands never change."""
    prog = _manage(s, principal, programme_id)
    try:
        if not body.apply:
            return {"applied": False, **programme.recalibration(s, prog, body.after_wave)}
        if not body.reason:
            raise invalid("reason", "Give the reason for the new weights (at least 10 characters).")
        v, proposal = programme.apply_recalibration(s, prog, body.after_wave, body.reason, principal.actor,
                                                    principal.user.id)
    except ProgrammeError as e:
        raise _err(e) from e
    return {"applied": True, "version": _version_out(s, v), **proposal}


class ContractIn(BaseModel):
    reference: str = Field(min_length=3, max_length=300, description="The contract or order reference")


@router.post("/programmes/{programme_id}/customers/{tenant_id}/band-contract", status_code=201)
def contract(programme_id: uuid.UUID, tenant_id: uuid.UUID, body: ContractIn, principal: CurrentPrincipal,
             s: DB) -> dict[str, Any]:
    """Fix a customer's band as contracted, from its latest scan and the current weights. It never changes after."""
    prog = _manage(s, principal, programme_id)
    t = s.get(Tenant, tenant_id)
    if t is None or t.programme_id != prog.id:
        raise not_found("Customer")
    try:
        c = programme.contract_band(s, prog, t, body.reference, principal.actor, principal.user.id)
    except ProgrammeError as e:
        raise _err(e) from e
    return {"customer_id": str(t.id), "band": c.band, "score": float(c.score), "weights_version": c.weights_version,
            "reference": c.reference}


# ------------------------------------------------------------------ portfolio planner (E18.F3.S1)

@router.post("/programmes/{programme_id}/portfolio-plans", status_code=201)
def solve_portfolio(programme_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    prog = _manage(s, principal, programme_id)
    result = programme.plan(s, prog)
    number = (s.scalar(select(PortfolioPlan.number).where(PortfolioPlan.programme_id == prog.id)
                       .order_by(PortfolioPlan.number.desc()).limit(1)) or 0) + 1
    pp = PortfolioPlan(programme_id=prog.id, number=number, result=result, created_by=principal.user.id)
    s.add(pp)
    s.flush()
    audit.record(s, principal.actor, "programme.portfolio_planned", target_type="programme", target_id=str(prog.id),
                 details={"number": number, "assigned": len(result["assignments"]),
                          "conflicts": len(result["conflicts"])})
    return {"number": number, **result}


@router.get("/programmes/{programme_id}/portfolio-plans/latest")
def latest_portfolio(programme_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    prog, partners = _prog(s, principal, programme_id, P.TENANT_READ)
    pp = s.scalars(select(PortfolioPlan).where(PortfolioPlan.programme_id == prog.id)
                   .order_by(PortfolioPlan.number.desc())).first()
    if pp is None:
        raise not_found("Portfolio plan")
    res = dict(pp.result)
    if partners is not None:  # partners see their own customers' places and their own pods only
        keep = {str(x) for x in partners}
        res["assignments"] = [a for a in res.get("assignments", []) if a.get("partner_id") in keep]
        res["pods"] = [p for p in res.get("pods", []) if p.get("partner_id") in keep]
        ids = {str(t.id) for t in programme.customers(s, prog.id, partners)}
        res["conflicts"] = [c for c in res.get("conflicts", []) if c.get("customer_id") in ids]
    return {"number": pp.number, "created_at": pp.created_at.isoformat() if pp.created_at else None, **res}


# ------------------------------------------------------------------ programme view and metering

@router.get("/programmes/{programme_id}/view")
def programme_view(programme_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    prog, partners = _prog(s, principal, programme_id, P.TENANT_READ)
    return programme.view(s, prog, partners)


@router.get("/programmes/{programme_id}/metering", response_model=None)
def metering(programme_id: uuid.UUID, principal: CurrentPrincipal, s: DB,
             format: Literal["json", "csv"] = "json") -> Any:
    """Bands, gate evidence, effort and elapsed time per customer and segment. The CSV is the gate evidence for
    invoicing."""
    prog, partners = _prog(s, principal, programme_id, P.TENANT_READ)
    out = programme.metering(s, prog, partners)
    if format == "csv":
        buf = io.StringIO()
        cols = ["customer", "segment", "band", "project", "gate", "label", "passed_at", "approvers",
                "checklist_digest"]
        w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for row in out["gate_evidence"]:
            w.writerow({k: ("'" + str(v) if isinstance(v, str) and v[:1] in "=+-@" else v)
                        for k, v in row.items()})
        audit.record(s, principal.actor, "programme.gate_evidence_exported", target_type="programme",
                     target_id=str(prog.id), details={"rows": len(out["gate_evidence"])})
        return Response(buf.getvalue(), media_type="text/csv", headers={
            "Content-Disposition": f'attachment; filename="gate-evidence-{prog.id}.csv"'})
    return out
