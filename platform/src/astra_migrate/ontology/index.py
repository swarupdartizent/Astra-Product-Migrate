"""Fill the ontology store when a domain or source adapter pack is published."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from astra_migrate.adapters.contract import parse_source
from astra_migrate.db.models import Pack
from astra_migrate.ontology import embed
from astra_migrate.ontology.model import DomainContent
from astra_migrate.packs.schema import Manifest, PackType


def concept_text(c: dict[str, Any]) -> str:
    syn = " ".join(str(s) for s in c.get("synonyms") or [])
    return f"{c['label']} {syn} {c['id']} {c['definition']}"


def index_pack(session: Session, pack: Pack) -> int:
    """Index a published pack. Returns the number of rows written."""
    m = Manifest.model_validate(pack.manifest)
    ref = f"{pack.name}@{pack.version}"
    session.execute(text("DELETE FROM onto_concepts WHERE pack_id = :p"), {"p": pack.id})
    session.execute(text("DELETE FROM onto_relations WHERE pack_id = :p"), {"p": pack.id})
    session.execute(text("DELETE FROM onto_code_lists WHERE pack_id = :p"), {"p": pack.id})
    session.execute(text("DELETE FROM onto_bindings WHERE pack_id = :p"), {"p": pack.id})
    n = 0
    if m.type == PackType.DOMAIN and "ontology" in m.content:
        onto = DomainContent.model_validate(m.content).ontology
        for c in onto.concepts:
            d = c.model_dump()
            session.execute(text(
                "INSERT INTO onto_concepts(pack_id, pack_ref, concept_id, namespace, label, definition, synonyms, "
                "parent, attributes, standards, embedding, embedder) VALUES (:p, :ref, :id, :ns, :label, :defn, "
                ":syn, :parent, CAST(:attrs AS jsonb), :std, CAST(:vec AS vector), :emb)"),
                {"p": pack.id, "ref": ref, "id": c.id, "ns": onto.namespace, "label": c.label,
                 "defn": c.definition, "syn": c.synonyms, "parent": c.parent,
                 "attrs": json.dumps([a.model_dump() for a in c.attributes]), "std": c.standards,
                 "vec": embed.literal(embed.embed(concept_text(d))), "emb": embed.NAME})
            n += 1
            for r in c.relations:
                session.execute(text(
                    "INSERT INTO onto_relations(pack_id, source, name, type, target, cardinality, description) "
                    "VALUES (:p, :s, :n, :t, :g, :c, :d)"),
                    {"p": pack.id, "s": c.id, "n": r.name, "t": r.type, "g": r.target, "c": r.cardinality,
                     "d": r.description})
                n += 1
        for cl in onto.code_lists:
            session.execute(text(
                "INSERT INTO onto_code_lists(pack_id, list_id, title, standard, code_values) "
                "VALUES (:p, :i, :t, :s, CAST(:v AS jsonb))"),
                {"p": pack.id, "i": cl.id, "t": cl.title, "s": cl.standard,
                 "v": json.dumps([v.model_dump() for v in cl.values])})
            n += 1
    if m.type == PackType.SOURCE_ADAPTER:
        content = parse_source(m.content)
        for e in content.entities:
            if not e.concept:
                continue
            session.execute(text(
                "INSERT INTO onto_bindings(pack_id, adapter_ref, concept_id, entity, table_name, attributes, "
                "relations, validated) VALUES (:p, :ref, :c, :e, :t, CAST(:a AS jsonb), CAST(:r AS jsonb), :v)"),
                {"p": pack.id, "ref": ref, "c": e.concept, "e": e.name, "t": e.table, "a": json.dumps(e.attributes),
                 "r": json.dumps({k: v.model_dump() for k, v in e.relations.items()}),
                 "v": content.validated_against_real_estate})
            n += 1
    return n
