"""Model gateway (E02.F1.S2): one model-neutral entry point for every model call.

- Agents name an alias; the alias names a provider and a model. Changing the alias changes the model
  for every agent, with no agent change.
- A provider is used only if it is enabled, has a credential in the vault, is recorded as having
  enterprise terms with no training on customer data, and serves the tenant's region.
- Every call, including failed and refused ones, is recorded in `model_calls` with the model name and
  version that actually answered, tokens, cost and time, and traced as a span (category `model`).
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any

from opentelemetry.trace import Status, StatusCode
from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from astra_migrate.db.control import session_scope
from astra_migrate.db.models import ModelAlias, ModelCall, ModelProvider
from astra_migrate.gateway.drivers import Driver, DriverConfig, ProviderCallError, make_driver
from astra_migrate.gateway.types import ModelRequest, ModelResponse
from astra_migrate.observability import tracer
from astra_migrate.tenancy.regions import UnknownRegion, get_region
from astra_migrate.vault import VaultClient, get_vault

log = logging.getLogger(__name__)

# Published list prices in USD per million tokens (Anthropic pricing, as of 3 Nov 2026). These seed a
# new Anthropic provider; administrators keep each provider's prices current on the provider record.
DEFAULT_PRICES: dict[str, dict[str, dict[str, float]]] = {
    "anthropic": {
        "claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_read": 0.20, "cache_write": 5.0},
        "claude-sonnet-5-5": {"input": 2.0, "output": 10.0, "cache_read": 0.10, "cache_write": 2.5},
        "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01, "cache_write": 0.125},
        "claude-fable-5-2": {"input": 8.0, "output": 40.0, "cache_read": 0.20, "cache_write": 10.0},
    },
    "anthropic_foundry": {
        "claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_read": 0.20, "cache_write": 5.0},
        "claude-sonnet-5-5": {"input": 2.0, "output": 10.0, "cache_read": 0.10, "cache_write": 2.5},
    },
    "azure_openai": {},
}


class GatewayError(Exception):
    """A call could not be made or failed. `code` is stable; `message` is shown to people."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


@dataclass(frozen=True)
class CallContext:
    agent_name: str | None = None
    agent_version: str | None = None
    agent_run_id: uuid.UUID | None = None
    test_run_id: uuid.UUID | None = None
    tenant_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    region_code: str | None = None
    stage: str | None = None


@dataclass(frozen=True)
class Resolved:
    provider_id: uuid.UUID
    provider_name: str
    kind: str
    model: str
    endpoint: str | None
    api_version: str | None
    secret_path: str
    credential_version: int | None
    options: dict[str, Any]
    prices: dict[str, Any]


@dataclass(frozen=True)
class CallResult:
    response: ModelResponse
    call_id: uuid.UUID
    cost_usd: float | None
    served_model: str | None
    latency_ms: float


def provider_problems(p: ModelProvider) -> list[str]:
    """Why a provider cannot be used, in plain language. Empty means usable."""
    out: list[str] = []
    if not p.enabled:
        out.append("The provider is disabled.")
    if not p.secret_path:
        out.append("No credential has been stored for the provider.")
    if not p.no_training_terms:
        out.append("The provider is not recorded as an enterprise endpoint with no training on customer data.")
    if p.kind in ("anthropic_foundry", "azure_openai") and not p.endpoint:
        out.append("The provider's endpoint is not set.")
    return out


def lookup(session: Session, alias: str) -> tuple[Resolved, list[str]]:
    """The provider and model behind an alias, and why they cannot be used (empty when usable)."""
    a = session.get(ModelAlias, alias)
    if a is None:
        raise GatewayError("alias-missing", f"No model is configured for the alias '{alias}'. "
                           "A platform administrator sets it under Models.")
    p = session.get(ModelProvider, a.provider_id)
    if p is None:
        raise GatewayError("provider-missing", f"The alias '{alias}' points to a provider that no longer exists.")
    r = Resolved(p.id, p.name, p.kind, a.model, p.endpoint, p.api_version, p.secret_path or "", p.credential_version,
                 dict(p.options), dict(p.prices))
    return r, provider_problems(p)


