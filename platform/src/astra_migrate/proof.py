"""Proof packs (E17.F2.S1): everything an auditor needs, per project or per wave, without asking the team.

A pack is one canonical JSON document (format `astra.proofpack/v1`) and a PDF rendered from it. Its sections are
configuration, scope, lineage, decisions, controls and gates, tests, agent records, cutover and decommission. Every
item carries a `source` with the record type, its id and the API path that returns it.

The pack is signed with the platform's vault-held Ed25519 key over `sha256(json):sha256(pdf)`. The signature, key
name and key version are kept in the control plane; the JSON and PDF stay in the tenant database. Anyone with the
public key (`GET /api/v1/proof-packs/signing-key`) can verify a downloaded pack offline.
"""

from __future__ import annotations

import hashlib
import io
import json
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import gates
from astra_migrate.agents import registry as agent_registry
from astra_migrate.db.models import (
    AgentRun,
    AgentVersion,
    BlueprintApproval,
    BuildArtifact,
    Decision,
    LoadRun,
    ParityRun,
    PlanBaseline,
    Project,
    ProjectAgentPin,
    ReconBreak,
    ReviewItem,
    Tenant,
    User,
)
from astra_migrate.planning import controls as plan_controls
from astra_migrate.tenancy.service import tenant_connection
from astra_migrate.vault import get_vault

SIGNING_KEY = "platform-proof-pack"  # the vault policy lets the API sign only with platform-* keys
FORMAT = "astra.proofpack/v1"
SECTIONS = [("configuration", "Configuration"), ("scope", "Scope"), ("lineage", "Lineage"),
            ("decisions", "Decisions"), ("controls", "Controls and gates"), ("tests", "Tests"),
            ("agents", "Agent records"), ("cutover", "Cutover"), ("decommission", "Decommission")]


def _item(title: str, detail: str, kind: str, ident: Any, href: str | None, **extra: Any) -> dict[str, Any]:
    return {"title": title, "detail": detail, "source": {"type": kind, "id": str(ident), "href": href}, **extra}


def _name(s: Session, uid: Any) -> str | None:
    u = s.get(User, uid) if uid else None
    return u.display_name if u else None


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


