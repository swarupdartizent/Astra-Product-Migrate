"""Pack manifest schema (CF-02, E04.F1.S1, E04.F2.S1, E07.F1.S1).

Every pack is a folder with a `pack.yaml` manifest and optional files. Packs declare what they need
(`requires`) and what they add (`adds`). There is deliberately no way to express removal: a pack can
add controls, gates, rules and settings, never take away what another pack added.

Settings are the values that can conflict between packs (for example a retention period). Each
setting declares which direction is stricter, so the composer can show the stricter value. It never
applies one silently: a person decides every conflict (CF-04).
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Annotated, Any, Literal

from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NAME_RE = r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
SETTING_KEY_RE = r"^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$"


class PackType(StrEnum):
    SOURCE_ADAPTER = "source_adapter"
    TARGET_ADAPTER = "target_adapter"
    DOMAIN = "domain"
    COMPLIANCE = "compliance"
    PATTERN = "pattern"
    AGENTIFICATION = "agentification"


class ControlType(StrEnum):
    DATA_HANDLING = "data_handling"
    APPROVAL = "approval"
    GATE = "gate"
    EVIDENCE = "evidence"
    RESIDENCY = "residency"
    RETENTION = "retention"


# Where the planner places each control type (spec: "Control types").
PLACEMENT: dict[ControlType, dict[str, str]] = {
    ControlType.DATA_HANDLING: {"area": "tasks", "detail": "Extraction and test-environment tasks"},
    ControlType.APPROVAL: {"area": "review_rules", "detail": "Review workbench rules"},
    ControlType.GATE: {"area": "lifecycle_gate", "detail": "Lifecycle gate"},
    ControlType.EVIDENCE: {"area": "proof_pack", "detail": "Proof pack contents"},
    ControlType.RESIDENCY: {"area": "hosting", "detail": "Hosting and model choice for the project"},
    ControlType.RETENTION: {"area": "decommission", "detail": "Archive tasks and decommission plan"},
}

LIFECYCLE_STAGES = ("configure", "discover", "plan", "design", "build_rehearse", "cutover", "stabilise",
                    "decommission")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _check_version(v: str) -> str:
    try:
        Version(v)
    except InvalidVersion as e:
        raise ValueError(f"'{v}' is not a valid version (use major.minor.patch)") from e
    if not re.fullmatch(r"\d+\.\d+\.\d+", v):
        raise ValueError("Use an exact version: major.minor.patch, for example 1.2.0")
    return v


class Requirement(Strict):
    name: Annotated[str, Field(pattern=NAME_RE)]
    versions: str = Field(default=">=0", description="PEP 440 specifier, e.g. '>=1.0,<2'")
    reason: str = ""

    @field_validator("versions")
    @classmethod
    def _spec(cls, v: str) -> str:
        try:
            SpecifierSet(v)
        except InvalidSpecifier as e:
            raise ValueError(f"'{v}' is not a valid version range") from e
        return v


class Source(Strict):
    """Where a control or rule comes from, so every obligation can be traced (E07.F2.S1)."""

    reference: str = Field(min_length=2, description="Framework clause or document, e.g. 'SOX ITGC CM-3'")
    url: str | None = None


class Control(Strict):
    id: Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$", description="e.g. SOX-CM-01")]
    type: ControlType
    title: str = Field(min_length=3)
    rule: str = Field(min_length=3, description="What must be true, in plain language")
    evidence_required: str = Field(min_length=3, description="What proves the control was met")
    sources: list[Source] = Field(min_length=1)
    gate: Literal["configure", "discover", "plan", "design", "build_rehearse", "cutover", "stabilise",
                  "decommission"] | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    compliance_critical: bool = False
    two_person_approval: bool = False

    @model_validator(mode="after")
    def _gate_needed(self) -> Control:
        if self.type == ControlType.GATE and self.gate is None:
            raise ValueError(f"{self.id}: a gate control must name the lifecycle gate it adds a condition to")
        if self.type == ControlType.RESIDENCY and not (
                {"allowed_jurisdictions", "model_calls_in_region"} & set(self.parameters)):
            raise ValueError(f"{self.id}: a residency control needs 'allowed_jurisdictions' and/or "
                             "'model_calls_in_region' parameters")
        if self.type == ControlType.APPROVAL and not self.parameters.get("applies_to"):
            raise ValueError(f"{self.id}: an approval control needs parameters.applies_to")
        return self


class Setting(Strict):
    """A value that can conflict with the same setting in another pack."""

    key: Annotated[str, Field(pattern=SETTING_KEY_RE, description="e.g. retention.policy_records.years")]
    value: int | float | bool | str
    stricter: Literal["higher", "lower", "true", "false", "none"] = Field(
        description="Which value is stricter: higher number, lower number, true, false, or none (no order)")
    unit: str | None = None
    description: str = ""
    sources: list[Source] = Field(default_factory=list)

    @model_validator(mode="after")
    def _type_matches(self) -> Setting:
        numeric = isinstance(self.value, int | float) and not isinstance(self.value, bool)
        if self.stricter in ("higher", "lower") and not numeric:
            raise ValueError(f"{self.key}: 'higher'/'lower' strictness needs a number")
        if self.stricter in ("true", "false") and not isinstance(self.value, bool):
            raise ValueError(f"{self.key}: 'true'/'false' strictness needs a yes/no value")
        return self


class Rule(Strict):
    """A domain or product rule agents and validators apply (e.g. 'a policy term cannot end before it starts')."""

    id: Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$")]
    statement: str = Field(min_length=3)
    applies_to: list[str] = Field(default_factory=list, description="Concept or element names")
    severity: Literal["blocking", "warning"] = "blocking"
    sources: list[Source] = Field(default_factory=list)
    check: dict[str, Any] | None = Field(
        default=None, description="Optional executable check (see astra_migrate.rules.checks); "
                                  "runs read-only against an estate through an adapter's concept bindings")

    @model_validator(mode="after")
    def _check_shape(self) -> Rule:
        if self.check is not None:
            from astra_migrate.rules.checks import parse_check

            try:
                parse_check(self.check)
            except ValueError as e:
                raise ValueError(f"{self.id}: {e}") from e
        return self


class Adds(Strict):
    controls: list[Control] = Field(default_factory=list)
    rules: list[Rule] = Field(default_factory=list)
    settings: list[Setting] = Field(default_factory=list)


class PackTestCase(Strict):
    """A declarative test the registry runs before publishing.

    kinds:
      contains_control: the pack must contain control `id`
      control_type:     control `id` must have type `expect`
      setting_value:    setting `key` must equal `expect`
      composes_with:    composing this pack with `packs` (name@version, from the registry) must succeed
                        and yield `expect_conflicts` conflicts
      golden_dataset:   a golden run of `dataset` (adapter@version:name) with this pack and `packs`, at their
                        current contents, must have passed
    """

    name: str = Field(min_length=3)
    kind: Literal["contains_control", "control_type", "setting_value", "composes_with", "golden_dataset"]
    id: str | None = None
    key: str | None = None
    expect: Any = None
    packs: list[str] = Field(default_factory=list)
    expect_conflicts: int | None = None
    dataset: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9-]*@\d+\.\d+\.\d+:[a-z][a-z0-9-]*$")


class Manifest(Strict):
    api_version: Literal["astra.packs/v1"] = Field(alias="apiVersion")
    type: PackType
    name: Annotated[str, Field(pattern=NAME_RE, max_length=64)]
    version: str
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=4000)
    publisher: str = Field(min_length=2, max_length=200)
    licence: str = Field(default="proprietary", max_length=100)
    standards: list[str] = Field(default_factory=list, description="Public standards the pack draws on")
    disclaimer: str | None = Field(default=None, description="Required for compliance packs")
    requires: list[Requirement] = Field(default_factory=list)
    adds: Adds = Field(default_factory=Adds)
    content: dict[str, Any] = Field(default_factory=dict,
                                    description="Type-specific content (adapter contract data, ontology, ...)")
    tests: list[PackTestCase] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    @field_validator("version")
    @classmethod
    def _v(cls, v: str) -> str:
        return _check_version(v)

    @model_validator(mode="after")
    def _consistency(self) -> Manifest:
        ids = [c.id for c in self.adds.controls] + [r.id for r in self.adds.rules]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"Duplicate control or rule ids: {', '.join(sorted(dupes))}")
        keys = [s.key for s in self.adds.settings]
        if len(keys) != len(set(keys)):
            raise ValueError("Each setting key may appear only once in a pack")
        if self.type == PackType.COMPLIANCE:
            if not self.disclaimer or "certif" not in self.disclaimer.lower():
                raise ValueError("A compliance pack must state that it supports, but does not certify, compliance")
            if not self.adds.controls:
                raise ValueError("A compliance pack must add at least one control")
        elif self.adds.controls:
            raise ValueError("Only compliance packs may add controls")
        if any(r.name == self.name for r in self.requires):
            raise ValueError("A pack cannot require itself")
        return self

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"


def parse_ref(ref: str) -> tuple[str, str]:
    """'name@1.2.0' -> ('name', '1.2.0')."""
    if "@" not in ref:
        raise ValueError(f"'{ref}' must name an exact version, like name@1.2.0")
    name, version = ref.split("@", 1)
    if not re.fullmatch(NAME_RE, name):
        raise ValueError(f"'{name}' is not a valid pack name")
    _check_version(version)
    return name, version


def manifest_json_schema() -> dict[str, Any]:
    return Manifest.model_json_schema(by_alias=True)
