"""Provider drivers. Each translates the neutral types to one provider API through its official SDK.

- `anthropic`: the Anthropic API (enterprise terms: no training on customer data).
- `anthropic_foundry`: Claude on Microsoft Foundry (Azure enterprise endpoint).
- `azure_openai`: OpenAI models on Azure OpenAI (Azure enterprise endpoint).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

import anthropic
import openai

from astra_migrate.gateway.types import (
    Message,
    ModelRequest,
    ModelResponse,
    Stop,
    TextPart,
    ToolCall,
    ToolResult,
    Usage,
)

# Models that accept server-side refusal fallbacks (the API re-runs a declined request on a fallback
# model inside the same call). The served model is always recorded from the response.
_FALLBACK_PREFIXES = ("claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"
DEFAULT_AZURE_OPENAI_API_VERSION = "2024-10-21"


class ProviderCallError(Exception):
    """A provider call failed. `retryable` is False for errors a retry cannot fix (bad key, bad request)."""

    def __init__(self, message: str, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable, self.status = retryable, status


@dataclass(frozen=True)
class DriverConfig:
    kind: str
    endpoint: str | None
    api_version: str | None
    api_key: str
    options: dict[str, Any]


class Driver(Protocol):
    sdk_version: str

    def api_version(self) -> str | None: ...
    def complete(self, model: str, req: ModelRequest) -> ModelResponse: ...
    def check(self) -> str: ...


# ===================================================================== Anthropic (API and Foundry)

class AnthropicDriver:
    sdk_version = f"anthropic-python {anthropic.__version__}"

    def __init__(self, cfg: DriverConfig) -> None:
        self.cfg = cfg
        common: dict[str, Any] = {"api_key": cfg.api_key, "max_retries": 2, "timeout": 600.0}
        if cfg.kind == "anthropic_foundry":
            if not cfg.endpoint:
                raise ProviderCallError("The Foundry resource name is not set on the provider.", retryable=False)
            if cfg.endpoint.startswith("https://"):
                self.client: anthropic.Anthropic = anthropic.AnthropicFoundry(base_url=cfg.endpoint, **common)
            else:
                self.client = anthropic.AnthropicFoundry(resource=cfg.endpoint, **common)
        else:
            self.client = anthropic.Anthropic(base_url=cfg.endpoint or None, **common)

    def api_version(self) -> str | None:
        return str(self.client.default_headers.get("anthropic-version") or "") or None

    @staticmethod
    def _messages(msgs: list[Message]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in msgs:
            if m.role == "assistant" and m.native is not None and m.native_kind == "anthropic":
                out.append({"role": "assistant", "content": m.native})
                continue
            content: list[dict[str, Any]] = []
            for p in m.parts:
                if isinstance(p, TextPart):
                    content.append({"type": "text", "text": p.text})
                elif isinstance(p, ToolCall):
                    content.append({"type": "tool_use", "id": p.id, "name": p.name, "input": p.input})
                elif isinstance(p, ToolResult):
                    content.append({"type": "tool_result", "tool_use_id": p.call_id, "content": p.content,
                                    "is_error": p.is_error})
            out.append({"role": m.role, "content": content})
        return out

    def complete(self, model: str, req: ModelRequest) -> ModelResponse:
        params: dict[str, Any] = {
            "model": model,
            "max_tokens": req.max_tokens,
            "system": [{"type": "text", "text": req.system, "cache_control": {"type": "ephemeral"}}],
            "messages": self._messages(req.messages),
        }
        if req.tools:
            params["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.input_schema,
                                "strict": True} for t in req.tools]
        if req.effort:
            params["output_config"] = {"effort": req.effort}
        use_fallback = (self.cfg.kind == "anthropic" and self.cfg.options.get("refusal_fallback", True)
                        and model.startswith(_FALLBACK_PREFIXES))
        try:
            if use_fallback:
                resp: Any = self.client.beta.messages.create(betas=[FALLBACK_BETA], fallbacks="default", **params)
            else:
                resp = self.client.messages.create(**params)
        except anthropic.AuthenticationError as e:
            raise ProviderCallError("The provider rejected the credential.", retryable=False, status=401) from e
        except anthropic.PermissionDeniedError as e:
            raise ProviderCallError("The credential is not allowed to use this model.", retryable=False,
                                    status=403) from e
        except anthropic.NotFoundError as e:
            raise ProviderCallError(f"Model '{model}' was not found at this provider.", retryable=False,
                                    status=404) from e
        except anthropic.BadRequestError as e:
            raise ProviderCallError(f"The provider rejected the request: {e.message}", retryable=False,
                                    status=400) from e
        except anthropic.RateLimitError as e:
            raise ProviderCallError("The provider's rate limit was reached.", retryable=True, status=429) from e
        except anthropic.APIStatusError as e:
            raise ProviderCallError(f"The provider returned HTTP {e.status_code}.", retryable=e.status_code >= 500,
                                    status=e.status_code) from e
        except anthropic.APIConnectionError as e:
            raise ProviderCallError("The provider could not be reached.", retryable=True) from e

        parts: list[TextPart | ToolCall] = []
        for b in resp.content:
            if b.type == "text":
                parts.append(TextPart(b.text))
            elif b.type == "tool_use":
                parts.append(ToolCall(b.id, b.name, dict(b.input) if isinstance(b.input, dict) else {}))
        stop_map: dict[str, Stop] = {"end_turn": "end", "tool_use": "tool_use", "max_tokens": "max_tokens",
                                     "refusal": "refusal", "stop_sequence": "end"}
        raw_stop = resp.stop_reason
        u = resp.usage
        category = None
        if raw_stop == "refusal" and getattr(resp, "stop_details", None) is not None:
            category = getattr(resp.stop_details, "category", None)
        return ModelResponse(
            parts=parts, stop=stop_map.get(raw_stop or "", "other"), raw_stop=raw_stop, served_model=resp.model,
            request_id=getattr(resp, "_request_id", None),
            usage=Usage(input_tokens=u.input_tokens or 0, output_tokens=u.output_tokens or 0,
                        cache_read_tokens=u.cache_read_input_tokens or 0,
                        cache_write_tokens=u.cache_creation_input_tokens or 0),
            native=[b.to_dict() for b in resp.content], native_kind="anthropic", refusal_category=category)

    def check(self) -> str:
        try:
            page = self.client.models.list(limit=20)
        except anthropic.AuthenticationError as e:
            raise ProviderCallError("The provider rejected the credential.", retryable=False, status=401) from e
        except anthropic.APIStatusError as e:
            raise ProviderCallError(f"The provider returned HTTP {e.status_code}.", retryable=False,
                                    status=e.status_code) from e
        except anthropic.APIConnectionError as e:
            raise ProviderCallError("The provider could not be reached.", retryable=True) from e
        ids = [m.id for m in page.data]
        return "Connected. Models available: " + (", ".join(ids[:10]) or "none listed")


# ===================================================================== Azure OpenAI

class AzureOpenAIDriver:
    sdk_version = f"openai-python {openai.__version__}"

    def __init__(self, cfg: DriverConfig) -> None:
        if not cfg.endpoint:
            raise ProviderCallError("The Azure OpenAI endpoint is not set on the provider.", retryable=False)
        self.cfg = cfg
        self.client = openai.AzureOpenAI(azure_endpoint=cfg.endpoint, api_key=cfg.api_key,
                                         api_version=cfg.api_version or DEFAULT_AZURE_OPENAI_API_VERSION,
                                         max_retries=2, timeout=600.0)

    def api_version(self) -> str | None:
        return self.cfg.api_version or DEFAULT_AZURE_OPENAI_API_VERSION

    @staticmethod
    def _messages(system: str, msgs: list[Message]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = [{"role": "system", "content": system}]
        for m in msgs:
            if m.role == "assistant":
                text = "\n".join(p.text for p in m.parts if isinstance(p, TextPart)) or None
                calls = [{"id": p.id, "type": "function",
                          "function": {"name": p.name, "arguments": json.dumps(p.input)}}
                         for p in m.parts if isinstance(p, ToolCall)]
                msg: dict[str, Any] = {"role": "assistant", "content": text}
                if calls:
                    msg["tool_calls"] = calls
                out.append(msg)
                continue
            texts = [p.text for p in m.parts if isinstance(p, TextPart)]
            for p in m.parts:
                if isinstance(p, ToolResult):
                    content = ("ERROR: " + p.content) if p.is_error else p.content
                    out.append({"role": "tool", "tool_call_id": p.call_id, "content": content})
            if texts:
                out.append({"role": "user", "content": "\n\n".join(texts)})
        return out

    def complete(self, model: str, req: ModelRequest) -> ModelResponse:
        params: dict[str, Any] = {"model": model, "messages": self._messages(req.system, req.messages),
                                  "max_completion_tokens": req.max_tokens}
        if req.tools:
            params["tools"] = [{"type": "function", "function": {
                "name": t.name, "description": t.description, "parameters": t.input_schema, "strict": True}}
                for t in req.tools]
        if req.effort and self.cfg.options.get("reasoning_effort", False):
            params["reasoning_effort"] = {"low": "low", "medium": "medium"}.get(req.effort, "high")
        try:
            resp = self.client.chat.completions.create(**params)
        except openai.AuthenticationError as e:
            raise ProviderCallError("The provider rejected the credential.", retryable=False, status=401) from e
        except openai.NotFoundError as e:
            raise ProviderCallError(f"Deployment '{model}' was not found at this endpoint.", retryable=False,
                                    status=404) from e
        except openai.BadRequestError as e:
            raise ProviderCallError(f"The provider rejected the request: {e.message}", retryable=False,
                                    status=400) from e
        except openai.RateLimitError as e:
            raise ProviderCallError("The provider's rate limit was reached.", retryable=True, status=429) from e
        except openai.APIStatusError as e:
            raise ProviderCallError(f"The provider returned HTTP {e.status_code}.", retryable=e.status_code >= 500,
                                    status=e.status_code) from e
        except openai.APIConnectionError as e:
            raise ProviderCallError("The provider could not be reached.", retryable=True) from e

        choice = resp.choices[0]
        parts: list[TextPart | ToolCall] = []
        if choice.message.content:
            parts.append(TextPart(choice.message.content))
        for tc in choice.message.tool_calls or []:
            fn = getattr(tc, "function", None)
            if fn is None:
                continue
            try:
                args = json.loads(fn.arguments or "{}")
                parts.append(ToolCall(tc.id, fn.name, args if isinstance(args, dict) else {},
                                      None if isinstance(args, dict) else "arguments were not a JSON object"))
            except json.JSONDecodeError:
                parts.append(ToolCall(tc.id, fn.name, {}, "arguments were not valid JSON"))
        stop_map: dict[str, Stop] = {"stop": "end", "tool_calls": "tool_use", "length": "max_tokens",
                                     "content_filter": "refusal"}
        u = resp.usage
        cached = 0
        if u is not None and u.prompt_tokens_details is not None:
            cached = u.prompt_tokens_details.cached_tokens or 0
        return ModelResponse(
            parts=parts, stop=stop_map.get(choice.finish_reason or "", "other"), raw_stop=choice.finish_reason,
            served_model=resp.model, request_id=getattr(resp, "_request_id", None),
            usage=Usage(input_tokens=(u.prompt_tokens - cached) if u else 0,
                        output_tokens=u.completion_tokens if u else 0, cache_read_tokens=cached),
            native=None, native_kind="azure_openai")

    def check(self) -> str:
        try:
            models = self.client.models.list()
        except openai.AuthenticationError as e:
            raise ProviderCallError("The provider rejected the credential.", retryable=False, status=401) from e
        except openai.APIStatusError as e:
            raise ProviderCallError(f"The provider returned HTTP {e.status_code}.", retryable=False,
                                    status=e.status_code) from e
        except openai.APIConnectionError as e:
            raise ProviderCallError("The provider could not be reached.", retryable=True) from e
        ids = [m.id for m in models.data][:10]
        return "Connected. Models available: " + (", ".join(ids) or "none listed")


def make_driver(cfg: DriverConfig) -> Driver:
    if cfg.kind in ("anthropic", "anthropic_foundry"):
        return AnthropicDriver(cfg)
    if cfg.kind == "azure_openai":
        return AzureOpenAIDriver(cfg)
    raise ProviderCallError(f"Unknown provider kind {cfg.kind}", retryable=False)
