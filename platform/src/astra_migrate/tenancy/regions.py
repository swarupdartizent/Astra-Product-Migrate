"""Hosting regions offered by this deployment (E01.F1.S2).

Regions are deployment configuration, not code: each one names its own tenant database
server and the model endpoints that serve it.
"""

from __future__ import annotations

from functools import lru_cache

import yaml
from pydantic import BaseModel

from astra_migrate.config import get_settings


class TenantDbServer(BaseModel):
    host: str
    port: int


class ModelEndpoint(BaseModel):
    base_url: str
    region_pinned: bool


class Region(BaseModel):
    code: str
    name: str
    jurisdiction: str
    tenant_db: TenantDbServer
    model_endpoints: dict[str, ModelEndpoint] = {}


class UnknownRegion(ValueError):
    pass


@lru_cache(maxsize=1)
def load_regions() -> dict[str, Region]:
    raw = yaml.safe_load(get_settings().regions_path.read_text(encoding="utf-8"))
    regions = [Region.model_validate(r) for r in raw["regions"]]
    return {r.code: r for r in regions}


def get_region(code: str) -> Region:
    try:
        return load_regions()[code]
    except KeyError as e:
        raise UnknownRegion(f"Region '{code}' is not offered by this deployment") from e


def model_endpoint_is_in_region(region: Region, provider: str) -> bool:
    """True only when the provider offers an endpoint pinned to the tenant's region.
    Residency controls in a blueprint use this to block projects (checked in I2)."""
    ep = region.model_endpoints.get(provider)
    return bool(ep and ep.region_pinned)
