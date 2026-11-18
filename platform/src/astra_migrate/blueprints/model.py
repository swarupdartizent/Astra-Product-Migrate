"""Migration Blueprint schema (CF-01).

A blueprint is a versioned, declarative file that names the packs to use and the choices specific to
one customer. People change the blueprint, not the code. Field names follow the specification's example.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from astra_migrate.packs.schema import SETTING_KEY_RE, parse_ref

STREAMS = ("data", "configuration", "customizations", "integrations", "reports", "security", "process",
           "agentification", "platform")


def _ref(v: str) -> str:
    parse_ref(v)
    return v


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Endpoint(_Strict):
    adapter: str = Field(description="Adapter pack, pinned: name@1.2.0")
    connection: str | None = Field(default=None, description="secret://name of a tenant connector secret")
    load_method: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)

    _a = field_validator("adapter")(classmethod(lambda cls, v: _ref(v)))

    @field_validator("connection")
    @classmethod
    def _conn(cls, v: str | None) -> str | None:
        if v is not None and not v.startswith("secret://"):
            raise ValueError("Connections must refer to a secret, like secret://legacy-db-reader. "
                             "Never put credentials in a blueprint.")
        return v


class FreezePeriod(_Strict):
    start: date
    end: date
    reason: str = ""

    @model_validator(mode="after")
    def _order(self) -> FreezePeriod:
        if self.end < self.start:
            raise ValueError("A freeze period must end on or after its start date")
        return self


class Constraints(_Strict):
    cutover_window: str | None = Field(default=None, description="e.g. 'weekend, max 36h'")
    waves: str | None = Field(default=None, description="How to group waves, e.g. by-region")
    freeze_periods: list[FreezePeriod] = Field(default_factory=list)
    target_completion: date | None = None
    budget_person_days: int | None = Field(default=None, ge=0)
    notes: str = ""


class Planning(_Strict):
    mode: Literal["delivery", "pre_sales", "installed_base"] = "delivery"
    max_task_hours: int = Field(default=40, ge=1, le=40, description="No task may exceed 40 hours (PL-02)")
    risk_appetite: Literal["low", "medium", "high"] = "low"


class Approvals(_Strict):
    blueprint: list[str] = Field(default_factory=lambda: ["migration_lead", "customer_data_owner"], min_length=1)
    plan: list[str] = Field(default_factory=lambda: ["migration_lead", "customer_data_owner"], min_length=1)
    cutover: list[str] = Field(default_factory=list)


class Override(_Strict):
    setting: str = Field(pattern=SETTING_KEY_RE)
    value: int | float | bool | str
    reason: str = Field(min_length=10, description="Why the customer needs a different value")


class Documents(_Strict):
    retrieval_sample_size: int = Field(default=200, ge=1, le=100_000)


class Measure(_Strict):
    table: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$",
                       description="Target table (schema.name)")
    column: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    label: str = Field(default="", max_length=100, description="e.g. written premium, taxes, commissions")


class Validation(_Strict):
    measures: list[Measure] = Field(
        default_factory=list, description="Amounts reconciled to the cent after every load; when empty, every "
                                          "mapped decimal column is reconciled")
    blocking_rules_stop_load: bool = Field(default=True, description="Records failing a blocking rule are not sent")


class Blueprint(_Strict):
    api_version: Literal["astra.blueprints/v1"] = Field(alias="apiVersion")
    name: str = Field(min_length=3, max_length=120, pattern=r"^[a-z0-9][a-z0-9-]*$")
    description: str = ""
    pattern: Literal["cross_product", "same_family_upgrade", "consolidation"]
    cutover_strategy: Literal["whole_estate", "phased", "parallel_run"] | None = None
    source: Endpoint
    target: Endpoint
    domain_packs: list[str] = Field(default_factory=list)
    compliance_packs: list[str] = Field(default_factory=list)
    pattern_packs: list[str] = Field(default_factory=list)
    agentification_packs: list[str] = Field(default_factory=list)
    streams: dict[str, dict[str, Any]] = Field(default_factory=dict)
    constraints: Constraints = Field(default_factory=Constraints)
    planning: Planning = Field(default_factory=Planning)
    approvals: Approvals = Field(default_factory=Approvals)
    overrides: list[Override] = Field(default_factory=list)
    documents: Documents = Field(default_factory=Documents)
    validation: Validation = Field(default_factory=Validation)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator("domain_packs", "compliance_packs", "pattern_packs", "agentification_packs")
    @classmethod
    def _refs(cls, v: list[str]) -> list[str]:
        for r in v:
            _ref(r)
        if len({r.split("@")[0] for r in v}) != len(v):
            raise ValueError("Each pack may appear only once")
        return v

    @field_validator("streams")
    @classmethod
    def _streams(cls, v: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        unknown = set(v) - set(STREAMS)
        if unknown:
            raise ValueError(f"Unknown stream(s): {', '.join(sorted(unknown))}. Streams are: {', '.join(STREAMS)}")
        return v

    @field_validator("overrides")
    @classmethod
    def _overrides(cls, v: list[Override]) -> list[Override]:
        keys = [o.setting for o in v]
        if len(keys) != len(set(keys)):
            raise ValueError("Each setting may be overridden only once")
        return v

    def pack_slots(self) -> list[tuple[str, str, str]]:
        """(path, ref, expected pack type)."""
        out = [("source.adapter", self.source.adapter, "source_adapter"),
               ("target.adapter", self.target.adapter, "target_adapter")]
        for field, kind in (("domain_packs", "domain"), ("compliance_packs", "compliance"),
                            ("pattern_packs", "pattern"), ("agentification_packs", "agentification")):
            out += [(f"{field}[{i}]", r, kind) for i, r in enumerate(getattr(self, field))]
        return out


def json_schema() -> dict[str, Any]:
    return Blueprint.model_json_schema(by_alias=True)
