"""Sample values for the evidence panel (E16.F1.S2). They are read from the tenant database at view time and are
never copied into the control plane."""

from __future__ import annotations

import uuid
from typing import Any

from astra_migrate.agents.guardrails import reveal_hidden
from astra_migrate.db.models import ReviewItem, Tenant
from astra_migrate.tenancy.service import tenant_connection
from astra_migrate.vault import get_vault

MAX_LINES = 60
MAX_SAMPLES = 25


def _excerpt(text: str | None) -> str | None:
    if text is None:
        return None
    lines = text.splitlines()
    return "\n".join(lines[:MAX_LINES]) + (f"\n… {len(lines) - MAX_LINES} more line(s)" if len(lines) > MAX_LINES
                                          else "")


def samples(t: Tenant, r: ReviewItem) -> dict[str, Any] | None:
    ctx = r.context or {}
    try:
        if ctx.get("conversion_run_id") and ctx.get("object"):
            with tenant_connection(t, get_vault()) as conn:
                row = conn.execute(
                    "SELECT object_type, status, source, converted, review, warnings, compile FROM estate.conversions "
                    "WHERE run_id = %s AND name = %s ORDER BY object_type LIMIT 1",
                    (uuid.UUID(ctx["conversion_run_id"]), ctx["object"])).fetchone()
            if row is None:
                return None
            return {"type": "code", "object_type": row[0], "status": row[1], "source": _excerpt(row[2]),
                    "converted": _excerpt(row[3]), "review": row[4], "warnings": row[5], "compile": row[6]}
        if ctx.get("discovery_run_id") and "unused" in ctx:
            with tenant_connection(t, get_vault()) as conn:
                row = conn.execute("SELECT payload FROM estate.discovery_results WHERE run_id = %s AND section = "
                                   "'usage'", (uuid.UUID(ctx["discovery_run_id"]),)).fetchone()
            unused = list((row[0] or {}).get("unused") or []) if row else []
            return {"type": "elements", "total": len(unused), "items": unused[:MAX_SAMPLES]}
        if ctx.get("flag_id"):
            with tenant_connection(t, get_vault()) as conn:
                row = conn.execute("SELECT excerpt FROM estate.screening_flags WHERE id = %s",
                                   (uuid.UUID(ctx["flag_id"]),)).fetchone()
            return {"type": "text", "text": reveal_hidden(row[0])} if row else None
    except (ValueError, KeyError):
        return None
    return None
