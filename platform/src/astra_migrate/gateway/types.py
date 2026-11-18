"""Provider-neutral request and response types for the model gateway.

Agents and the runtime speak only these types. Each driver translates them to its provider's API,
so a model can change (by changing an alias) without any agent changing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Role = Literal["user", "assistant"]
Stop = Literal["end", "tool_use", "max_tokens", "refusal", "other"]


@dataclass(frozen=True)
class ToolDef:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class TextPart:
    text: str


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]
    input_error: str | None = None  # set when the model's arguments were not valid JSON


@dataclass(frozen=True)
class ToolResult:
    call_id: str
    content: str
    is_error: bool = False


Part = TextPart | ToolCall | ToolResult


@dataclass
class Message:
    role: Role
    parts: list[Part]
    # Provider-native content of an assistant turn, replayed unchanged to the same provider kind
    # (it carries thinking blocks and fallback markers that must be passed back as they came).
    native: list[dict[str, Any]] | None = None
    native_kind: str | None = None


@dataclass
class ModelRequest:
    system: str
    messages: list[Message]
    tools: list[ToolDef] = field(default_factory=list)
    max_tokens: int = 16000
    effort: str | None = None  # low | medium | high | xhigh | max (mapped per provider)


@dataclass
class Usage:
    input_tokens: int = 0  # uncached input tokens
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass
class ModelResponse:
    parts: list[TextPart | ToolCall]
    stop: Stop
    raw_stop: str | None
    served_model: str | None
    request_id: str | None
    usage: Usage
    native: list[dict[str, Any]] | None = None
    native_kind: str | None = None
    refusal_category: str | None = None

    @property
    def text(self) -> str:
        return "\n".join(p.text for p in self.parts if isinstance(p, TextPart)).strip()

    @property
    def tool_calls(self) -> list[ToolCall]:
        return [p for p in self.parts if isinstance(p, ToolCall)]

    def as_message(self) -> Message:
        return Message("assistant", list(self.parts), self.native, self.native_kind)
