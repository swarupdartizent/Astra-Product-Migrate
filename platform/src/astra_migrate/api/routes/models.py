"""Model gateway administration (E02.F1.S2) and model usage reporting (E01.F3.S2)."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.api.errors import conflict, forbidden, invalid, not_found
from astra_migrate.api.routes.core import visible_tenant_ids
from astra_migrate.db.control import get_session
from astra_migrate.db.models import PROVIDER_KINDS, ModelAlias, ModelCall, ModelProvider
from astra_migrate.gateway import service as gateway
from astra_migrate.security.principal import CurrentPrincipal, Principal
from astra_migrate.security.rbac import P
from astra_migrate.tenancy.regions import load_regions
from astra_migrate.vault import get_vault

router = APIRouter(tags=["models"])
DB = Annotated[Session, Depends(get_session)]
Kind = Literal["anthropic", "anthropic_foundry", "azure_openai"]
KIND_LABELS = {"anthropic": "Anthropic API", "anthropic_foundry": "Claude on Microsoft Foundry",
               "azure_openai": "Azure OpenAI"}
assert set(KIND_LABELS) == set(PROVIDER_KINDS)


def _require_manage(principal: Principal) -> None:
    if not principal.has_platform(P.MODEL_MANAGE):
        raise forbidden()


def _require_read(principal: Principal) -> None:
    if not (principal.has_platform(P.MODEL_MANAGE) or principal.has_platform(P.AUDIT_READ)
            or principal.has_platform(P.OBSERVABILITY_READ)):
        raise forbidden()


class Price(BaseModel):
    input: float = Field(ge=0)
    output: float = Field(ge=0)
    cache_read: float = Field(default=0, ge=0)
    cache_write: float = Field(default=0, ge=0)


class ProviderOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    kind_label: str
    endpoint: str | None
    api_version: str | None
    has_credential: bool
    credential_version: int | None
    no_training_terms: bool
    terms_reference: str
    options: dict[str, Any]
    prices: dict[str, Price]
    enabled: bool
    usable: bool
    problems: list[str]
    check_status: str
    check_detail: str | None
    checked_at: datetime | None
    regions: list[str] = Field(description="Regions whose tenants this provider kind can serve")
    aliases: list[str]
    created_at: datetime


def _provider_out(s: Session, p: ModelProvider) -> ProviderOut:
    problems = gateway.provider_problems(p)
    regions = [r.code for r in load_regions().values() if p.kind in r.model_endpoints]
    aliases = list(s.scalars(select(ModelAlias.alias).where(ModelAlias.provider_id == p.id)))
    return ProviderOut(id=p.id, name=p.name, kind=p.kind, kind_label=KIND_LABELS[p.kind], endpoint=p.endpoint,
                       api_version=p.api_version, has_credential=bool(p.secret_path),
                       credential_version=p.credential_version, no_training_terms=p.no_training_terms,
                       terms_reference=p.terms_reference, options=p.options,
                       prices={k: Price.model_validate(v) for k, v in p.prices.items()}, enabled=p.enabled,
                       usable=not problems, problems=problems, check_status=p.check_status,
                       check_detail=p.check_detail, checked_at=p.checked_at, regions=regions, aliases=aliases,
                       created_at=p.created_at)


class ProviderIn(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    kind: Kind
    endpoint: str | None = Field(default=None, max_length=500,
                                 description="Base URL (Anthropic, optional), Foundry resource name or URL, "
                                             "or Azure OpenAI endpoint")
    api_version: str | None = Field(default=None, max_length=40)
    no_training_terms: bool = Field(description="The provider's enterprise terms exclude training on customer data")
    terms_reference: str = Field(default="", max_length=2000, description="Where those terms are recorded")
    options: dict[str, bool] = Field(default_factory=dict)
    prices: dict[str, Price] | None = None


def _check_terms(body: ProviderIn) -> None:
    if body.no_training_terms and len(body.terms_reference.strip()) < 10:
        raise invalid("terms_reference", "Say where the no-training terms are recorded (contract, order form or "
                                         "provider documentation), so auditors can find them.")
    if body.kind in ("anthropic_foundry", "azure_openai") and not (body.endpoint or "").strip():
        raise invalid("endpoint", "This kind of provider needs its endpoint.")
    if body.endpoint and body.endpoint.strip().startswith("http://"):
        raise invalid("endpoint", "Model endpoints must use HTTPS.")
    allowed = {"refusal_fallback", "reasoning_effort"}
    extra = set(body.options) - allowed
    if extra:
        raise invalid("options", f"Unknown option(s): {', '.join(sorted(extra))}. Known: {', '.join(sorted(allowed))}.")


@router.get("/models/providers", response_model=list[ProviderOut])
def list_providers(principal: CurrentPrincipal, s: DB) -> list[ProviderOut]:
    _require_read(principal)
    return [_provider_out(s, p) for p in s.scalars(select(ModelProvider).order_by(ModelProvider.name))]


@router.post("/models/providers", response_model=ProviderOut, status_code=201)
def create_provider(body: ProviderIn, principal: CurrentPrincipal, s: DB) -> ProviderOut:
    _require_manage(principal)
    _check_terms(body)
    prices = ({k: v.model_dump() for k, v in body.prices.items()} if body.prices is not None
              else dict(gateway.DEFAULT_PRICES.get(body.kind, {})))
    p = ModelProvider(name=body.name.strip(), kind=body.kind, endpoint=(body.endpoint or "").strip() or None,
                      api_version=(body.api_version or "").strip() or None, no_training_terms=body.no_training_terms,
                      terms_reference=body.terms_reference.strip(), options=body.options, prices=prices,
                      enabled=False, created_by=principal.user.id)
    s.add(p)
    try:
        s.flush()
    except IntegrityError as e:
        raise invalid("name", "A provider with this name already exists.") from e
    audit.record(s, principal.actor, "model.provider_created", target_type="model_provider", target_id=str(p.id),
                 details={"name": p.name, "kind": p.kind, "endpoint": p.endpoint,
                          "no_training_terms": p.no_training_terms, "terms_reference": p.terms_reference})
    return _provider_out(s, p)


class ProviderUpdate(ProviderIn):
    enabled: bool


@router.put("/models/providers/{provider_id}", response_model=ProviderOut)
def update_provider(provider_id: uuid.UUID, body: ProviderUpdate, principal: CurrentPrincipal, s: DB) -> ProviderOut:
    _require_manage(principal)
    p = s.get(ModelProvider, provider_id)
    if p is None:
        raise not_found("Provider")
    if body.kind != p.kind:
        raise invalid("kind", "A provider's kind cannot change. Create a new provider instead.")
    _check_terms(body)
    before = {"enabled": p.enabled, "endpoint": p.endpoint, "no_training_terms": p.no_training_terms}
    p.name, p.endpoint = body.name.strip(), (body.endpoint or "").strip() or None
    p.api_version = (body.api_version or "").strip() or None
    p.no_training_terms, p.terms_reference = body.no_training_terms, body.terms_reference.strip()
    p.options = body.options
    if body.prices is not None:
        p.prices = {k: v.model_dump() for k, v in body.prices.items()}
    if body.enabled:
        p.enabled = True
        blockers = gateway.provider_problems(p)
        if blockers:
            raise invalid("enabled", "The provider cannot be enabled: " + " ".join(blockers))
    p.enabled = body.enabled
    try:
        s.flush()
    except IntegrityError as e:
        raise invalid("name", "A provider with this name already exists.") from e
    audit.record(s, principal.actor, "model.provider_updated", target_type="model_provider", target_id=str(p.id),
                 details={"before": before, "after": {"enabled": p.enabled, "endpoint": p.endpoint,
                                                      "no_training_terms": p.no_training_terms}})
    return _provider_out(s, p)


class CredentialIn(BaseModel):
    api_key: str = Field(min_length=8, max_length=4000)


@router.put("/models/providers/{provider_id}/credential", response_model=ProviderOut)
def set_credential(provider_id: uuid.UUID, body: CredentialIn, principal: CurrentPrincipal, s: DB) -> ProviderOut:
    """Store or rotate the provider's API key in the vault. The key is never returned or logged."""
    _require_manage(principal)
    p = s.get(ModelProvider, provider_id)
    if p is None:
        raise not_found("Provider")
    path = f"platform/model-providers/{p.id}/api-key"
    version = get_vault().put_secret(path, body.api_key.strip())
    p.secret_path, p.credential_version = path, version
    p.check_status, p.check_detail, p.checked_at = "unchecked", None, None
    audit.record(s, principal.actor, "model.provider_credential_set", target_type="model_provider",
                 target_id=str(p.id), details={"vault_path": path, "version": version})
    return _provider_out(s, p)