def resolve(session: Session, alias: str) -> Resolved:
    r, problems = lookup(session, alias)
    if problems:
        raise GatewayError("provider-unavailable", f"Provider '{r.provider_name}' cannot be used: "
                           + " ".join(problems))
    return r


def cost_of(prices: dict[str, Any], model: str, served: str | None, usage: Any) -> float | None:
    price = prices.get(served or "") or prices.get(model)
    if not price:
        return None
    return round(float(usage.input_tokens * float(price.get("input", 0))
                  + usage.output_tokens * float(price.get("output", 0))
                  + usage.cache_read_tokens * float(price.get("cache_read", 0))
                  + usage.cache_write_tokens * float(price.get("cache_write", 0))) / 1_000_000, 6)


# ------------------------------------------------------------------ driver cache

_drivers: dict[tuple[uuid.UUID, int | None, str | None, str | None], Driver] = {}
_lock = threading.Lock()


def driver_for(r: Resolved, vault: VaultClient) -> Driver:
    key = (r.provider_id, r.credential_version, r.endpoint, r.api_version)
    with _lock:
        d = _drivers.get(key)
        if d is None:
            api_key = vault.get_secret(r.secret_path).value
            d = make_driver(DriverConfig(r.kind, r.endpoint, r.api_version, api_key, r.options))
            for k in [k for k in _drivers if k[0] == r.provider_id]:
                del _drivers[k]
            _drivers[key] = d
        return d


# ------------------------------------------------------------------ calls

def _region_check(kind: str, region_code: str | None) -> bool | None:
    if region_code is None:
        return None
    try:
        region = get_region(region_code)
    except UnknownRegion as e:
        raise GatewayError("region-unknown", str(e)) from e
    ep = region.model_endpoints.get(kind)
    if ep is None:
        raise GatewayError("region-unavailable", f"This provider does not serve tenants hosted in {region.name}.")
    return ep.region_pinned


def _record(r: Resolved | None, alias: str, ctx: CallContext, *, status: str, region_pinned: bool | None,
            resp: ModelResponse | None, error: str | None, latency_ms: float, cost: float | None,
            sdk_version: str | None, api_version: str | None, trace_id: str | None) -> uuid.UUID:
    call_id = uuid.uuid4()
    u = resp.usage if resp else None
    with session_scope() as s:
        s.execute(insert(ModelCall).values(
            id=call_id, provider_id=r.provider_id if r else None, provider_name=r.provider_name if r else "(none)",
            provider_kind=r.kind if r else "(none)", alias=alias, requested_model=r.model if r else "(none)",
            served_model=resp.served_model if resp else None, api_version=api_version, sdk_version=sdk_version,
            request_id=resp.request_id if resp else None, agent_name=ctx.agent_name, agent_version=ctx.agent_version,
            agent_run_id=ctx.agent_run_id, test_run_id=ctx.test_run_id, tenant_id=ctx.tenant_id,
            project_id=ctx.project_id, region_code=ctx.region_code, region_pinned=region_pinned, status=status,
            stop_reason=resp.raw_stop if resp else None, error=error,
            input_tokens=u.input_tokens if u else 0, output_tokens=u.output_tokens if u else 0,
            cache_read_tokens=u.cache_read_tokens if u else 0, cache_write_tokens=u.cache_write_tokens if u else 0,
            cost_usd=cost, latency_ms=latency_ms, trace_id=trace_id))
    return call_id


