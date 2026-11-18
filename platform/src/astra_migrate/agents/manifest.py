"""Agent manifest (E02.F1.S1, E02.F3.S1).

An agent version is described by one YAML manifest: its role, instructions, allowed tools, data
access, guardrail limits, human oversight, governance facts and its test suite. The registry stores
the manifest, and the runtime enforces it.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

NAME_RE = r"^[a-z][a-z0-9-]{2,63}$"
SEMVER_RE = r"^\d+\.\d+\.\d+$"
TEAMS = ("coordination", "planning", "discovery", "execution", "agentification", "shared")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ModelSpec(_Strict):
    alias: str = Field(pattern=r"^[a-z][a-z0-9-]{1,59}$", description="Model alias resolved by the gateway")
    effort: Literal["low", "medium", "high", "xhigh", "max"] = "medium"
    max_tokens: int = Field(default=16000, ge=1024, le=64000)


class Guardrails(_Strict):
    screen_untrusted_inputs: Literal[True] = True
    max_model_calls: int = Field(default=20, ge=1, le=100)
    max_tool_calls: int = Field(default=30, ge=0, le=200)
    max_cost_usd: float = Field(default=2.0, gt=0, le=100)
    max_delegation_depth: int = Field(default=1, ge=0, le=3)


class Oversight(_Strict):
    autonomy: Literal["propose_only", "act_within_gates"]
    human_review: list[str] = Field(min_length=1, description="What people review or decide")
    escalation: str = Field(min_length=10)


class Governance(_Strict):
    risk_rating: Literal["low", "medium", "high"]
    risk_rationale: str = Field(min_length=20)
    intended_use: str = Field(min_length=20)
    out_of_scope: list[str] = Field(default_factory=list)
    regulatory_notes: str = ""


class ToolPolicyCase(_Strict):
    kind: Literal["tool_policy"]
    name: str = Field(min_length=3, max_length=120)
    tool: str
    expect: Literal["allowed", "denied"]


class ScreeningCase(_Strict):
    kind: Literal["screening"]
    name: str = Field(min_length=3, max_length=120)
    text: str = Field(min_length=1)
    expect_flagged: bool


class UntrustedInput(_Strict):
    source: str = Field(min_length=1, max_length=200)
    text: str


class ModelExpectations(_Strict):
    must_call: list[str] = Field(default_factory=list)
    must_not_call: list[str] = Field(default_factory=list)
    must_mention: list[str] = Field(default_factory=list, description="Case-insensitive text the answer contains")
    must_not_mention: list[str] = Field(default_factory=list)


class ModelCase(_Strict):
    kind: Literal["model"]
    name: str = Field(min_length=3, max_length=120)
    objective: str = Field(min_length=10)
    untrusted_inputs: list[UntrustedInput] = Field(default_factory=list)
    tool_fixtures: dict[str, Any] = Field(default_factory=dict, description="What each tool returns in the test")
    expect: ModelExpectations


TestCase = Annotated[ToolPolicyCase | ScreeningCase | ModelCase, Field(discriminator="kind")]


class AgentManifest(_Strict):
    api_version: Literal["astra.agents/v1"] = Field(alias="apiVersion")
    name: str = Field(pattern=NAME_RE)
    version: str = Field(pattern=SEMVER_RE)
    title: str = Field(min_length=3, max_length=200)
    team: Literal["coordination", "planning", "discovery", "execution", "agentification", "shared"]
    purpose: str = Field(min_length=20)
    data_access: Literal["metadata_only", "business_data"]
    model: ModelSpec
    instructions: str = Field(min_length=50)
    tools: list[str] = Field(default_factory=list)
    guardrails: Guardrails = Field(default_factory=Guardrails)
    oversight: Oversight
    governance: Governance
    tests: list[TestCase] = Field(min_length=1)

    @field_validator("tools")
    @classmethod
    def _unique(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v):
            raise ValueError("tools must not repeat")
        return v


def manifest_json_schema() -> dict[str, Any]:
    return AgentManifest.model_json_schema(by_alias=True)
