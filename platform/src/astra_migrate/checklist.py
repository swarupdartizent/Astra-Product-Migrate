"""Hosting checklist (E10.F2.S1): what the customer must set up before cut-over on a hosted target.

Items come from the target adapter's recorded constraints (identity, provisioning, change windows and other
operational limits, each with its source). The four areas every hosted cut-over needs (single sign-on,
multi-factor authentication, network access and printing) are always present: where the adapter says nothing
about an area, a generic item asks the customer to confirm it with the vendor, and says that it is generic.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import case, select
from sqlalchemy.orm import Session

from astra_migrate.adapters.contract import parse_target
from astra_migrate.db.models import ChecklistItem, Pack, ProjectBaseline, TargetBaseline
from astra_migrate.packs.registry import manifest_of

AREAS = ("sso", "mfa", "network", "printing")
AREA_TITLES = {"sso": "Single sign-on", "mfa": "Multi-factor authentication", "network": "Network access",
               "printing": "Printing", "provisioning": "Provisioning", "change_window": "Change windows",
               "operations": "Operations"}
OWNERS = {"sso": "customer_it_security_lead", "mfa": "customer_it_security_lead",
          "network": "customer_it_security_lead", "printing": "customer_operations_manager",
          "provisioning": "migration_lead", "change_window": "migration_lead", "operations": "migration_lead"}
GENERIC = {
    "sso": ("Connect the customer's identity provider to the hosted product",
            "Agree the sign-on protocol (SAML or OpenID Connect), exchange metadata, map user groups to product "
            "roles and test a sign-in for each role before cut-over."),
    "mfa": ("Enforce multi-factor authentication for every user",
            "Confirm whether the identity provider or the hosted product enforces the second factor, and that "
            "service and break-glass accounts follow the customer's policy."),
    "network": ("Allow the customer's network to reach the hosted product",
                "List the addresses and ports to allow, the source addresses the vendor must allow for "
                "integrations, and any private connectivity; test from each office and from remote access."),
    "printing": ("Make printing work from the hosted product",
                 "Confirm how documents print from the hosted product (browser printing, PDF or a print "
                 "service), which printers and trays users need, and test each output the business prints."),
}
KIND_AREAS = {"identity": "sso", "provisioning": "provisioning", "change_window": "change_window"}
KEYWORDS = (("mfa", ("multi-factor", "mfa", "two-factor", "2fa")), ("sso", ("sso", "single sign", "saml", "oidc")),
            ("network", ("network", "ip allow", "vpn", "firewall", "private link")),
            ("printing", ("print",)))


@dataclass
class Proposed:
    key: str
    category: str
    title: str
    detail: str
    source: dict[str, Any]


def _area(kind: str, text: str) -> str:
    low = text.lower()
    for area, words in KEYWORDS:
        if any(w in low for w in words):
            return area
    return KIND_AREAS.get(kind, "operations")


def target_content(s: Session, adapter_name: str) -> tuple[str | None, Any]:
    """The newest pack of the target adapter, published ones first."""
    order = case((Pack.status == "published", 0), (Pack.status == "deprecated", 1), else_=2)
    p = s.scalars(select(Pack).where(Pack.name == adapter_name, Pack.type == "target_adapter")
                  .order_by(order, Pack.created_at.desc())).first()
    if p is None:
        return None, None
    return f"{p.name}@{p.version}", parse_target(manifest_of(p).content)


def propose(s: Session, project_id: uuid.UUID) -> tuple[list[Proposed], str | None]:
    """The checklist the project should have, from its pinned baseline's target adapter."""
    pin = s.get(ProjectBaseline, project_id)
    b = s.get(TargetBaseline, pin.baseline_id) if pin else None
    ref, content = target_content(s, b.adapter_name) if b else (None, None)
    items: list[Proposed] = []
    covered: set[str] = set()
    if content is not None:
        for c in content.constraints:
            if c.kind in ("database_access", "load_tool", "api_limit", "forms", "workflow"):
                continue  # design and load constraints, not hosting set-up
            area = _area(c.kind, f"{c.title} {c.statement}")
            covered.add(area)
            items.append(Proposed(f"adapter:{c.id}", area, c.title, c.statement,
                                  {"kind": "adapter", "adapter": ref, "constraint": c.id,
                                   "reference": c.source.model_dump(mode="json"),
                                   "recorded_on": c.recorded_on.isoformat(), "confidence": c.confidence}))
    for area in AREAS:
        if area not in covered:
            title, detail = GENERIC[area]
            items.append(Proposed(f"generic:{area}", area, title, detail,
                                  {"kind": "generic", "note": "The target adapter records nothing about this area; "
                                   "confirm the arrangement with the vendor."}))
    return items, ref


def sync(s: Session, tenant_id: uuid.UUID, project_id: uuid.UUID) -> tuple[int, str | None]:
    """Add proposed items the project does not have yet. Existing items keep their owner, status and note."""
    items, ref = propose(s, project_id)
    have = set(s.scalars(select(ChecklistItem.key).where(ChecklistItem.project_id == project_id)))
    added = 0
    for it in items:
        if it.key in have:
            continue
        s.add(ChecklistItem(tenant_id=tenant_id, project_id=project_id, key=it.key, category=it.category,
                            title=it.title[:300], detail=it.detail, source=it.source, owner_role=OWNERS[it.category],
                            status="open", note=""))
        added += 1
    s.flush()
    return added, ref
