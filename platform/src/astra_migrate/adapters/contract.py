"""Adapter contract `astra.adapters/v1` (E05.F1.S1).

Every product plugs into the platform through one contract. An adapter is a pack (type `source_adapter`
or `target_adapter`) whose `content` follows the models below; the platform supplies the generic
engine drivers, the read-only guard and the operations:

    connect        check the connection: engine, version, and that the account is read-only
    read_metadata  inventory every object type the adapter declares, with owner, last change and
                   dependencies, plus a coverage report of anything that could not be read
    read_code      the source text of code objects (procedures, triggers, views, ...)
    extract        entity data in full or as deltas, documents with their entity links, and counts
    list_traps     the adapter's known traps (shipped in the pack or added by curators), evaluated
                   against an estate
    load           target only: through the vendor's approved APIs or tools, never database writes
    report_limits  the product's constraints (each with a source and a date)

The contract is documented in docs/adapter-contract.md and versioned here. A change that breaks
existing adapters needs a new contract version.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from astra_migrate.adapters.sqlguard import ReadOnlyViolation, check_read_only

CONTRACT_VERSION = "astra.adapters/v1"
ENGINES = ("sqlserver", "sqlanywhere")
IDENT = r"^[A-Za-z_][A-Za-z0-9_]*$"
QUALIFIED = r"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$"
KEY = r"^[a-z][a-z0-9_]*$"
CONCEPT = r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$"

Engine = Literal["sqlserver", "sqlanywhere"]


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Product(_M):
    name: str = Field(min_length=2, max_length=200)
    versions: list[str] = Field(min_length=1, description="Product versions the adapter covers")


class EngineSupport(_M):
    engine: Engine
    min_version: str | None = Field(default=None, description="Lowest engine major.minor supported, e.g. '11.0'")
    notes: str = ""


def _read_only(sql: str, where: str) -> str:
    try:
        check_read_only(sql)
    except ReadOnlyViolation as e:
        raise ValueError(f"{where}: {e}") from e
    return sql


class ObjectType(_M):
    """One kind of object the adapter inventories (E05.F2.S2).

    `query` returns one row per object with columns: name (required), schema, owner, modified_at,
    definition (code objects), detail (JSON text, optional). `dependencies` returns rows of
    (name, depends_on) for this object type.
    """

    key: Annotated[str, Field(pattern=KEY)]
    label: str = Field(min_length=2)
    code: bool = Field(default=False, description="Objects of this type have source code to read")
    queries: dict[Engine, str] = Field(min_length=1)
    dependencies: dict[Engine, str] = Field(default_factory=dict)
    required: bool = Field(default=True, description="Missing this type makes the coverage report incomplete")
    interface: bool = Field(default=False, description="Each object of this type is an interface to another system")
    compare_as: Annotated[str, Field(pattern=KEY)] | None = Field(
        default=None, description="Baseline object type the version delta compares these objects with (E09.F1)")
    customization: bool = Field(
        default=False, description="Every object of this type is a customer extension, not part of the product")

    @model_validator(mode="after")
    def _ro(self) -> ObjectType:
        for eng, q in self.queries.items():
            _read_only(q, f"object_types.{self.key}.queries.{eng}")
        for eng, q in self.dependencies.items():
            _read_only(q, f"object_types.{self.key}.dependencies.{eng}")
        return self


class Relation(_M):
    entity: Annotated[str, Field(pattern=KEY)]
    column: Annotated[str, Field(pattern=IDENT)]
    concept_relation: str | None = Field(default=None, description="Ontology relation this foreign key expresses")


class Entity(_M):
    """A business entity the adapter extracts (E05.F2.S3) and binds to an ontology concept (E06)."""

    name: Annotated[str, Field(pattern=KEY)]
    table: Annotated[str, Field(pattern=QUALIFIED)]
    key: list[Annotated[str, Field(pattern=IDENT)]] = Field(min_length=1)
    delta_column: Annotated[str, Field(pattern=IDENT)] | None = Field(
        default=None, description="Last-changed timestamp column; enables delta extraction")
    concept: Annotated[str, Field(pattern=CONCEPT)] | None = None
    attributes: dict[Annotated[str, Field(pattern=KEY)], Annotated[str, Field(pattern=IDENT)]] = Field(
        default_factory=dict, description="Concept attribute -> column")
    relations: dict[Annotated[str, Field(pattern=KEY)], Relation] = Field(default_factory=dict)


class DocumentStore(_M):
    """An embedded document store: each document links to the entity it belongs to."""

    table: Annotated[str, Field(pattern=QUALIFIED)]
    key: Annotated[str, Field(pattern=IDENT)]
    name_column: Annotated[str, Field(pattern=IDENT)]
    content_column: Annotated[str, Field(pattern=IDENT)] | None = None
    created_column: Annotated[str, Field(pattern=IDENT)] | None = None
    delta_column: Annotated[str, Field(pattern=IDENT)] | None = None
    link_type_column: Annotated[str, Field(pattern=IDENT)]
    link_key_column: Annotated[str, Field(pattern=IDENT)]
    link_types: dict[str, Annotated[str, Field(pattern=KEY)]] = Field(
        min_length=1, description="Value in link_type_column -> entity name")


class TrapDetect(_M):
    kind: Literal["object_exists", "query"]
    object_type: Annotated[str, Field(pattern=KEY)] | None = None
    name_pattern: str | None = Field(default=None, description="Regular expression on object names")
    definition_pattern: str | None = Field(default=None, description="Regular expression on code text")
    queries: dict[Engine, str] = Field(default_factory=dict, description="Rows returned are the hits")

    @model_validator(mode="after")
    def _shape(self) -> TrapDetect:
        if self.kind == "object_exists" and not self.object_type:
            raise ValueError("object_exists traps need object_type")
        if self.kind == "query" and not self.queries:
            raise ValueError("query traps need queries")
        for pat in (self.name_pattern, self.definition_pattern):
            if pat:
                re.compile(pat)
        for eng, q in self.queries.items():
            _read_only(q, f"traps.detect.queries.{eng}")
        return self


class SourceRef(_M):
    reference: str = Field(min_length=2)
    url: str | None = None


class Trap(_M):
    """A known problem in the product that earlier projects hit (E05.F2.S4)."""

    id: Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$")]
    title: str = Field(min_length=5)
    description: str = Field(min_length=10)
    severity: Literal["high", "medium", "low"]
    stream: str = Field(min_length=2, description="Migration stream the trap affects, e.g. data or integrations")
    advice: str = Field(min_length=10)
    detect: TrapDetect
    sources: list[SourceRef] = Field(default_factory=list)


class CodeListSource(_M):
    name: Annotated[str, Field(pattern=KEY)]
    table: Annotated[str, Field(pattern=QUALIFIED)]
    code_column: Annotated[str, Field(pattern=IDENT)]
    label_column: Annotated[str, Field(pattern=IDENT)]


class SoftRelation(_M):
    """A reference the database does not enforce (no foreign key), which profiling still checks."""

    from_table: Annotated[str, Field(pattern=QUALIFIED)]
    from_column: Annotated[str, Field(pattern=IDENT)]
    to_table: Annotated[str, Field(pattern=QUALIFIED)]
    to_column: Annotated[str, Field(pattern=IDENT)]


class Dictionary(_M):
    """How to read the data dictionary (E08.F1.S1).

    `columns` returns: table_schema, table_name, column_name, data_type, max_length, nullable, ordinal.
    `relations` returns: name, from_schema, from_table, from_column, to_schema, to_table, to_column.
    """

    columns: dict[Engine, str] = Field(min_length=1)
    relations: dict[Engine, str] = Field(default_factory=dict)
    code_lists: list[CodeListSource] = Field(default_factory=list)
    soft_relations: list[SoftRelation] = Field(default_factory=list)
    profile_exclude: list[str] = Field(default_factory=list, description="Tables (schema.name) not profiled")

    @model_validator(mode="after")
    def _ro(self) -> Dictionary:
        for eng, q in self.columns.items():
            _read_only(q, f"dictionary.columns.{eng}")
        for eng, q in self.relations.items():
            _read_only(q, f"dictionary.relations.{eng}")
        return self


class ConfigurationKind(_M):
    """One kind of configuration item (E08.F2.S3).

    The query returns: key, name, scope (for example a book code, or NULL for global items), definition
    (text or JSON) and depends_on (comma-separated `kind:key` references).
    """

    kind: Annotated[str, Field(pattern=KEY)]
    label: str = Field(min_length=2)
    queries: dict[Engine, str] = Field(min_length=1)

    @model_validator(mode="after")
    def _ro(self) -> ConfigurationKind:
        for eng, q in self.queries.items():
            _read_only(q, f"configuration.{self.kind}.queries.{eng}")
        return self


class Activity(_M):
    """Engine usage statistics and how to recognise the product's own clients (E08.F1.S3, E08.F2.S2).

    `table_usage` returns: table_schema, table_name, reads, writes, last_read, last_write, since.
    `sessions` returns: login, host, program (current connections).
    """

    table_usage: dict[Engine, str] = Field(default_factory=dict)
    sessions: dict[Engine, str] = Field(default_factory=dict)
    product_clients: list[str] = Field(
        default_factory=list, description="Regular expressions on program names that are the product's own clients")

    @model_validator(mode="after")
    def _ro(self) -> Activity:
        for eng, q in {**self.table_usage, **self.sessions}.items():
            _read_only(q, f"activity.{eng}")
        for p in self.product_clients:
            re.compile(p)
        return self


class GoldenDataset(_M):
    name: Annotated[str, Field(pattern=r"^[a-z][a-z0-9-]*$")]
    path: str = Field(description="Folder inside the pack holding dataset.yaml, schema and expected answers")
    engine: Engine
    description: str = ""


class SourceAdapterContent(_M):
    contract: Literal["astra.adapters/v1"]
    product: Product
    engines: list[EngineSupport] = Field(min_length=1)
    object_types: list[ObjectType] = Field(min_length=1)
    entities: list[Entity] = Field(default_factory=list)
    documents: DocumentStore | None = None
    traps: list[Trap] = Field(default_factory=list)
    dictionary: Dictionary | None = None
    configuration: list[ConfigurationKind] = Field(default_factory=list)
    activity: Activity | None = None
    golden_datasets: list[GoldenDataset] = Field(default_factory=list)
    validated_against_real_estate: bool = Field(
        default=False, description="False until the queries have run against a real customer or vendor estate")

    @model_validator(mode="after")
    def _consistency(self) -> SourceAdapterContent:
        engines = {e.engine for e in self.engines}
        keys = [o.key for o in self.object_types]
        if len(keys) != len(set(keys)):
            raise ValueError("object type keys must be unique")
        for o in self.object_types:
            missing = engines - set(o.queries)
            if missing:
                raise ValueError(f"object type '{o.key}' has no query for engine(s): {', '.join(sorted(missing))}")
        names = [e.name for e in self.entities]
        if len(names) != len(set(names)):
            raise ValueError("entity names must be unique")
        for e in self.entities:
            for rel_name, rel in e.relations.items():
                if rel.entity not in names:
                    raise ValueError(f"entity '{e.name}' relation '{rel_name}' points to unknown entity '{rel.entity}'")
        if self.documents:
            for t, ent in self.documents.link_types.items():
                if ent not in names:
                    raise ValueError(f"document link type '{t}' points to unknown entity '{ent}'")
        trap_ids = [t.id for t in self.traps]
        if len(trap_ids) != len(set(trap_ids)):
            raise ValueError("trap ids must be unique")
        for trap in self.traps:
            if trap.detect.kind == "object_exists" and trap.detect.object_type not in keys:
                raise ValueError(f"trap {trap.id} refers to unknown object type '{trap.detect.object_type}'")
        return self


# ------------------------------------------------------------------ target adapters

class Constraint(_M):
    """A real limit of the target product, with where it comes from and when it was recorded (E05.F3.S3)."""

    id: Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$")]
    kind: Literal["database_access", "load_tool", "api_limit", "forms", "workflow", "provisioning",
                  "change_window", "identity", "other"]
    title: str = Field(min_length=5)
    statement: str = Field(min_length=10, description="The constraint as a rule planners and designers follow")
    applies_to: list[str] = Field(default_factory=list)
    value: Any = None
    source: SourceRef
    recorded_on: date
    confidence: Literal["confirmed", "reported", "assumed"] = Field(
        description="confirmed by the vendor in writing, reported by product experts, or assumed")


class RateLimit(_M):
    requests_per_minute: int = Field(gt=0, le=100_000)
    burst: int = Field(default=1, gt=0)
    source: SourceRef
    recorded_on: date


class LoadEndpoint(_M):
    entity: Annotated[str, Field(pattern=KEY)]
    method: Literal["POST", "PUT", "PATCH"]
    path: str = Field(pattern=r"^/[A-Za-z0-9_\-/{}.]*$")
    batch_size: int = Field(default=1, ge=1, le=10_000)


class Load(_M):
    """How data reaches the target. There is deliberately no database method (E05.F3.S2)."""

    method: Literal["rest_api", "vendor_tool"]
    auth: Literal["oauth2_client_credentials"]
    token_path: str | None = Field(default=None, pattern=r"^/[A-Za-z0-9_\-/.]*$",
                                   description="Unset until the vendor documents it; loads are then Blocked")
    scopes: list[str] = Field(default_factory=list)
    endpoints: list[LoadEndpoint] = Field(default_factory=list)
    rate_limit: RateLimit
    approved_tools: list[str] = Field(default_factory=list, description="Vendor-approved bulk tools, if any")


class TargetAdapterContent(_M):
    contract: Literal["astra.adapters/v1"]
    product: Product
    load: Load
    constraints: list[Constraint] = Field(min_length=1)
    baseline_format: Literal["astra.baseline/v1"] = "astra.baseline/v1"
    validated_against_real_target: bool = False

    @field_validator("constraints")
    @classmethod
    def _unique(cls, v: list[Constraint]) -> list[Constraint]:
        ids = [c.id for c in v]
        if len(ids) != len(set(ids)):
            raise ValueError("constraint ids must be unique")
        return v

    @model_validator(mode="after")
    def _no_db_writes(self) -> TargetAdapterContent:
        if not any(c.kind == "database_access" for c in self.constraints):
            raise ValueError("a target adapter must state its database access constraint (kind database_access)")
        return self


# ------------------------------------------------------------------ baselines (E05.F3.S1)

class BaselineObject(_M):
    type: Annotated[str, Field(pattern=KEY)]
    name: str = Field(min_length=1, max_length=300)
    schema_: str | None = Field(default=None, alias="schema")
    columns: list[dict[str, Any]] = Field(default_factory=list)
    definition_sha256: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class Baseline(_M):
    format: Literal["astra.baseline/v1"]
    product: str = Field(min_length=2)
    product_version: str = Field(min_length=1)
    provided_by: str = Field(min_length=2)
    provided_on: date
    objects: list[BaselineObject] = Field(min_length=1)


# ------------------------------------------------------------------ results

class ConnectionCheck(_M):
    ok: bool
    engine: str
    engine_version: str | None
    edition: str | None = None
    database: str | None = None
    login: str | None = None
    read_only: bool
    read_only_evidence: list[str] = Field(default_factory=list)
    supported: bool
    problems: list[str] = Field(default_factory=list)


def parse_source(content: dict[str, Any]) -> SourceAdapterContent:
    return SourceAdapterContent.model_validate(content)


def parse_target(content: dict[str, Any]) -> TargetAdapterContent:
    return TargetAdapterContent.model_validate(content)
