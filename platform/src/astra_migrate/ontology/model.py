"""Ontology content of a domain pack (E06.F2.S1, E06.F2.S2).

A domain pack's `content.ontology` defines concepts in its own namespace, with definitions, synonyms,
attributes and typed relations to concepts in its own or a required pack. Code lists carry their
values and the public standard they follow.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONCEPT = r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$"
NS = r"^[a-z][a-z0-9_]*$"
ATTR = r"^[a-z][a-z0-9_]*$"
RELATION_TYPES = ("is_a", "has", "part_of", "refers_to", "issued_by", "paid_by", "covers", "settles", "governs",
                  "split_of", "billed_to", "produced_by", "reported_in", "applies_to")


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Attribute(_M):
    name: Annotated[str, Field(pattern=ATTR)]
    type: Literal["text", "code", "date", "datetime", "money", "decimal", "integer", "boolean", "identifier",
                  "percentage"]
    description: str = Field(min_length=3)
    code_list: str | None = None


class Relation(_M):
    name: Annotated[str, Field(pattern=ATTR)]
    type: Literal["is_a", "has", "part_of", "refers_to", "issued_by", "paid_by", "covers", "settles", "governs",
                  "split_of", "billed_to", "produced_by", "reported_in", "applies_to"]
    target: Annotated[str, Field(pattern=CONCEPT)]
    cardinality: Literal["one", "many"] = "one"
    description: str = ""


class Concept(_M):
    id: Annotated[str, Field(pattern=CONCEPT)]
    label: str = Field(min_length=2, max_length=120)
    definition: str = Field(min_length=20)
    synonyms: list[str] = Field(default_factory=list)
    parent: Annotated[str, Field(pattern=CONCEPT)] | None = None
    attributes: list[Attribute] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)
    standards: list[str] = Field(default_factory=list, description="Public standard references for the concept")


class CodeValue(_M):
    code: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1)


class CodeList(_M):
    id: Annotated[str, Field(pattern=CONCEPT)]
    title: str = Field(min_length=3)
    standard: str = Field(min_length=2)
    values: list[CodeValue] = Field(min_length=1)


class Ontology(_M):
    namespace: Annotated[str, Field(pattern=NS)]
    concepts: list[Concept] = Field(min_length=1)
    code_lists: list[CodeList] = Field(default_factory=list)

    @model_validator(mode="after")
    def _consistency(self) -> Ontology:
        ids = [c.id for c in self.concepts]
        if len(ids) != len(set(ids)):
            raise ValueError("concept ids must be unique")
        for c in self.concepts:
            if not c.id.startswith(self.namespace + "."):
                raise ValueError(f"concept {c.id} must be in the pack's namespace '{self.namespace}'")
            names = [a.name for a in c.attributes] + [r.name for r in c.relations]
            if len(names) != len(set(names)):
                raise ValueError(f"concept {c.id} repeats an attribute or relation name")
        lists = {cl.id for cl in self.code_lists}
        for c in self.concepts:
            for a in c.attributes:
                if a.code_list and a.code_list.split(".")[0] == self.namespace and a.code_list not in lists:
                    raise ValueError(f"{c.id}.{a.name} refers to unknown code list {a.code_list}")
        return self

    def external_refs(self) -> set[str]:
        """Concepts this ontology points to in other namespaces (must come from required packs)."""
        out: set[str] = set()
        for c in self.concepts:
            if c.parent and not c.parent.startswith(self.namespace + "."):
                out.add(c.parent)
            for r in c.relations:
                if not r.target.startswith(self.namespace + "."):
                    out.add(r.target)
        return out

    def internal_dangling(self) -> list[str]:
        ids = {c.id for c in self.concepts}
        bad = []
        for c in self.concepts:
            for ref in ([c.parent] if c.parent else []) + [r.target for r in c.relations]:
                if ref.startswith(self.namespace + ".") and ref not in ids:
                    bad.append(f"{c.id} -> {ref}")
        return bad


class DomainContent(_M):
    ontology: Ontology

    @model_validator(mode="after")
    def _refs(self) -> DomainContent:
        bad = self.ontology.internal_dangling()
        if bad:
            raise ValueError("concepts refer to undefined concepts in this pack: " + ", ".join(bad[:10]))
        return self
