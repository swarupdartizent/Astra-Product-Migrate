"""Executable rule checks.

A domain pack states rules in plain language and can attach a check that the platform runs against
an estate. Checks speak only in ontology terms (concepts, attributes, relations). A source adapter's
entity bindings translate them to tables and columns, so the same rule runs on any product that binds
the concepts. Checks compile to one read-only SELECT each and return the keys of the rows that break
the rule.

Kinds:
  order        attribute `first` must not be after attribute `second` on the same concept
  within       a child concept's date must fall inside its parent's [start, end] range
  sum_equals   a parent's total must equal the sum of its children's parts, to a tolerance (default 0.00)
  not_null     attribute must be present
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from astra_migrate.adapters.contract import Entity, SourceAdapterContent
from astra_migrate.adapters.engines import Session

ATTR = r"^[a-z][a-z0-9_]*$"
CONCEPT = r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$"


class _C(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class OrderCheck(_C):
    kind: Literal["order"]
    concept: Annotated[str, Field(pattern=CONCEPT)]
    first: Annotated[str, Field(pattern=ATTR)]
    second: Annotated[str, Field(pattern=ATTR)]
    allow_equal: bool = True


class WithinCheck(_C):
    kind: Literal["within"]
    concept: Annotated[str, Field(pattern=CONCEPT)]
    date: Annotated[str, Field(pattern=ATTR)]
    relation: Annotated[str, Field(pattern=ATTR)] = Field(description="Relation from the concept to its parent")
    start: Annotated[str, Field(pattern=ATTR)]
    end: Annotated[str, Field(pattern=ATTR)]


class SumEqualsCheck(_C):
    kind: Literal["sum_equals"]
    concept: Annotated[str, Field(pattern=CONCEPT)]
    total: Annotated[str, Field(pattern=ATTR)]
    child_concept: Annotated[str, Field(pattern=CONCEPT)]
    child_relation: Annotated[str, Field(pattern=ATTR)] = Field(description="Relation from the child to the parent")
    part: Annotated[str, Field(pattern=ATTR)]
    tolerance: Decimal = Decimal("0.00")
    scale: int = Field(default=2, ge=0, le=6, description="Decimal places compared, 2 = to the cent")


class NotNullCheck(_C):
    kind: Literal["not_null"]
    concept: Annotated[str, Field(pattern=CONCEPT)]
    attribute: Annotated[str, Field(pattern=ATTR)]


Check = Annotated[OrderCheck | WithinCheck | SumEqualsCheck | NotNullCheck, Field(discriminator="kind")]
_ADAPTER: TypeAdapter[Any] = TypeAdapter(Check)


def parse_check(raw: dict[str, Any]) -> OrderCheck | WithinCheck | SumEqualsCheck | NotNullCheck:
    try:
        result: OrderCheck | WithinCheck | SumEqualsCheck | NotNullCheck = _ADAPTER.validate_python(raw)
    except ValidationError as e:
        raise ValueError("invalid check: " + "; ".join(
            f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors())) from e
    return result


class Unbound(ValueError):
    """The adapter does not bind a concept, attribute or relation the check needs."""


@dataclass
class CheckResult:
    rule_id: str
    status: str  # ran | unbound | error
    violations: list[str]
    detail: str = ""


class Bindings:
    def __init__(self, content: SourceAdapterContent) -> None:
        self.by_concept = {e.concept: e for e in content.entities if e.concept}
        self.by_name = {e.name: e for e in content.entities}

    def entity(self, concept: str) -> Entity:
        e = self.by_concept.get(concept)
        if e is None:
            raise Unbound(f"the adapter binds no entity to concept {concept}")
        return e

    @staticmethod
    def column(e: Entity, attr: str) -> str:
        col = e.attributes.get(attr)
        if col is None:
            raise Unbound(f"entity {e.name} binds no column to attribute {attr}")
        return col

    def relation(self, e: Entity, rel: str) -> tuple[Entity, str]:
        for name, r in e.relations.items():
            if rel in (name, r.concept_relation):
                return self.by_name[r.entity], r.column
        raise Unbound(f"entity {e.name} has no relation {rel}")


def _t(sess: Session, qualified: str) -> str:
    s, n = qualified.split(".", 1)
    return f"{sess.quote(s)}.{sess.quote(n)}"


def _key(sess: Session, alias: str, e: Entity) -> str:
    parts = [f"CAST({alias}.{sess.quote(k)} AS varchar(100))" for k in e.key]
    if len(parts) == 1:
        return parts[0]
    joined = " + '|' + ".join(parts)
    return f"({joined})"


def compile_check(sess: Session, b: Bindings, c: OrderCheck | WithinCheck | SumEqualsCheck | NotNullCheck) -> str:
    q = sess.quote
    if isinstance(c, OrderCheck):
        e = b.entity(c.concept)
        a, z = q(b.column(e, c.first)), q(b.column(e, c.second))
        op = ">" if c.allow_equal else ">="
        return (f"SELECT {_key(sess, 'x', e)} AS k FROM {_t(sess, e.table)} x "
                f"WHERE x.{a} IS NOT NULL AND x.{z} IS NOT NULL AND x.{a} {op} x.{z}")
    if isinstance(c, NotNullCheck):
        e = b.entity(c.concept)
        return (f"SELECT {_key(sess, 'x', e)} AS k FROM {_t(sess, e.table)} x "
                f"WHERE x.{q(b.column(e, c.attribute))} IS NULL")
    if isinstance(c, WithinCheck):
        e = b.entity(c.concept)
        parent, fk = b.relation(e, c.relation)
        if len(parent.key) != 1:
            raise Unbound(f"within checks need a single-column key on {parent.name}")
        d = q(b.column(e, c.date))
        s, en = q(b.column(parent, c.start)), q(b.column(parent, c.end))
        return (f"SELECT {_key(sess, 'x', e)} AS k FROM {_t(sess, e.table)} x "
                f"LEFT JOIN {_t(sess, parent.table)} p ON p.{q(parent.key[0])} = x.{q(fk)} "
                f"WHERE x.{d} IS NOT NULL AND (p.{q(parent.key[0])} IS NULL OR x.{d} < p.{s} OR x.{d} > p.{en})")
    e = b.entity(c.concept)
    child = b.entity(c.child_concept)
    parent_of_child, fk = b.relation(child, c.child_relation)
    if parent_of_child.name != e.name:
        raise Unbound(f"relation {c.child_relation} of {child.name} does not point to {e.name}")
    if len(e.key) != 1:
        raise Unbound(f"sum_equals checks need a single-column key on {e.name}")
    total, part = q(b.column(e, c.total)), q(b.column(child, c.part))
    tol = str(c.tolerance)
    return (f"SELECT {_key(sess, 'x', e)} AS k FROM {_t(sess, e.table)} x "
            f"LEFT JOIN (SELECT {q(fk)} AS pk, SUM({part}) AS s FROM {_t(sess, child.table)} GROUP BY {q(fk)}) c "
            f"ON c.pk = x.{q(e.key[0])} "
            f"WHERE x.{total} IS NOT NULL AND ABS(ROUND(x.{total}, {c.scale}) - ROUND(COALESCE(c.s, 0), {c.scale})) "
            f"> {tol}")


def run_checks(sess: Session, content: SourceAdapterContent, rules: list[tuple[str, dict[str, Any]]]
               ) -> list[CheckResult]:
    b = Bindings(content)
    out: list[CheckResult] = []
    for rule_id, raw in rules:
        chk = parse_check(raw)
        try:
            sql = compile_check(sess, b, chk)
        except Unbound as e:
            out.append(CheckResult(rule_id, "unbound", [], str(e)))
            continue
        try:
            rows = sess.query(sql)
        except Exception as e:
            out.append(CheckResult(rule_id, "error", [], str(e)[:300]))
            continue
        out.append(CheckResult(rule_id, "ran", sorted(str(r["k"]) for r in rows)))
    return out
