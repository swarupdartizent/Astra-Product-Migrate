"""Gates with checklists (E17.F1.S1) and signed proof packs (E17.F2.S1)."""

from __future__ import annotations

import hashlib
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit, gates, proof
from astra_migrate.api.errors import conflict, forbidden, invalid, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import ProofPack, Tenant, User
from astra_migrate.security.principal import CurrentPrincipal, Principal, project_for
from astra_migrate.security.rbac import P
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

router = APIRouter(tags=["gates"])
DB = Annotated[Session, Depends(get_session)]


def _gate_problem(e: gates.GateError) -> Exception:
    if e.status == 422:
        return invalid(e.field or "body", str(e))
    if e.status == 403:
        return forbidden(str(e))
    if e.status == 404:
        return not_found(str(e))
    return conflict("The gate cannot be approved yet", str(e))


@router.get("/projects/{project_id}/gates")
def list_gates(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    return {"gates": [gates.as_dict(s, p, cl) for cl in gates.checklists(s, t, p)],
            "my_roles": sorted(principal.roles_on_project(t, p.id)),
            "can_attest": principal.has_on_project(P.STAGE_MANAGE, t, p.id)
            or principal.has_on_project(P.REVIEW_RESOLVE, t, p.id)}


class EvidenceIn(BaseModel):
    item_key: str = Field(max_length=200)
    note: str = Field(min_length=10, max_length=4000)
    reference: str | None = Field(default=None, max_length=1000,
                                  description="Where the evidence is: a document link, ticket or record id")


@router.put("/projects/{project_id}/gates/{gate}/evidence")
def attest(project_id: uuid.UUID, gate: str, body: EvidenceIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    try:
        gates.attest(s, principal, t, p, gate, body.item_key, body.note, body.reference)
    except gates.GateError as e:
        raise _gate_problem(e) from e
    cl = next(c for c in gates.checklists(s, t, p) if c.key == gate)
    return gates.as_dict(s, p, cl)


class ApprovalIn(BaseModel):
    role: str = Field(max_length=60)
    note: str = Field(default="", max_length=2000)


@router.post("/projects/{project_id}/gates/{gate}/approvals")
def approve(project_id: uuid.UUID, gate: str, body: ApprovalIn, principal: CurrentPrincipal, s: DB
            ) -> dict[str, Any]:
    """Approve the gate's checklist as it is now, for one of your roles. The gate passes when every required role
    has approved this exact checklist, each by a different person."""
    t, p = project_for(s, principal, project_id, None)
    try:
        return gates.approve(s, principal, t, p, gate, body.role, body.note)
    except gates.GateError as e:
        raise _gate_problem(e) from e


# ------------------------------------------------------------------ proof packs

def _pack_out(s: Session, k: ProofPack) -> dict[str, Any]:
    u = s.get(User, k.created_by)
    return {"id": str(k.id), "number": k.number, "scope": k.scope, "wave": k.wave, "json_sha256": k.json_sha256,
            "pdf_sha256": k.pdf_sha256, "signature": k.signature, "signing_key": k.signing_key,
            "key_version": k.key_version, "summary": k.summary, "created_by": u.display_name if u else None,
            "created_at": k.created_at.isoformat() if k.created_at else None,
            "document_url": f"/api/v1/proof-packs/{k.id}/document", "pdf_url": f"/api/v1/proof-packs/{k.id}/pdf"}


class PackIn(BaseModel):
    wave: str | None = Field(default=None, max_length=40, description="A wave key for a wave pack; empty for the "
                                                                       "whole project")


@router.post("/projects/{project_id}/proof-packs", status_code=201)
def create_pack(project_id: uuid.UUID, body: PackIn, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, P.STAGE_MANAGE)
    if body.wave:
        with tenant_connection(t, get_vault()) as tc:
            if tc.execute("SELECT 1 FROM estate.plan_items WHERE project_id = %s AND kind = 'wave' AND key = %s",
                          (p.id, body.wave)).fetchone() is None:
                raise invalid("wave", "No such wave in the plan.")
    doc = proof.build(s, t, p, body.wave or None, principal.user.display_name)
    data = proof.canonical(doc)
    js = hashlib.sha256(data).hexdigest()
    pdf = proof.render_pdf(doc, js)
    ps = hashlib.sha256(pdf).hexdigest()
    signature, version = proof.sign(js, ps)
    number = (s.scalar(select(ProofPack.number).where(ProofPack.project_id == p.id)
                       .order_by(ProofPack.number.desc()).limit(1)) or 0) + 1
    k = ProofPack(tenant_id=t.id, project_id=p.id, number=number, scope="wave" if body.wave else "project",
                  wave=body.wave or None, json_sha256=js, pdf_sha256=ps, signature=signature,
                  signing_key=proof.SIGNING_KEY, key_version=version,
                  summary={"counts": doc["counts"], "items": doc["items"], "bytes": len(pdf)},
                  created_by=principal.user.id)
    s.add(k)
    s.flush()
    with tenant_connection(t, get_vault()) as tc, tc.transaction():
        migrate_tenant_schema(tc)
        tc.execute("INSERT INTO estate.proof_pack_files(pack_id, document, pdf) VALUES (%s, %s, %s)",
                   (k.id, data.decode(), pdf))
    audit.record(s, principal.actor, "proof.pack_signed", tenant_id=t.id, project_id=p.id, target_type="proof_pack",
                 target_id=str(k.id), details={"number": number, "scope": k.scope, "wave": k.wave, "json_sha256": js,
                                               "pdf_sha256": ps, "key_version": version, "items": doc["items"]})
    return _pack_out(s, k)


@router.get("/projects/{project_id}/proof-packs")
def list_packs(project_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    t, p = project_for(s, principal, project_id, None)
    with tenant_connection(t, get_vault()) as tc:
        waves = [k for (k,) in tc.execute("SELECT key FROM estate.plan_items WHERE project_id = %s AND kind = 'wave' "
                                          "ORDER BY key", (p.id,)).fetchall()]
    return {"packs": [_pack_out(s, k) for k in s.scalars(select(ProofPack).where(ProofPack.project_id == p.id)
                                                          .order_by(ProofPack.number.desc()))],
            "waves": waves, "can_create": principal.has_on_project(P.STAGE_MANAGE, t, p.id)}


@router.get("/proof-packs/signing-key")
def signing_key(principal: CurrentPrincipal) -> dict[str, Any]:
    """The public key that verifies proof packs offline."""
    return proof.public_key()


def _pack(s: Session, principal: Principal, pack_id: uuid.UUID) -> tuple[Tenant, ProofPack, bytes, bytes]:
    k = s.get(ProofPack, pack_id)
    if k is None:
        raise not_found("Proof pack")
    t, _ = project_for(s, principal, k.project_id, None)
    with tenant_connection(t, get_vault()) as tc:
        row = tc.execute("SELECT document, pdf FROM estate.proof_pack_files WHERE pack_id = %s", (k.id,)).fetchone()
    if row is None:
        raise not_found("Proof pack content")
    return t, k, str(row[0]).encode(), bytes(row[1])


@router.get("/proof-packs/{pack_id}")
def get_pack(pack_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    k = s.get(ProofPack, pack_id)
    if k is None:
        raise not_found("Proof pack")
    project_for(s, principal, k.project_id, None)
    return _pack_out(s, k)


@router.get("/proof-packs/{pack_id}/document")
def pack_document(pack_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> Response:
    _t, k, data, _pdf = _pack(s, principal, pack_id)
    return Response(data, media_type="application/json", headers={
        "Content-Disposition": f'attachment; filename="proof-pack-{k.number}.json"', "X-Content-SHA256": k.json_sha256,
        "X-Signature": k.signature})


@router.get("/proof-packs/{pack_id}/pdf")
def pack_pdf(pack_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> Response:
    _t, k, _data, pdf = _pack(s, principal, pack_id)
    return Response(pdf, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="proof-pack-{k.number}.pdf"', "X-Content-SHA256": k.pdf_sha256,
        "X-Signature": k.signature})


@router.get("/proof-packs/{pack_id}/verify")
def verify_pack(pack_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Recompute both digests from the stored files and verify the signature."""
    _t, k, data, pdf = _pack(s, principal, pack_id)
    res = proof.verify(data, pdf, k.signature)
    return {**res, "matches_record": res["json_sha256"] == k.json_sha256 and res["pdf_sha256"] == k.pdf_sha256,
            "valid": res["signature_valid"] and res["json_sha256"] == k.json_sha256
            and res["pdf_sha256"] == k.pdf_sha256, "key_version": k.key_version}