def complete(alias: str, req: ModelRequest, ctx: CallContext, vault: VaultClient | None = None) -> CallResult:
    """Call the model behind `alias`. Raises GatewayError; every attempt is recorded either way."""
    attrs: dict[str, Any] = {"astra.category": "model", "gen_ai.operation.name": "chat", "astra.model_alias": alias}
    for k, v in (("astra.agent", ctx.agent_name), ("astra.agent_version", ctx.agent_version),
                 ("astra.tenant_id", str(ctx.tenant_id) if ctx.tenant_id else None),
                 ("astra.project_id", str(ctx.project_id) if ctx.project_id else None),
                 ("astra.stage", ctx.stage)):
        if v:
            attrs[k] = v
    with tracer().start_as_current_span(f"model {alias}", attributes=attrs) as span:
        trace_id = format(span.get_span_context().trace_id, "032x")
        r: Resolved | None = None
        region_pinned: bool | None = None
        try:
            with session_scope() as s:
                r, problems = lookup(s, alias)
            span.set_attribute("gen_ai.system", r.kind)
            span.set_attribute("gen_ai.request.model", r.model)
            if problems:
                raise GatewayError("provider-unavailable", f"Provider '{r.provider_name}' cannot be used: "
                                   + " ".join(problems))
            region_pinned = _region_check(r.kind, ctx.region_code)
            driver = driver_for(r, vault or get_vault())
        except GatewayError as e:
            span.set_status(Status(StatusCode.ERROR, e.code))
            _record(r, alias, ctx, status="error", region_pinned=region_pinned, resp=None, error=e.message,
                    latency_ms=0, cost=None, sdk_version=None, api_version=None, trace_id=trace_id)
            raise
        except ProviderCallError as e:
            span.set_status(Status(StatusCode.ERROR, "provider-config"))
            _record(r, alias, ctx, status="error", region_pinned=region_pinned, resp=None, error=str(e),
                    latency_ms=0, cost=None, sdk_version=None, api_version=None, trace_id=trace_id)
            raise GatewayError("provider-config", str(e)) from e

        started = time.perf_counter()
        try:
            resp = driver.complete(r.model, req)
        except ProviderCallError as e:
            latency = (time.perf_counter() - started) * 1000
            span.set_status(Status(StatusCode.ERROR, f"provider-{e.status or 'error'}"))
            _record(r, alias, ctx, status="error", region_pinned=region_pinned, resp=None, error=str(e),
                    latency_ms=latency, cost=None, sdk_version=driver.sdk_version, api_version=driver.api_version(),
                    trace_id=trace_id)
            raise GatewayError("provider-error", str(e), retryable=e.retryable) from e
        latency = (time.perf_counter() - started) * 1000
        cost = cost_of(r.prices, r.model, resp.served_model, resp.usage)
        status = "refused" if resp.stop == "refusal" else "ok"
        call_id = _record(r, alias, ctx, status=status, region_pinned=region_pinned, resp=resp, error=None,
                          latency_ms=latency, cost=cost, sdk_version=driver.sdk_version,
                          api_version=driver.api_version(), trace_id=trace_id)
        span.set_attribute("gen_ai.response.model", resp.served_model or "")
        span.set_attribute("gen_ai.usage.input_tokens", resp.usage.input_tokens)
        span.set_attribute("gen_ai.usage.output_tokens", resp.usage.output_tokens)
        span.set_attribute("astra.model_call_id", str(call_id))
        if cost is not None:
            span.set_attribute("astra.cost_usd", cost)
        if status == "refused":
            span.set_status(Status(StatusCode.ERROR, "refused"))
        return CallResult(resp, call_id, cost, resp.served_model, latency)


def check_provider(p: ModelProvider, vault: VaultClient) -> str:
    """Make a real, token-free call (list models) with the stored credential."""
    if not p.secret_path:
        raise GatewayError("no-credential", "No credential has been stored for the provider.")
    r = Resolved(p.id, p.name, p.kind, "", p.endpoint, p.api_version, p.secret_path, p.credential_version,
                 dict(p.options), dict(p.prices))
    try:
        return driver_for(r, vault).check()
    except ProviderCallError as e:
        raise GatewayError("check-failed", str(e)) from e


def aliases(session: Session) -> list[ModelAlias]:
    return list(session.scalars(select(ModelAlias).order_by(ModelAlias.alias)))