@router.post("/models/providers/{provider_id}/check", response_model=ProviderOut)
def check_provider(provider_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> ProviderOut:
    """Make a real call to the provider with the stored credential (lists models; uses no tokens)."""
    _require_manage(principal)
    p = s.get(ModelProvider, provider_id)
    if p is None:
        raise not_found("Provider")
    try:
        p.check_detail, p.check_status = gateway.check_provider(p, get_vault()), "ok"
    except gateway.GatewayError as e:
        p.check_detail, p.check_status = e.message, "failed"
    p.checked_at = datetime.now(UTC)
    audit.record(s, principal.actor, "model.provider_checked",
                 outcome="success" if p.check_status == "ok" else "failure",
                 target_type="model_provider", target_id=str(p.id), details={"result": p.check_detail})
    return _provider_out(s, p)


@router.delete("/models/providers/{provider_id}", status_code=204, response_class=Response, response_model=None)
def delete_provider(provider_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> Response:
    _require_manage(principal)
    p = s.get(ModelProvider, provider_id)
    if p is None:
        raise not_found("Provider")
    used = list(s.scalars(select(ModelAlias.alias).where(ModelAlias.provider_id == p.id)))
    if used:
        raise conflict("The provider is used by model aliases",
                       "Point these aliases elsewhere first: " + ", ".join(used))
    if p.secret_path:
        get_vault().delete_secret(p.secret_path)
    audit.record(s, principal.actor, "model.provider_deleted", target_type="model_provider", target_id=str(p.id),
                 details={"name": p.name})
    s.delete(p)
    return Response(status_code=204)


# ------------------------------------------------------------------ aliases

class AliasOut(BaseModel):
    alias: str
    provider_id: uuid.UUID
    provider_name: str
    provider_usable: bool
    model: str
    description: str
    price_configured: bool
    updated_at: datetime


class AliasIn(BaseModel):
    provider_id: uuid.UUID
    model: str = Field(min_length=2, max_length=120, description="Model id, or the deployment name on Azure")
    description: str = Field(default="", max_length=1000)
    reason: str = Field(min_length=5, max_length=1000)


def _alias_out(s: Session, a: ModelAlias) -> AliasOut:
    p = s.get(ModelProvider, a.provider_id)
    assert p is not None
    return AliasOut(alias=a.alias, provider_id=p.id, provider_name=p.name,
                    provider_usable=not gateway.provider_problems(p), model=a.model, description=a.description,
                    price_configured=a.model in p.prices, updated_at=a.updated_at)


@router.get("/models/aliases", response_model=list[AliasOut])
def list_aliases(principal: CurrentPrincipal, s: DB) -> list[AliasOut]:
    _require_read(principal)
    return [_alias_out(s, a) for a in gateway.aliases(s)]


@router.put("/models/aliases/{alias}", response_model=AliasOut)
def set_alias(alias: str, body: AliasIn,
              principal: CurrentPrincipal, s: DB) -> AliasOut:
    """Point an alias at a provider and model. Every agent using the alias changes model; no agent changes."""
    _require_manage(principal)
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,59}", alias):
        raise invalid("alias", "Use 2–60 lowercase letters, digits and hyphens, starting with a letter.")
    p = s.get(ModelProvider, body.provider_id)
    if p is None:
        raise invalid("provider_id", "Unknown provider")
    a = s.get(ModelAlias, alias)
    before = {"provider_id": str(a.provider_id), "model": a.model} if a else None
    if a is None:
        a = ModelAlias(alias=alias, provider_id=p.id, model=body.model.strip(), description=body.description.strip(),
                       updated_by=principal.user.id)
        s.add(a)
    else:
        a.provider_id, a.model, a.description = p.id, body.model.strip(), body.description.strip()
        a.updated_by, a.updated_at = principal.user.id, datetime.now(UTC)
    s.flush()
    audit.record(s, principal.actor, "model.alias_set", target_type="model_alias", target_id=alias,
                 details={"before": before, "after": {"provider_id": str(p.id), "provider": p.name,
                                                      "model": a.model}, "reason": body.reason.strip()})
    return _alias_out(s, a)


@router.delete("/models/aliases/{alias}", status_code=204, response_class=Response, response_model=None)
def delete_alias(alias: str, principal: CurrentPrincipal, s: DB) -> Response:
    _require_manage(principal)
    a = s.get(ModelAlias, alias)
    if a is None:
        raise not_found("Alias")
    audit.record(s, principal.actor, "model.alias_deleted", target_type="model_alias", target_id=alias,
                 details={"provider_id": str(a.provider_id), "model": a.model})
    s.delete(a)
    return Response(status_code=204)


# ------------------------------------------------------------------ calls and usage

class CallOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    provider_name: str
    provider_kind: str
    alias: str | None
    requested_model: str
    served_model: str | None
    api_version: str | None
    sdk_version: str | None
    request_id: str | None
    agent_name: str | None
    agent_version: str | None
    agent_run_id: uuid.UUID | None
    test_run_id: uuid.UUID | None
    tenant_id: uuid.UUID | None
    project_id: uuid.UUID | None
    region_code: str | None
    region_pinned: bool | None
    status: str
    stop_reason: str | None
    error: str | None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_usd: float | None
    latency_ms: float
    trace_id: str | None


def _calls_scope(s: Session, principal: Principal):  # type: ignore[no-untyped-def]
    """Rows of model_calls the principal may see: platform readers see all; others see calls for the
    tenants they can observe."""
    if principal.has_platform(P.OBSERVABILITY_READ) or principal.has_platform(P.MODEL_MANAGE) \
            or principal.has_platform(P.AUDIT_READ):
        return None
    ids = visible_tenant_ids(s, principal, P.OBSERVABILITY_READ)
    if ids is None:
        return None
    if not ids:
        raise forbidden()
    return ModelCall.tenant_id.in_(ids)


@router.get("/models/calls", response_model=list[CallOut])
def list_calls(principal: CurrentPrincipal, s: DB, agent: str | None = None, agent_run_id: uuid.UUID | None = None,
               test_run_id: uuid.UUID | None = None, status: str | None = None,
               limit: Annotated[int, Query(ge=1, le=500)] = 100) -> list[CallOut]:
    cond = _calls_scope(s, principal)
    stmt = select(ModelCall).order_by(ModelCall.created_at.desc())
    if cond is not None:
        stmt = stmt.where(cond)
    if agent:
        stmt = stmt.where(ModelCall.agent_name == agent)
    if agent_run_id:
        stmt = stmt.where(ModelCall.agent_run_id == agent_run_id)
    if test_run_id:
        stmt = stmt.where(ModelCall.test_run_id == test_run_id)
    if status:
        stmt = stmt.where(ModelCall.status == status)
    return [CallOut.model_validate(c, from_attributes=True) for c in s.scalars(stmt.limit(limit))]


class UsageRow(BaseModel):
    key: str | None
    calls: int
    errors: int
    refused: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    unpriced_calls: int
    p95_latency_ms: float


UsageGroup = Literal["agent", "served_model", "provider", "alias", "project", "tenant"]
_USAGE_COL = {"agent": ModelCall.agent_name, "served_model": ModelCall.served_model,
              "provider": ModelCall.provider_name,
              "alias": ModelCall.alias, "project": ModelCall.project_id, "tenant": ModelCall.tenant_id}


@router.get("/models/usage", response_model=list[UsageRow])
def usage(principal: CurrentPrincipal, s: DB, group_by: UsageGroup = "agent", since: datetime | None = None,
          include_tests: bool = True) -> list[UsageRow]:
    """Model calls, tokens and cost grouped by agent, model, provider, alias, project or tenant."""
    cond = _calls_scope(s, principal)
    col = _USAGE_COL[group_by]
    stmt = select(col.label("key"), func.count().label("calls"),
                  func.count().filter(ModelCall.status == "error").label("errors"),
                  func.count().filter(ModelCall.status == "refused").label("refused"),
                  func.coalesce(func.sum(ModelCall.input_tokens + ModelCall.cache_read_tokens
                                         + ModelCall.cache_write_tokens), 0).label("input_tokens"),
                  func.coalesce(func.sum(ModelCall.output_tokens), 0).label("output_tokens"),
                  func.coalesce(func.sum(ModelCall.cost_usd), 0).label("cost_usd"),
                  func.count().filter((ModelCall.cost_usd.is_(None)) & (ModelCall.status != "error"))
                  .label("unpriced"),
                  func.percentile_cont(0.95).within_group(ModelCall.latency_ms).label("p95")).group_by(col)
    if cond is not None:
        stmt = stmt.where(cond)
    if since:
        stmt = stmt.where(ModelCall.created_at >= since)
    if not include_tests:
        stmt = stmt.where(ModelCall.test_run_id.is_(None))
    rows = s.execute(stmt.order_by(func.coalesce(func.sum(ModelCall.cost_usd), 0).desc()).limit(200)).all()
    return [UsageRow(key=str(r.key) if r.key is not None else None, calls=r.calls, errors=r.errors, refused=r.refused,
                     input_tokens=int(r.input_tokens), output_tokens=int(r.output_tokens),
                     cost_usd=float(r.cost_usd), unpriced_calls=r.unpriced, p95_latency_ms=float(r.p95 or 0))
            for r in rows]
