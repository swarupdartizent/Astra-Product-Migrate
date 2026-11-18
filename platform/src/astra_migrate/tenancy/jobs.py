"""Tenant lifecycle jobs: provisioning and region moves run on the durable job runner."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from astra_migrate.db.control import session_scope
from astra_migrate.db.models import Job, RegionMigration, Tenant
from astra_migrate.jobs.runner import JobContext, JobFailed, handler, on_cancel
from astra_migrate.tenancy import service
from astra_migrate.vault import get_vault


@handler("tenant.provision")
def provision(ctx: JobContext) -> dict[str, Any]:
    tid = uuid.UUID(ctx.payload["tenant_id"])
    ctx.progress(5, "Creating the tenant's key, database and role")
    with session_scope() as s:
        t = s.get(Tenant, tid)
        if t is None:
            raise JobFailed("The tenant no longer exists.")
        if t.status != "provisioning":
            raise JobFailed(f"The tenant is {t.status}; there is nothing to provision.")
        service.provision(s, t, get_vault(), ctx.actor)
        status, detail = t.status, t.status_detail
    if status != "active":
        raise JobFailed(detail or "Provisioning failed.")
    return {"tenant_id": str(tid), "status": status}


@on_cancel("tenant.region_move")
def _cancel_move(s: Session, job: Job) -> None:
    m = s.get(RegionMigration, uuid.UUID(job.payload["migration_id"]))
    if m is not None and m.status == "queued":
        m.status, m.completed_at = "cancelled", datetime.now(UTC)


@handler("tenant.region_move")
def region_move(ctx: JobContext) -> dict[str, Any]:
    mid = uuid.UUID(ctx.payload["migration_id"])
    with session_scope() as s:
        try:
            task = service.run_region_move(s, mid, get_vault(), ctx.actor, ctx.progress)
        except service.TenantError as e:
            raise JobFailed(str(e)) from e
        status, detail = task.status, dict(task.detail)
    if status != "completed":
        raise JobFailed(str(detail.get("error") or "The region move failed; the tenant stays in its old region."))
    return {"migration_id": str(mid), "status": status, "tables": detail.get("tables", {})}
