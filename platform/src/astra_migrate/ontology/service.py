"""Ontology service (E06.F1.S1): five operations agents and screens use instead of loading packs whole.

    find_concept       concepts matching a phrase (vector index + exact label/synonym match)
    get_concept        a single concept with its parents, attributes, relations (both directions), code lists
    get_constraints    rules from domain and target adapter packs that apply to the concept
    get_vendor_binding how source adapters bind the concept to product tables and columns
    get_precedents     earlier mapping decisions recorded for the concept

The store is Postgres: concepts and typed relations as a property graph (walked with recursive
queries) and a pgvector HNSW index for similarity. It is filled when a domain or source adapter pack
is published. Every answer names the ontology version: the exact pack versions it was answered from.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Row, select, text
from sqlalchemy.orm import Session

from astra_migrate.db.models import Pack
from astra_migrate.ontology import embed
from astra_migrate.packs.schema import Manifest, PackType


class OntologyError(ValueError):
    pass


@dataclass(frozen=True)
class Scope:
    pack_ids: list[uuid.UUID]
    refs: list[str]

    @property
    def version(self) -> str:
        return "+".join(sorted(self.refs)) or "(empty)"


def scope(session: Session, refs: list[str] | None = None) -> Scope:
    """Exact pack versions to answer from. Default: the latest published version of every domain pack."""
    if refs:
        rows = []
        for ref in refs:
            name, version = ref.split("@", 1) if "@" in ref else (ref, None)
            stmt = select(Pack).where(Pack.name == name, Pack.status.in_(("published", "deprecated")))
            if version:
                stmt = stmt.where(Pack.version == version)
            p = session.scalars(stmt.order_by(Pack.version_sort.desc())).first()
            if p is None:
                raise OntologyError(f"No published pack {ref}")
            rows.append(p)
    else:
        latest: dict[str, Pack] = {}
        for p in session.scalars(select(Pack).where(Pack.type == PackType.DOMAIN.value, Pack.status == "published")):
            if p.name not in latest or p.version_sort > latest[p.name].version_sort:
                latest[p.name] = p
        rows = list(latest.values())
    return Scope([p.id for p in rows], [f"{p.name}@{p.version}" for p in rows])


def _timed(fn: Any) -> Any:
    def wrapper(*a: Any, **kw: Any) -> dict[str, Any]:
        t0 = time.perf_counter()
        out: dict[str, Any] = fn(*a, **kw)
        out["elapsed_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        return out
    return wrapper


def _concept_row(r: Row[Any]) -> dict[str, Any]:
    return {"id": r.concept_id, "label": r.label, "definition": r.definition, "synonyms": list(r.synonyms or []),
            "parent": r.parent, "pack": r.pack_ref}


@_timed
def find_concept(session: Session, phrase: str, refs: list[str] | None = None, limit: int = 5) -> dict[str, Any]:
    sc = scope(session, refs)
    if not phrase.strip():
        raise OntologyError("Give a word or phrase to look for.")
    vec = embed.literal(embed.embed(phrase))
    rows = session.execute(text(
        "SELECT concept_id, label, definition, synonyms, parent, pack_ref, 1 - (embedding <=> CAST(:v AS vector)) "
        "AS score FROM onto_concepts WHERE pack_id = ANY(:ids) ORDER BY embedding <=> CAST(:v AS vector) LIMIT 25"),
        {"v": vec, "ids": sc.pack_ids}).all()
    needle = phrase.strip().lower()
    scored = []
    for r in rows:
        names = {r.label.lower(), r.concept_id.lower(), r.concept_id.split(".")[1].replace("_", " ")} | {
            s.lower() for s in (r.synonyms or [])}
        exact = needle in names
        scored.append({**_concept_row(r), "score": round(float(r.score) + (0.5 if exact else 0.0), 4),
                       "match": "exact" if exact else "similar"})
    scored.sort(key=lambda x: -x["score"])
    return {"ontology_version": sc.version, "query": phrase, "results": scored[:limit]}


def _one(session: Session, sc: Scope, concept_id: str) -> Row[Any]:
    r = session.execute(text(
        "SELECT concept_id, label, definition, synonyms, parent, pack_ref, attributes, standards FROM onto_concepts "
        "WHERE pack_id = ANY(:ids) AND concept_id = :c"), {"ids": sc.pack_ids, "c": concept_id}).first()
    if r is None:
        raise OntologyError(f"Concept {concept_id} is not in ontology {sc.version}")
    return r


@_timed
def get_concept(session: Session, concept_id: str, refs: list[str] | None = None) -> dict[str, Any]:
    sc = scope(session, refs)
    r = _one(session, sc, concept_id)
    ancestors = [dict(x._mapping) for x in session.execute(text(
        "WITH RECURSIVE up(id, parent, depth) AS ("
        "  SELECT concept_id, parent, 0 FROM onto_concepts WHERE pack_id = ANY(:ids) AND concept_id = :c"
        "  UNION ALL SELECT c.concept_id, c.parent, up.depth + 1"
        "  FROM onto_concepts c JOIN up ON c.concept_id = up.parent"
        "  WHERE c.pack_id = ANY(:ids) AND up.depth < 20)"
        " SELECT id, depth FROM up WHERE depth > 0 ORDER BY depth"), {"ids": sc.pack_ids, "c": concept_id})]
    out_rel = [dict(x._mapping) for x in session.execute(text(
        "SELECT name, type, target, cardinality, description FROM onto_relations WHERE pack_id = ANY(:ids) "
        "AND source = :c ORDER BY name"), {"ids": sc.pack_ids, "c": concept_id})]
    in_rel = [dict(x._mapping) for x in session.execute(text(
        "SELECT source, name, type, cardinality FROM onto_relations WHERE pack_id = ANY(:ids) AND target = :c "
        "ORDER BY source, name"), {"ids": sc.pack_ids, "c": concept_id})]
    children = [x[0] for x in session.execute(text(
        "SELECT concept_id FROM onto_concepts WHERE pack_id = ANY(:ids) AND parent = :c ORDER BY concept_id"),
        {"ids": sc.pack_ids, "c": concept_id})]
    attrs = list(r.attributes or [])
    lists = sorted({a["code_list"] for a in attrs if a.get("code_list")})
    code_lists = [dict(x._mapping) for x in session.execute(text(
        "SELECT list_id, title, standard, code_values FROM onto_code_lists WHERE pack_id = ANY(:ids) "
        "AND list_id = ANY(:l)"), {"ids": sc.pack_ids, "l": lists})] if lists else []
    return {"ontology_version": sc.version, "concept": {**_concept_row(r), "attributes": attrs,
                                                         "standards": list(r.standards or [])},
            "ancestors": [a["id"] for a in ancestors], "children": children, "relations": out_rel,
            "referenced_by": in_rel, "code_lists": code_lists}


def _published(session: Session, types: tuple[str, ...]) -> list[Pack]:
    latest: dict[str, Pack] = {}
    for p in session.scalars(select(Pack).where(Pack.type.in_(types), Pack.status == "published")):
        if p.name not in latest or p.version_sort > latest[p.name].version_sort:
            latest[p.name] = p
    return list(latest.values())


@_timed
def get_constraints(session: Session, concept_id: str, refs: list[str] | None = None) -> dict[str, Any]:
    sc = scope(session, refs)
    r = _one(session, sc, concept_id)
    lineage = {concept_id, *[a for a in get_concept(session, concept_id, refs)["ancestors"]]}
    names = {x.lower() for x in lineage} | {r.label.lower()}
    rules: list[dict[str, Any]] = []
    packs = [p for p in session.scalars(select(Pack).where(Pack.id.in_(sc.pack_ids)))]
    for p in packs:
        m = Manifest.model_validate(p.manifest)
        for rule in m.adds.rules:
            if {a.lower() for a in rule.applies_to} & names:
                rules.append({"id": rule.id, "statement": rule.statement, "severity": rule.severity,
                              "pack": m.ref, "kind": "domain_rule", "executable": rule.check is not None,
                              "sources": [s.reference for s in rule.sources]})
    for p in _published(session, (PackType.TARGET_ADAPTER.value,)):
        m = Manifest.model_validate(p.manifest)
        for c in (m.content.get("constraints") or []):
            if {str(a).lower() for a in c.get("applies_to", [])} & names:
                rules.append({"id": c["id"], "statement": c["statement"], "severity": "blocking",
                              "pack": m.ref, "kind": "target_constraint", "executable": False,
                              "sources": [c["source"]["reference"]], "recorded_on": c.get("recorded_on")})
    return {"ontology_version": sc.version, "concept": concept_id, "inherited_from": sorted(lineage - {concept_id}),
            "constraints": rules}


@_timed
def get_vendor_binding(session: Session, concept_id: str, refs: list[str] | None = None,
                       adapter: str | None = None) -> dict[str, Any]:
    sc = scope(session, refs)
    _one(session, sc, concept_id)
    params: dict[str, Any] = {"c": concept_id}
    sql = ("SELECT b.adapter_ref, b.entity, b.table_name, b.attributes, b.relations, b.validated "
           "FROM onto_bindings b JOIN packs p ON p.id = b.pack_id WHERE b.concept_id = :c "
           "AND p.status = 'published'")
    if adapter:
        sql += " AND b.adapter_ref LIKE :a"
        params["a"] = adapter + ("" if "@" in adapter else "@%")
    rows = [dict(x._mapping) for x in session.execute(text(sql + " ORDER BY b.adapter_ref"), params)]
    return {"ontology_version": sc.version, "concept": concept_id, "bindings": rows}


@_timed
def get_precedents(session: Session, concept_id: str, refs: list[str] | None = None, limit: int = 20
                   ) -> dict[str, Any]:
    sc = scope(session, refs)
    _one(session, sc, concept_id)
    rows = [dict(x._mapping) for x in session.execute(text(
        "SELECT adapter_ref, legacy_element, target_element, decision, rationale, decided_by_name, recorded_at "
        "FROM onto_precedents WHERE concept_id = :c ORDER BY recorded_at DESC LIMIT :n"),
        {"c": concept_id, "n": limit})]
    return {"ontology_version": sc.version, "concept": concept_id, "precedents": rows,
            "note": None if rows else "No mapping decisions have been recorded for this concept yet."}
