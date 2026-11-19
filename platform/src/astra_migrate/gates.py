"""Lifecycle gates with checklists (E17.F1.S1).

Each gate has a checklist:
- **evidence** items the platform checks from its own records (an approved blueprint, accepted discovery coverage,
  an approved plan, decided mappings, approved code, a reconciled rehearsal, a final load, passed parity, ...), each
  linking to its source record;
- **control** items added by the compliance packs: every control whose lifecycle gate is this one becomes a
  condition a person attests with evidence (a note and a reference);
- **attestation** items the platform asks for where no record can prove the condition (decommissioning).

A gate passes when every item is met and a different person approves for each required role. Approvals are bound to
the checklist's digest: if the evidence changes, earlier approvals no longer count. The blueprint can label gates
(for example G0 to G4) and set their approver roles; the database enforces the approvals.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

import psycopg
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.blueprints.model import Blueprint
from astra_migrate.db.models import (
    BlueprintVersion,
    BuildArtifact,
    CoexistenceSchedule,
    CoverageReport,
    GateApproval,
    GateEvidence,
    GatePass,
    LoadRun,
    ParityRun,
    PlanBaseline,
    Project,
    ReconBreak,
    Tenant,
    User,
)
from astra_migrate.packs import registry as pack_registry
from astra_migrate.planning.controls import DEFAULT_GATES
from astra_migrate.security.rbac import ROLES, P
from astra_migrate.tenancy.service import tenant_connection
from astra_migrate.vault import get_vault

GATES: list[tuple[str, str]] = [
    ("configure", "Configure"), ("discover", "Discover"), ("plan", "Plan"), ("design", "Design"),
    ("build_rehearse", "Build and rehearse"), ("cutover", "Cutover"), ("stabilise", "Stabilise"),
    ("decommission", "Decommission")]
GATE_KEYS = [k for k, _ in GATES]
DEFAULT_APPROVERS = ["migration_lead", "customer_data_owner"]
ATTESTATIONS = {
    "decommission": [("legacy-retired", "Legacy access removed and its data retained or destroyed under the "
                                        "retention rules, with the evidence filed")],
    "stabilise": [("hypercare-closed", "Hypercare finished: no open priority incidents caused by the migration")],
}


class GateError(Exception):
    def __init__(self, status: int, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.status, self.field = status, field


@dataclass
class Item:
    key: str
    kind: str  # evidence | control | attestation
    title: str
    met: bool
    detail: str
    source: dict[str, Any] | None = None
    control: dict[str, Any] | None = None
    evidence: dict[str, Any] | None = None


@dataclass
class Checklist:
    key: str
    title: str
    label: str
    approvers: list[str]
    items: list[Item] = field(default_factory=list)

    @property
    def all_met(self) -> bool:
        return all(i.met for i in self.items)

    @property
    def digest(self) -> str:
        basis = [(i.key, i.met, (i.source or {}).get("id"), (i.evidence or {}).get("at")) for i in self.items]
        return hashlib.sha256(json.dumps(basis, default=str).encode()).hexdigest()


def _src(kind: str, ident: Any, href: str) -> dict[str, Any]:
    return {"type": kind, "id": str(ident), "href": href}


def blueprint_of(s: Session, project_id: uuid.UUID) -> tuple[Blueprint | None, BlueprintVersion | None]:
    """The blueprint the gates follow (the approved version, else the newest draft, for labels and controls) and
    the approved version, if any."""
    from astra_migrate.blueprints import service as blueprints

    approved = s.scalars(select(BlueprintVersion).where(BlueprintVersion.project_id == project_id,
                                                        BlueprintVersion.status == "approved")
                         .order_by(BlueprintVersion.number.desc())).first()
    src = approved or blueprints.latest(s, project_id)
    if src is None:
        return None, None
    try:
        return Blueprint.model_validate(src.content or {}), approved
    except ValueError:
        return None, approved


def _evidence(s: Session, tc: psycopg.Connection[Any], p: Project, bp: Blueprint | None,
              bv: BlueprintVersion | None) -> dict[str, list[Item]]:
    pid, base = p.id, f"/api/v1/projects/{p.id}"
    out: dict[str, list[Item]] = {k: [] for k in GATE_KEYS}
    out["configure"].append(Item(
        "blueprint-approved", "evidence", "Blueprint approved", bv is not None,
        f"Version {bv.number} is approved." if bv else "No blueprint version is approved yet.",
        _src("blueprint_version", bv.number, f"{base}/blueprint/versions/{bv.number}") if bv else None))
    cov = s.scalars(select(CoverageReport).where(CoverageReport.project_id == pid, CoverageReport.status == "accepted")
                    .order_by(CoverageReport.created_at.desc())).first()
    out["discover"].append(Item(
        "coverage-accepted", "evidence", "Discovery coverage accepted", cov is not None,
        f"Coverage {cov.coverage_pct:.0f}% accepted." if cov else "No discovery coverage report is accepted.",
        _src("coverage_report", cov.id, f"/api/v1/discovery-runs/{cov.discovery_run_id}") if cov else None))
    pb = s.scalars(select(PlanBaseline).where(PlanBaseline.project_id == pid, PlanBaseline.status == "approved")
                   .order_by(PlanBaseline.number.desc())).first()
    out["plan"].append(Item(
        "plan-approved", "evidence", "Plan baseline approved by a second person", pb is not None,
        f"Baseline {pb.number} is approved." if pb else "No plan baseline is approved.",
        _src("plan_baseline", pb.id, f"{base}/plan/baselines") if pb else None))
    counts: dict[str, dict[str, int]] = {}
    for stream, status, n in tc.execute("SELECT stream, status, count(*) FROM estate.design_items WHERE "
                                        "project_id = %s GROUP BY stream, status", (pid,)).fetchall():
        counts.setdefault(stream, {})[status] = int(n)
    m = counts.get("mapping", {})
    open_m = m.get("proposed", 0) + m.get("in_review", 0)
    out["design"].append(Item(
        "mappings-decided", "evidence", "Every mapping decided", bool(m) and open_m == 0,
        f"{m.get('approved', 0)} approved, {m.get('rejected', 0)} rejected, {open_m} undecided." if m else
        "No design run has proposed mappings yet.", _src("design_register", "mapping", f"{base}/design/items"
                                                         "?stream=mapping")))
    approved = s.scalar(select(func.count()).select_from(BuildArtifact).where(
        BuildArtifact.project_id == pid, BuildArtifact.kind == "transformation", BuildArtifact.status == "approved"))
    out["design"].append(Item(
        "transformations-approved", "evidence", "Transformation code tested and approved", bool(approved),
        f"{approved} approved transformation version(s)." if approved else "No transformation code is approved.",
        _src("build_artifacts", "transformation", f"{base}/build-artifacts?kind=transformation")))
    c = counts.get("code", {})
    open_c = c.get("proposed", 0) + c.get("in_review", 0)
    out["design"].append(Item(
        "customer-code-decided", "evidence", "Customer code decided", open_c == 0,
        f"{open_c} customer code item(s) undecided." if open_c else "No customer code item is undecided.",
        _src("design_register", "code", f"{base}/design/items?stream=code")))
    reh = s.scalars(select(LoadRun).where(LoadRun.project_id == pid, LoadRun.kind == "rehearsal",
                                          LoadRun.status == "succeeded").order_by(LoadRun.number.desc())).first()
    out["build_rehearse"].append(Item(
        "rehearsal-done", "evidence", "A rehearsal ran with approved code", reh is not None,
        f"Rehearsal run {reh.number}." if reh else "No rehearsal has run.",
        _src("load_run", reh.id, f"/api/v1/load-runs/{reh.id}") if reh else None))
    if reh is not None:
        open_reh = s.scalar(select(func.count()).select_from(ReconBreak).where(
            ReconBreak.load_run_id == reh.id, ReconBreak.status == "open")) or 0
        out["build_rehearse"].append(Item(
            "rehearsal-reconciled", "evidence", "The latest rehearsal reconciles (no open breaks)", open_reh == 0,
            f"{open_reh} open break(s) on run {reh.number}." if open_reh else f"Run {reh.number} has no open breaks.",
            _src("recon_breaks", reh.id, f"{base}/recon-breaks?load_run_id={reh.id}")))
    final = s.scalars(select(LoadRun).where(LoadRun.project_id == pid, LoadRun.kind.in_(("load", "delta")),
                                            LoadRun.status == "succeeded").order_by(LoadRun.number.desc())).first()
    out["cutover"].append(Item(
        "final-load", "evidence", "A load into the target completed", final is not None,
        f"Load run {final.number}." if final else "No load into the target has completed.",
        _src("load_run", final.id, f"/api/v1/load-runs/{final.id}") if final else None))
    open_loads = s.scalar(select(func.count()).select_from(ReconBreak).where(
        ReconBreak.project_id == pid, ReconBreak.origin == "load", ReconBreak.status == "open")) or 0
    out["cutover"].append(Item(
        "breaks-closed", "evidence", "Every reconciliation break closed by its owner", open_loads == 0,
        f"{open_loads} open break(s)." if open_loads else "No open reconciliation breaks.",
        _src("recon_breaks", "load", f"{base}/recon-breaks?origin=load&status=open")))
    parity = list(s.scalars(select(ParityRun).where(ParityRun.project_id == pid)))
    latest: dict[tuple[str, str], ParityRun] = {}
    for r in sorted(parity, key=lambda r: r.created_at):
        latest[(r.kind, r.name)] = r
    failing = [r for r in latest.values() if not r.summary.get("passed")]
    out["cutover"].append(Item(
        "parity-passed", "evidence", "Parity tests passed or their differences approved",
        bool(latest) and not failing,
        (f"{len(failing)} of {len(latest)} parity test(s) have open differences." if failing else
         f"{len(latest)} parity test(s) passed.") if latest else "No parity test has run.",
        _src("parity_runs", "all", f"{base}/parity-runs")))
    docs = (final.summary or {}).get("documents") if final else None
    out["cutover"].append(Item(
        "documents-verified", "evidence", "Document links and the byte-for-byte sample verified",
        bool(docs and docs.get("passed")),
        ("Documents verified." if docs and docs.get("passed") else
         f"{docs.get('broken_links', 0)} broken link(s); sample {docs.get('sample')}"
         + (f"; {docs['blocked']}" if docs.get("blocked") else "")) if docs else
        "Documents have not been checked on the final load.",
        _src("document_checks", final.id, f"/api/v1/load-runs/{final.id}/document-checks") if final else None))
    choice = tc.execute("SELECT body FROM estate.plan_items WHERE project_id = %s AND kind = 'cutover_choice' AND "
                        "key = 'current'", (pid,)).fetchone()
    out["cutover"].append(Item(
        "cutover-chosen", "evidence", "Cutover approach chosen with its reason", choice is not None,
        f"{choice[0].get('option')}: {choice[0].get('reason')}" if choice else "No cutover approach is recorded.",
        _src("cutover_choice", "current", f"{base}/plan/cutover/choice")))
    open_co = s.scalar(select(func.count()).select_from(ReconBreak).where(
        ReconBreak.project_id == pid, ReconBreak.origin == "coexistence", ReconBreak.status == "open")) or 0
    sch = s.get(CoexistenceSchedule, pid)
    needs_co = bool(bp and bp.cutover_strategy in ("phased", "parallel_run"))
    out["stabilise"].append(Item(
        "coexistence-clean", "evidence", "No open coexistence breaks",
        open_co == 0 and (sch is not None or not needs_co),
        (f"{open_co} open coexistence break(s)." if open_co else
         "Daily reconciliation is not scheduled for a phased or parallel cutover." if needs_co and sch is None else
         "No open coexistence breaks."), _src("coexistence", pid, f"{base}/coexistence")))
    return out


def _controls(s: Session, bp: Blueprint | None) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for ref in bp.compliance_packs if bp else []:
        try:
            pk = pack_registry.get_by_ref(s, ref, published_only=False)
        except ValueError:
            continue
        if pk is None:
            continue
        m = pack_registry.manifest_of(pk)
        for c in m.adds.controls:
            for g in ([c.gate] if c.gate else DEFAULT_GATES.get(c.type, [])):
                if g in GATE_KEYS:
                    out.append((g, {"id": c.id, "pack": m.ref, "title": c.title, "rule": c.rule,
                                    "evidence_required": c.evidence_required,
                                    "compliance_critical": c.compliance_critical,
                                    "sources": [x.reference for x in c.sources]}))
    return out


def checklists(s: Session, t: Tenant, p: Project) -> list[Checklist]:
    bp, bv = blueprint_of(s, p.id)
    labels: dict[str, Any] = {g.key: g for g in (bp.gates if bp else [])}
    with tenant_connection(t, get_vault()) as tc:
        ev = _evidence(s, tc, p, bp, bv)
    attested = {(e.gate, e.item_key): e for e in s.scalars(select(GateEvidence).where(GateEvidence.project_id == p.id))}
    by_gate: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for g, c in _controls(s, bp):
        by_gate.setdefault(g, []).append((g, c))
    out = []
    for key, title in GATES:
        spec = labels.get(key)
        approvers = list(spec.approvers) if spec and spec.approvers else list(DEFAULT_APPROVERS)
        if key == "cutover" and bp and bp.approvals.cutover:
            approvers = list(dict.fromkeys([*approvers, *bp.approvals.cutover]))
        cl = Checklist(key, title, spec.label if spec else title, approvers, list(ev[key]))
        manual: list[tuple[str, str, str, dict[str, Any] | None]] = [
            (f"control:{c['id']}", "control", f"{c['id']}: {c['title']}", c) for _g, c in by_gate.get(key, [])]
        manual += [(f"attest:{k}", "attestation", text, None) for k, text in ATTESTATIONS.get(key, [])]
        for ikey, kind, ititle, ctl in manual:
            e = attested.get((key, ikey))
            u = s.get(User, e.attested_by) if e else None
            cl.items.append(Item(
                ikey, kind, ititle, e is not None,
                (f"Attested by {u.display_name if u else 'a person'}: {e.note}" if e else
                 f"Needs evidence: {ctl['evidence_required']}" if ctl else "Needs a person's attestation."),
                {"type": "gate_evidence", "id": f"{key}/{ikey}", "href": e.reference} if e and e.reference else None,
                ctl, {"note": e.note, "reference": e.reference, "by": u.display_name if u else None,
                      "at": e.attested_at.isoformat() if e.attested_at else None} if e else None))
        out.append(cl)
    return out


def state(s: Session, p: Project, cl: Checklist) -> dict[str, Any]:
    passes = list(s.scalars(select(GatePass).where(GatePass.project_id == p.id, GatePass.gate == cl.key)
                            .order_by(GatePass.created_at.desc())))
    current = next((x for x in passes if x.checklist_digest == cl.digest), None)
    approvals = []
    for a in s.scalars(select(GateApproval).where(GateApproval.project_id == p.id, GateApproval.gate == cl.key,
                                                  GateApproval.checklist_digest == cl.digest)):
        u = s.get(User, a.user_id)
        approvals.append({"role": a.role, "role_label": ROLES[a.role].label if a.role in ROLES else a.role,
                          "user": u.display_name if u else None, "user_id": str(a.user_id), "note": a.note,
                          "at": a.created_at.isoformat() if a.created_at else None})
    status = "passed" if current else ("changed_since_pass" if passes else "open")
    return {"status": status, "approvals": approvals,
            "passed_at": current.created_at.isoformat() if current and current.created_at else
            (passes[0].created_at.isoformat() if passes and passes[0].created_at else None),
            "ever_passed": bool(passes)}


def as_dict(s: Session, p: Project, cl: Checklist) -> dict[str, Any]:
    return {"key": cl.key, "title": cl.title, "label": cl.label,
            "approvers": [{"role": r, "label": ROLES[r].label if r in ROLES else r} for r in cl.approvers],
            "items": [asdict(i) for i in cl.items], "all_met": cl.all_met, "digest": cl.digest, **state(s, p, cl)}


def attest(s: Session, principal: Any, t: Tenant, p: Project, gate: str, item_key: str, note: str,
           reference: str | None) -> None:
    if not principal.has_on_project(P.STAGE_MANAGE, t, p.id) and not principal.has_on_project(P.REVIEW_RESOLVE, t,
                                                                                            p.id):
        raise GateError(403, "You cannot attest gate evidence on this project.")
    cl = next((c for c in checklists(s, t, p) if c.key == gate), None)
    if cl is None:
        raise GateError(404, "No such gate.")
    item = next((i for i in cl.items if i.key == item_key), None)
    if item is None or item.kind == "evidence":
        raise GateError(422, "Only control conditions and attestations are attested; evidence items come from the "
                             "platform's records.", "item_key")
    if len(note.strip()) < 10:
        raise GateError(422, "Describe the evidence (at least 10 characters).", "note")
    e = s.get(GateEvidence, (p.id, gate, item_key))
    if e is None:
        s.add(GateEvidence(project_id=p.id, gate=gate, item_key=item_key, note=note.strip(), reference=reference,
                           attested_by=principal.user.id))
    else:
        from datetime import UTC, datetime

        e.note, e.reference, e.attested_by, e.attested_at = (note.strip(), reference, principal.user.id,
                                                              datetime.now(UTC))
    s.flush()
    audit.record(s, principal.actor, "gate.evidence_attested", tenant_id=t.id, project_id=p.id,
                 target_type="gate", target_id=gate, details={"item": item_key, "note": note.strip(),
                                                              "reference": reference})


def approve(s: Session, principal: Any, t: Tenant, p: Project, gate: str, role: str, note: str) -> dict[str, Any]:
    cl = next((c for c in checklists(s, t, p) if c.key == gate), None)
    if cl is None:
        raise GateError(404, "No such gate.")
    if role not in cl.approvers:
        raise GateError(422, f"This gate is approved by: {', '.join(cl.approvers)}.", "role")
    if role not in principal.roles_on_project(t, p.id):
        raise GateError(403, f"You do not hold the {ROLES[role].label if role in ROLES else role} role here.")
    if not cl.all_met:
        missing = [i.title for i in cl.items if not i.met]
        raise GateError(409, "The checklist is not complete: " + "; ".join(missing[:10]))
    existing = list(s.scalars(select(GateApproval).where(GateApproval.project_id == p.id, GateApproval.gate == gate,
                                                         GateApproval.checklist_digest == cl.digest)))
    if any(a.user_id == principal.user.id for a in existing):
        raise GateError(409, "You approved this checklist already; another person approves for the other role.")
    if any(a.role == role for a in existing):
        raise GateError(409, "This role has approved this checklist already.")
    s.add(GateApproval(project_id=p.id, gate=gate, role=role, user_id=principal.user.id,
                       checklist_digest=cl.digest, note=note.strip()))
    s.flush()
    roles_done = {a.role for a in existing} | {role}
    passed = set(cl.approvers) <= roles_done
    if passed:
        s.add(GatePass(project_id=p.id, gate=gate, checklist_digest=cl.digest, required_roles=cl.approvers,
                       checklist={"label": cl.label, "items": [asdict(i) for i in cl.items]}))
        s.flush()
    audit.record(s, principal.actor, "gate.passed" if passed else "gate.approved", tenant_id=t.id, project_id=p.id,
                 target_type="gate", target_id=gate,
                 details={"role": role, "digest": cl.digest, "note": note.strip(), "label": cl.label})
    return as_dict(s, p, cl)


def ever_passed(s: Session, project_id: uuid.UUID, gate: str) -> bool:
    return s.scalar(select(GatePass.id).where(GatePass.project_id == project_id, GatePass.gate == gate)
                    .limit(1)) is not None
