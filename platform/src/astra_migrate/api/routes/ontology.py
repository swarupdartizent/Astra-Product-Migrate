"""Ontology service endpoints (E06.F1.S1)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from astra_migrate.api.errors import forbidden, invalid, not_found
from astra_migrate.db.control import get_session
from astra_migrate.ontology import service
from astra_migrate.security.principal import CurrentPrincipal, Principal

router = APIRouter(tags=["ontology"], prefix="/ontology")
DB = Annotated[Session, Depends(get_session)]
Packs = Annotated[list[str] | None, Query(description="Pack refs (name@version) to answer from; default: latest")]


def _any_role(principal: Principal) -> None:
    if not principal.grants:
        raise forbidden()


def _call(fn: Any, *args: Any, **kw: Any) -> dict[str, Any]:
    try:
        result: dict[str, Any] = fn(*args, **kw)
    except service.OntologyError as e:
        msg = str(e)
        if "is not in ontology" in msg:
            raise not_found("Concept") from e
        raise invalid("packs" if "pack" in msg.lower() else "q", msg) from e
    return result


@router.get("/scope")
def scope(principal: CurrentPrincipal, s: DB, packs: Packs = None) -> dict[str, Any]:
    _any_role(principal)
    sc = _call(lambda: {"sc": service.scope(s, packs)})["sc"]
    counts = s.execute(text("SELECT pack_ref, count(*) FROM onto_concepts WHERE pack_id = ANY(:ids) GROUP BY pack_ref"),
                       {"ids": sc.pack_ids}).all()
    return {"ontology_version": sc.version, "packs": [{"ref": r, "concepts": n} for r, n in counts]}


@router.get("/concepts")
def browse(principal: CurrentPrincipal, s: DB, packs: Packs = None, namespace: str | None = None) -> dict[str, Any]:
    _any_role(principal)
    sc = _call(lambda: {"sc": service.scope(s, packs)})["sc"]
    sql = ("SELECT concept_id, label, parent, pack_ref, definition FROM onto_concepts WHERE pack_id = ANY(:ids)"
           + (" AND namespace = :ns" if namespace else "") + " ORDER BY concept_id")
    rows = s.execute(text(sql), {"ids": sc.pack_ids, "ns": namespace}).all()
    return {"ontology_version": sc.version, "concepts": [
        {"id": r.concept_id, "label": r.label, "parent": r.parent, "pack": r.pack_ref, "definition": r.definition}
        for r in rows]}


@router.get("/find")
def find(q: Annotated[str, Query(min_length=1, max_length=200)], principal: CurrentPrincipal, s: DB,
         packs: Packs = None, limit: Annotated[int, Query(ge=1, le=25)] = 5) -> dict[str, Any]:
    _any_role(principal)
    return _call(service.find_concept, s, q, packs, limit)


@router.get("/concepts/{concept_id}")
def concept(concept_id: str, principal: CurrentPrincipal, s: DB, packs: Packs = None) -> dict[str, Any]:
    _any_role(principal)
    return _call(service.get_concept, s, concept_id, packs)


@router.get("/concepts/{concept_id}/constraints")
def constraints(concept_id: str, principal: CurrentPrincipal, s: DB, packs: Packs = None) -> dict[str, Any]:
    _any_role(principal)
    return _call(service.get_constraints, s, concept_id, packs)


@router.get("/concepts/{concept_id}/bindings")
def bindings(concept_id: str, principal: CurrentPrincipal, s: DB, packs: Packs = None,
             adapter: str | None = None) -> dict[str, Any]:
    _any_role(principal)
    return _call(service.get_vendor_binding, s, concept_id, packs, adapter)


@router.get("/concepts/{concept_id}/precedents")
def precedents(concept_id: str, principal: CurrentPrincipal, s: DB, packs: Packs = None) -> dict[str, Any]:
    _any_role(principal)
    return _call(service.get_precedents, s, concept_id, packs)