def build(s: Session, t: Tenant, p: Project, wave: str | None, by: str) -> dict[str, Any]:
    base = f"/api/v1/projects/{p.id}"
    sec: dict[str, list[dict[str, Any]]] = {k: [] for k, _ in SECTIONS}
    bp, bv = gates.blueprint_of(s, p.id)
    # ---- configuration
    if bv is not None:
        approvals = list(s.scalars(select(BlueprintApproval).where(BlueprintApproval.version_id == bv.id)))
        sec["configuration"].append(_item(
            f"Blueprint version {bv.number} (approved)",
            "Approved by " + ", ".join(f"{_name(s, a.user_id)} ({a.role})" for a in approvals if a.decision ==
                                       "approve") + f". Content digest {hashlib.sha256(json.dumps(bv.content,
                                       sort_keys=True).encode()).hexdigest()[:16]}.",
            "blueprint_version", bv.number, f"{base}/blueprint/versions/{bv.number}"))
    if bp is not None:
        for kind, refs in (("domain", bp.domain_packs), ("compliance", bp.compliance_packs),
                           ("pattern", bp.pattern_packs)):
            for ref in refs:
                name, _, version = ref.partition("@")
                sec["configuration"].append(_item(f"{kind.capitalize()} pack {ref}", f"Pinned {kind} pack.", "pack",
                                                  ref, f"/api/v1/packs/{name}/{version}"))
        sec["configuration"].append(_item(f"Source adapter {bp.source.adapter}", "Source adapter pack.", "pack",
                                          bp.source.adapter, f"/api/v1/packs/{bp.source.adapter.replace('@', '/')}"))
        sec["configuration"].append(_item(f"Target adapter {bp.target.adapter}", "Target adapter pack.", "pack",
                                          bp.target.adapter, f"/api/v1/packs/{bp.target.adapter.replace('@', '/')}"))
    with tenant_connection(t, get_vault()) as tc:
        plan = {(k, key): b for k, key, b in tc.execute(
            "SELECT kind, key, body FROM estate.plan_items WHERE project_id = %s AND kind IN "
            "('scope', 'wave', 'wave_plan', 'cutover_choice', 'runbook_step', 'coexistence')", (p.id,)).fetchall()}
        assign = (plan.get(("wave_plan", "current")) or {}).get("assignments") or {}
        in_wave = {k for k, w in assign.items() if w == wave} if wave else None
        wave_tables = {str(b["element"]).lower() for (kind, k), b in plan.items()
                       if kind == "scope" and (in_wave is None or k in in_wave)}
        # ---- scope
        for (kind, key), b in sorted(plan.items()):
            if kind != "scope" or (in_wave is not None and key not in in_wave):
                continue
            d = b.get("decision") or {}
            sec["scope"].append(_item(
                b["element"], f"{b.get('disposition') or b.get('proposed')} ({b['status']})"
                + (f"; decided by {d.get('by')}: {d.get('reason')}" if d else ""), "scope_item", key,
                f"{base}/plan/scope", wave=assign.get(key)))
        # ---- lineage
        arts = list(s.scalars(select(BuildArtifact).where(BuildArtifact.project_id == p.id,
                                                          BuildArtifact.kind == "transformation",
                                                          BuildArtifact.status.in_(("approved", "superseded")))
                              .order_by(BuildArtifact.name, BuildArtifact.version)))
        runs = list(s.scalars(select(LoadRun).where(LoadRun.project_id == p.id).order_by(LoadRun.number)))
        for a in arts:
            row = tc.execute("SELECT inputs FROM estate.build_code WHERE artifact_id = %s", (a.id,)).fetchone()
            inp = row[0] if row else {}
            st = str(inp.get("source_table", "")).lower()
            if wave and st not in wave_tables:
                continue
            used = [r for r in runs if any(x["id"] == str(a.id) for x in r.artifacts)]
            tt = str(inp.get("target_table", "")).lower()
            loads = "; ".join(
                f"run {r.number} ({r.kind}): {_accepted(r.summary, tt)} accepted"
                for r in used if r.status == "succeeded") or "not loaded yet"
            sec["lineage"].append(_item(
                f"{inp.get('source_table')} → {inp.get('target_table')}",
                f"{len(inp.get('mappings') or [])} approved mapping(s); code version {a.version} (digest "
                f"{a.digest[:16]}, {a.status}, tests {a.test_summary.get('passed', 0)}/"
                f"{a.test_summary.get('tests', 0)})"
                f"; {loads}.", "build_artifact", a.id, f"/api/v1/build-artifacts/{a.id}",
                mappings=[{"source": m.get("source"), "target": m.get("target"), "decided_by": m.get("decided_by")}
                          for m in inp.get("mappings") or []]))
        choice = plan.get(("cutover_choice", "current"))
        steps = sorted((b for (kind, _k), b in plan.items() if kind == "runbook_step"),
                       key=lambda b: (b.get("order") or 0))
        coexist = [b for (kind, _k), b in plan.items() if kind == "coexistence"]
    # ---- decisions
    for ri in s.scalars(select(ReviewItem).where(ReviewItem.project_id == p.id, ReviewItem.status != "open")
                        .order_by(ReviewItem.resolved_at)):
        sec["decisions"].append(_item(
            ri.title, f"{ri.outcome or ri.status}: {ri.resolution or ri.changed_value or ''}"
            f" — {_name(s, ri.resolved_by)} on {_iso(ri.resolved_at)}; {ri.resolution_note or ''}".strip(),
            "review_item", ri.id, f"/api/v1/review-items/{ri.id}", compliance=ri.compliance,
            controls=list(ri.compliance_controls or [])))
    for d in s.scalars(select(Decision).where(Decision.project_id == p.id, Decision.status != "open")):
        sec["decisions"].append(_item(
            f"{d.kind.replace('_', ' ').capitalize()}: {d.subject}",
            f"{d.status}: {(d.chosen_value or {}).get('value')} — {_name(s, d.decided_by)}; {d.reason or ''}",
            "decision", d.id, f"{base}/decisions"))
    for b in s.scalars(select(PlanBaseline).where(PlanBaseline.project_id == p.id, PlanBaseline.status != "proposed")):
        sec["decisions"].append(_item(
            f"Plan baseline {b.number}", f"{b.status} by {_name(s, b.decided_by)}; proposed by "
            f"{_name(s, b.proposed_by)}: {b.reason}", "plan_baseline", b.id, f"{base}/plan/baselines"))
    # ---- controls and gates
    cls = gates.checklists(s, t, p)
    for cl in cls:
        gs = gates.state(s, p, cl)
        sec["controls"].append(_item(
            f"Gate {cl.label}: {gs['status'].replace('_', ' ')}",
            f"{sum(1 for i in cl.items if i.met)} of {len(cl.items)} condition(s) met; approved by "
            + (", ".join(f"{a['user']} ({a['role_label']})" for a in gs["approvals"]) or "nobody yet") + ".",
            "gate", cl.key, f"{base}/gates", items=[{"title": i.title, "met": i.met, "detail": i.detail,
                                                     "source": i.source} for i in cl.items]))
    if bp is not None:
        for row in plan_controls.matrix([m for m in _compliance(s, bp)]):
            sec["controls"].append(_item(
                f"Control {row['control']} ({row['pack']})", f"{row['rule']} Evidence: {row['evidence_required']}",
                "control", row["control"], f"{base}/plan/controls", gates=row["gates"]))
    # ---- tests
    for a in arts:
        sec["tests"].append(_item(
            f"Code tests: {a.name} v{a.version}", f"{a.test_summary.get('passed', 0)} of "
            f"{a.test_summary.get('tests', 0)} passed; {a.status}; approved by {_name(s, a.approved_by) or '—'}.",
            "build_artifact", a.id, f"/api/v1/build-artifacts/{a.id}"))
    for r in runs:
        if r.status != "succeeded":
            continue
        open_b = s.scalars(select(ReconBreak).where(ReconBreak.load_run_id == r.id)).all()
        sec["tests"].append(_item(
            f"Load run {r.number} ({r.kind})",
            f"Counts {r.summary.get('counts')}; {len(open_b)} reconciliation break(s), "
            f"{sum(1 for b in open_b if b.status == 'open')} open; result digest {(r.result_digest or '')[:16]}"
            + (f"; same result as run {r.summary['repeat_of']['run']}" if (r.summary.get("repeat_of") or {})
               .get("same_result") else ""), "load_run", r.id, f"/api/v1/load-runs/{r.id}"))
    for pr in s.scalars(select(ParityRun).where(ParityRun.project_id == p.id).order_by(ParityRun.created_at)):
        sec["tests"].append(_item(
            f"Parity ({pr.kind}): {pr.name}", f"{pr.summary.get('cases')} case(s), {pr.summary.get('differences')} "
            f"difference(s), {pr.summary.get('open')} open; {'passed' if pr.summary.get('passed') else 'not passed'}",
            "parity_run", pr.id, f"/api/v1/parity-runs/{pr.id}/cases"))
    # ---- agent records
    for pin in s.scalars(select(ProjectAgentPin).where(ProjectAgentPin.project_id == p.id)):
        v = s.scalar(select(AgentVersion).where(AgentVersion.agent_name == pin.agent_name,
                                                AgentVersion.version == pin.version))
        gov = agent_registry.governance_record(s, v) if v else {}
        sec["agents"].append(_item(
            f"Agent {pin.agent_name} {pin.version} (pinned)",
            f"Risk {(gov.get('governance') or {}).get('risk_rating')}; autonomy "
            f"{(gov.get('oversight') or {}).get('autonomy')}; pinned by {_name(s, pin.pinned_by)}.",
            "agent_version", f"{pin.agent_name}@{pin.version}",
            f"/api/v1/agents/{pin.agent_name}/versions/{pin.version}/governance"))
    for ar in s.scalars(select(AgentRun).where(AgentRun.project_id == p.id).order_by(AgentRun.created_at)):
        sec["agents"].append(_item(
            f"Agent run: {ar.agent_name} {ar.agent_version}", f"{ar.status}; {ar.model_calls} model call(s), "
            f"{ar.tool_calls} tool call(s), {ar.denied_tool_calls} denied; cost ${ar.cost_usd:.4f}",
            "agent_run", ar.id, f"/api/v1/agent-runs/{ar.id}"))
    # ---- cutover and decommission
    if choice:
        sec["cutover"].append(_item(f"Cutover approach: {choice.get('option')}", str(choice.get("reason")),
                                    "cutover_choice", "current", f"{base}/plan/cutover/choice"))
    if steps:
        sec["cutover"].append(_item(f"Runbook ({len(steps)} steps)", "; ".join(
            f"{x.get('title')} ({x.get('planned_minutes')} min)" for x in steps[:40]), "runbook", "current",
            f"{base}/plan/runbook"))
    for c in coexist:
        sec["cutover"].append(_item(f"Coexistence: {c.get('entity')} in {c.get('wave')}",
                                    f"System of record {c.get('system_of_record')} until {c.get('end_date')}; exit: "
                                    f"{c.get('exit_reconciliation')}", "coexistence", c.get("entity"),
                                    f"{base}/coexistence"))
    for cl in cls:
        if cl.key in ("cutover", "decommission"):
            for i in cl.items:
                sec[cl.key if cl.key == "decommission" else "cutover"].append(_item(
                    f"{cl.label}: {i.title}", ("Met. " if i.met else "Not met. ") + i.detail, "gate_item",
                    f"{cl.key}/{i.key}", (i.source or {}).get("href") or f"{base}/gates"))
    total = sum(len(v) for v in sec.values())
    return {"format": FORMAT, "project": {"id": str(p.id), "name": p.name, "tenant": t.name},
            "scope": "wave" if wave else "project", "wave": wave, "generated_at": datetime.now(UTC).isoformat(),
            "generated_by": by, "blueprint_version": bv.number if bv else None,
            "sections": [{"key": k, "title": title, "items": sec[k]} for k, title in SECTIONS],
            "counts": {k: len(v) for k, v in sec.items()}, "items": total}


