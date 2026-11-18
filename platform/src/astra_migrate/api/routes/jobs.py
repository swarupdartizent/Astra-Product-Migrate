"""Background jobs: status and progress of work that runs outside the request."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.api.errors import conflict, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import Job, Project, Tenant
from astra_migrate.jobs.runner import CANCEL_HOOKS
from astra_migrate.security.principal import CurrentPrincipal, Principal
from astra_migrate.security.rbac import P

router = APIRouter(tags=["jobs"])
DB = Annotated[Session, Depends(get_session)]


class JobOut(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    status: str
    progress: int
    progress_message: str | None
    result: dict[str, Any] | None
    error: str | None
    attempts: int
    max_attempts: int
    tenant_id: uuid.UUID | None
    project_id: uuid.UUID | None
    requested_by: str
    trace_id: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


def job_out(j: Job) -> JobOut:
    return JobOut(id=j.id, kind=j.kind, title=j.title, status=j.status, progress=j.progress,
                  progress_message=j.progress_message, result=j.result, error=j.error, attempts=j.attempts,
                  max_attempts=j.max_attempts, tenant_id=j.tenant_id, project_id=j.project_id,
                  requested_by=str(j.actor.get("name", "")), trace_id=j.trace_id, created_at=j.created_at,
                  started_at=j.started_at, finished_at=j.finished_at)


def can_see_job(s: Session, principal: Principal, j: Job) -> bool:
    if principal.has_platform(P.TENANT_READ):
        return True
    if j.actor.get("type") == "user" and j.actor.get("id") == str(principal.user.id):
        return True
    if j.project_id is not None:
        p = s.get(Project, j.project_id)
        t = s.get(Tenant, p.tenant_id) if p else None
        return bool(p and t and (principal.has_on_project(P.TENANT_READ, t, p.id)
                                 or any(g.scope_type == "project" and g.scope_id == p.id for g in principal.grants)))
    if j.tenant_id is not None:
        t = s.get(Tenant, j.tenant_id)
        return bool(t and principal.has_on_tenant(P.TENANT_READ, t))
    return False


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> JobOut:
    j = s.get(Job, job_id)
    if j is None or not can_see_job(s, principal, j):
        raise not_found("Job")
    return job_out(j)


@router.get("/jobs", response_model=list[JobOut])
def list_jobs(principal: CurrentPrincipal, s: DB, tenant_id: uuid.UUID | None = None,
              project_id: uuid.UUID | None = None, status: str | None = None,
              limit: Annotated[int, Query(ge=1, le=200)] = 50) -> list[JobOut]:
    stmt = select(Job).order_by(Job.created_at.desc())
    if tenant_id:
        stmt = stmt.where(Job.tenant_id == tenant_id)
    if project_id:
        stmt = stmt.where(Job.project_id == project_id)
    if status:
        stmt = stmt.where(Job.status == status)
    out: list[JobOut] = []
    for j in s.scalars(stmt.limit(limit * 4)):
        if can_see_job(s, principal, j):
            out.append(job_out(j))
        if len(out) >= limit:
            break
    return out


@router.post("/jobs/{job_id}/cancel", response_model=JobOut)
def cancel_job(job_id: uuid.UUID, principal: CurrentPrincipal, s: DB) -> JobOut:
    """Cancel a job that has not started. Running jobs finish or fail on their own."""
    j = s.get(Job, job_id, with_for_update=True)
    if j is None or not can_see_job(s, principal, j):
        raise not_found("Job")
    mine = j.actor.get("type") == "user" and j.actor.get("id") == str(principal.user.id)
    if not (mine or principal.has_platform(P.TENANT_CREATE)):
        raise not_found("Job")
    if j.status != "queued":
        raise conflict(f"The job is {j.status}; only queued jobs can be cancelled.")
    if j.kind == "tenant.provision":
        raise conflict("Tenant provisioning cannot be cancelled; delete the tenant instead.")
    j.status, j.finished_at = "cancelled", datetime.now(UTC)
    cancel_hook = CANCEL_HOOKS.get(j.kind)
    if cancel_hook:
        cancel_hook(s, j)
    audit.record(s, principal.actor, "job.cancelled", tenant_id=j.tenant_id, project_id=j.project_id,
                 target_type="job", target_id=str(j.id), details={"kind": j.kind})
    return job_out(j)