def _accepted(summary: dict[str, Any], table: str) -> int:
    return int(((summary.get("tables") or {}).get(table) or {}).get("accepted", 0))


def _compliance(s: Session, bp: Any) -> list[Any]:
    from astra_migrate.packs import registry as pack_registry

    out = []
    for ref in bp.compliance_packs:
        try:
            pk = pack_registry.get_by_ref(s, ref, published_only=False)
        except ValueError:
            continue
        if pk is not None:
            out.append(pack_registry.manifest_of(pk))
    return out


def canonical(doc: dict[str, Any]) -> bytes:
    return json.dumps(doc, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str).encode()


def render_pdf(doc: dict[str, Any], json_sha256: str) -> bytes:
    from xml.sax.saxutils import escape

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import LongTable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, TableStyle

    buf = io.BytesIO()
    title = f"Proof pack — {doc['project']['name']}" + (f" — wave {doc['wave']}" if doc["wave"] else "")
    pdf = SimpleDocTemplate(buf, pagesize=A4, title=title, author="Astra Migrate", subject=f"sha256 {json_sha256}",
                            leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                            invariant=1)
    st = getSampleStyleSheet()
    small = ParagraphStyle("small", parent=st["BodyText"], fontSize=8, leading=10)
    cell = ParagraphStyle("cell", parent=st["BodyText"], fontSize=8, leading=10)

    def footer(c: Any, d: Any) -> None:
        c.saveState()
        c.setFont("Helvetica", 7)
        c.drawString(16 * mm, 10 * mm, f"{title} · structured data sha256 {json_sha256[:24]}…")
        c.drawRightString(A4[0] - 16 * mm, 10 * mm, f"Page {d.page}")
        c.restoreState()

    flow: list[Any] = [Paragraph(escape(title), st["Title"]),
                       Paragraph(escape(f"Tenant {doc['project']['tenant']} · scope {doc['scope']}"
                                        f" · generated {doc['generated_at']} by {doc['generated_by']}"), small),
                       Paragraph(escape(f"Blueprint version {doc['blueprint_version']} · {doc['items']} items · "
                                        f"structured data ({doc['format']}) sha256 {json_sha256}"), small),
                       Paragraph("This PDF is rendered from the structured proof pack. Both are signed together with "
                                 "the platform's vault-held Ed25519 key; verify with the published public key.",
                                 small), Spacer(1, 6 * mm)]
    summary = [["Section", "Items"]] + [[s_["title"], str(len(s_["items"]))] for s_ in doc["sections"]]
    tbl = LongTable(summary, colWidths=[110 * mm, 30 * mm])
    tbl.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), "Helvetica", 9), ("FONT", (0, 0), (-1, 0),
                                                                          "Helvetica-Bold", 9),
                             ("GRID", (0, 0), (-1, -1), 0.25, colors.grey)]))
    flow.append(tbl)
    for s_ in doc["sections"]:
        flow += [PageBreak(), Paragraph(escape(s_["title"]), st["Heading1"])]
        if not s_["items"]:
            flow.append(Paragraph("No records in this section.", small))
            continue
        rows = [[Paragraph("<b>Item</b>", cell), Paragraph("<b>Detail</b>", cell), Paragraph("<b>Source</b>", cell)]]
        for it in s_["items"]:
            src = it["source"]
            rows.append([Paragraph(escape(str(it["title"])), cell), Paragraph(escape(str(it["detail"]))[:3000], cell),
                         Paragraph(escape(f"{src['type']} {src['id']}") + "<br/>" + escape(str(src.get("href") or "")),
                                   cell)])
        t_ = LongTable(rows, colWidths=[48 * mm, 90 * mm, 40 * mm], repeatRows=1)
        t_.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                                ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke)]))
        flow.append(t_)
    pdf.build(flow, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()


def sign(json_sha: str, pdf_sha: str) -> tuple[str, int]:
    v = get_vault()
    v.ensure_signing_key(SIGNING_KEY)
    return v.sign(SIGNING_KEY, f"{json_sha}:{pdf_sha}".encode())


def verify(json_bytes: bytes, pdf_bytes: bytes, signature: str) -> dict[str, Any]:
    js, ps = hashlib.sha256(json_bytes).hexdigest(), hashlib.sha256(pdf_bytes).hexdigest()
    ok = get_vault().verify(SIGNING_KEY, f"{js}:{ps}".encode(), signature)
    return {"json_sha256": js, "pdf_sha256": ps, "signature_valid": ok}


def public_key() -> dict[str, Any]:
    v = get_vault()
    v.ensure_signing_key(SIGNING_KEY)
    info = v.key_info(SIGNING_KEY) or {}
    keys = info.get("keys") or {}
    return {"key": SIGNING_KEY, "type": info.get("type"), "algorithm": "Ed25519",
            "message": "utf-8 bytes of '<sha256 of the JSON>:<sha256 of the PDF>'",
            "versions": {str(k): (val.get("public_key") if isinstance(val, dict) else None) for k, val in keys.items()}}


def new_id() -> uuid.UUID:
    return uuid.uuid4()
