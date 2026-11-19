"""Durable job runner.

Long work (tenant provisioning, region moves, agent runs, agent test suites) never runs inside an HTTP
request. A request records a job and returns at once; a worker claims it, runs it and records progress,
result or error in the `jobs` table, where the web app follows it.

- Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`, so any number of workers (threads in the API
  process locally, a separate container in Azure) can run side by side without double-running a job.
- New jobs wake idle workers through Postgres NOTIFY; workers also poll, so a lost notification only
  delays a job by the poll interval.
- A running job sends heartbeats. A job whose worker died (no heartbeat for `STALE_AFTER`) is retried
  if it has attempts left, otherwise marked failed with that reason.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.config import get_settings
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import Job
from astra_migrate.observability import tracer

log = logging.getLogger(__name__)
STALE_AFTER = timedelta(minutes=2)
HEARTBEAT_EVERY_S = 15.0
POLL_S = 2.0


class JobFailed(Exception):
    """Raised by a handler for an expected failure; the message is shown to people as is."""


@dataclass
class JobContext:
    job_id: uuid.UUID
    kind: str
    payload: dict[str, Any]
    actor: audit.Actor
    tenant_id: uuid.UUID | None
    project_id: uuid.UUID | None
    attempt: int

    def progress(self, percent: int, message: str) -> None:
        with session_scope() as s:
            s.execute(update(Job).where(Job.id == self.job_id).values(
                progress=max(0, min(100, percent)), progress_message=message[:2000],
                heartbeat_at=datetime.now(UTC)))


Handler = Callable[[JobContext], dict[str, Any] | None]
HANDLERS: dict[str, Handler] = {}
# Called in the cancelling transaction so the domain record (region move, agent run) is closed too.
CANCEL_HOOKS: dict[str, Callable[[Session, Job], None]] = {}


def on_cancel(kind: str) -> Callable[[Callable[[Session, Job], None]], Callable[[Session, Job], None]]:
    def register(fn: Callable[[Session, Job], None]) -> Callable[[Session, Job], None]:
        CANCEL_HOOKS[kind] = fn
        return fn
    return register


def handler(kind: str) -> Callable[[Handler], Handler]:
    def register(fn: Handler) -> Handler:
        if kind in HANDLERS:
            raise RuntimeError(f"duplicate job handler for {kind}")
        HANDLERS[kind] = fn
        return fn
    return register


def actor_dict(a: audit.Actor) -> dict[str, str]:
    return {"type": a.type, "id": a.id, "name": a.name}


def actor_from(d: dict[str, Any]) -> audit.Actor:
    return audit.Actor(d["type"], d["id"], d["name"])


def enqueue(session: Session, kind: str, title: str, actor: audit.Actor, payload: dict[str, Any] | None = None, *,
            tenant_id: uuid.UUID | None = None, project_id: uuid.UUID | None = None, max_attempts: int = 1) -> Job:
    """Record a job in the caller's transaction. Workers see it once the transaction commits."""
    _ensure_handlers()
    if kind not in HANDLERS:
        raise RuntimeError(f"no job handler registered for {kind}")
    ctx = trace.get_current_span().get_span_context()
    job = Job(kind=kind, title=title[:300], payload=payload or {}, actor=actor_dict(actor), tenant_id=tenant_id,
              project_id=project_id, max_attempts=max_attempts, status="queued",
              trace_id=format(ctx.trace_id, "032x") if ctx.is_valid else None)
    session.add(job)
    session.flush()
    return job


def _ensure_handlers() -> None:
    # Handlers live next to the code they drive; importing registers them.
    from astra_migrate import programme as _programme_jobs  # noqa: F401
    from astra_migrate.adapters import jobs as _adapter_jobs  # noqa: F401
    from astra_migrate.adapters import target as _target_jobs  # noqa: F401
    from astra_migrate.agents import jobs as _agent_jobs  # noqa: F401
    from astra_migrate.conversion import jobs as _conversion_jobs  # noqa: F401
    from astra_migrate.delta import jobs as _delta_jobs  # noqa: F401
    from astra_migrate.design import jobs as _design_jobs  # noqa: F401
    from astra_migrate.discovery import jobs as _discovery_jobs  # noqa: F401
    from astra_migrate.loads import coexistence as _coexistence_jobs  # noqa: F401
    from astra_migrate.loads import engine as _load_jobs  # noqa: F401
    from astra_migrate.tenancy import jobs as _tenant_jobs  # noqa: F401


# ------------------------------------------------------------------ claiming and running

def recover_stale() -> int:
    """Return jobs whose worker stopped to the queue (or fail them when out of attempts)."""
    cutoff = datetime.now(UTC) - STALE_AFTER
    n = 0
    with session_scope() as s:
        rows = s.scalars(select(Job).where(Job.status == "running", Job.heartbeat_at < cutoff)
                         .with_for_update(skip_locked=True)).all()
        for j in rows:
            n += 1
            if j.attempts < j.max_attempts:
                j.status, j.locked_by, j.run_after = "queued", None, datetime.now(UTC)
                j.progress_message = "The worker running this job stopped; it will be retried."
            else:
                j.status, j.finished_at = "failed", datetime.now(UTC)
                j.error = "The worker running this job stopped and no attempts are left."
            log.warning("recovered stale job %s (%s) -> %s", j.id, j.kind, j.status)
    return n


def _claim(worker_id: str) -> JobContext | None:
    with session_scope() as s:
        j = s.scalars(select(Job).where(Job.status == "queued", Job.run_after <= datetime.now(UTC))
                      .order_by(Job.created_at).limit(1).with_for_update(skip_locked=True)).first()
        if j is None:
            return None
        now = datetime.now(UTC)
        j.status, j.locked_by, j.attempts = "running", worker_id, j.attempts + 1
        j.started_at, j.heartbeat_at = j.started_at or now, now
        return JobContext(j.id, j.kind, dict(j.payload), actor_from(j.actor), j.tenant_id, j.project_id, j.attempts)


def _heartbeat(job_id: uuid.UUID, stop: threading.Event) -> None:
    while not stop.wait(HEARTBEAT_EVERY_S):
        try:
            with session_scope() as s:
                s.execute(update(Job).where(Job.id == job_id, Job.status == "running")
                          .values(heartbeat_at=datetime.now(UTC)))
        except Exception:
            log.warning("heartbeat failed for job %s", job_id, exc_info=True)


def _finish(job_id: uuid.UUID, status: str, *, result: dict[str, Any] | None = None, error: str | None = None,
            retry: bool = False) -> None:
    with session_scope() as s:
        j = s.get(Job, job_id, with_for_update=True)
        if j is None:
            return
        if retry and j.attempts < j.max_attempts:
            j.status, j.locked_by = "queued", None
            j.run_after = datetime.now(UTC) + timedelta(seconds=30 * j.attempts)
            j.progress_message = f"Attempt {j.attempts} failed; retrying. {error or ''}".strip()
            return
        j.status, j.finished_at, j.locked_by = status, datetime.now(UTC), None
        j.result, j.error = result, error
        if status == "succeeded":
            j.progress = 100


def run_one(worker_id: str) -> bool:
    """Claim and run one job. Returns False when the queue is empty."""
    _ensure_handlers()
    ctx = _claim(worker_id)
    if ctx is None:
        return False
    fn = HANDLERS.get(ctx.kind)
    stop = threading.Event()
    beat = threading.Thread(target=_heartbeat, args=(ctx.job_id, stop), daemon=True, name=f"hb-{ctx.job_id}")
    beat.start()
    with tracer().start_as_current_span(f"job {ctx.kind}", attributes={
            "astra.category": "job", "astra.job_id": str(ctx.job_id),
            **({"astra.tenant_id": str(ctx.tenant_id)} if ctx.tenant_id else {}),
            **({"astra.project_id": str(ctx.project_id)} if ctx.project_id else {})}) as span:
        try:
            if fn is None:
                raise JobFailed(f"No handler for job kind {ctx.kind}")
            result = fn(ctx)
            _finish(ctx.job_id, "succeeded", result=result or {})
        except JobFailed as e:
            span.set_status(Status(StatusCode.ERROR, str(e)))
            _finish(ctx.job_id, "failed", error=str(e)[:4000])
        except Exception as e:
            log.exception("job %s (%s) failed", ctx.job_id, ctx.kind)
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, type(e).__name__))
            detail = "".join(traceback.format_exception_only(e)).strip()
            _finish(ctx.job_id, "failed", error=f"Unexpected error: {detail[:3500]}", retry=True)
        finally:
            stop.set()
    return True


def run_until_empty(worker_id: str = "inline", limit: int = 100) -> int:
    """Run queued jobs in the calling thread (used by the CLI and by tests that need determinism)."""
    n = 0
    while n < limit and run_one(worker_id):
        n += 1
    return n


# ------------------------------------------------------------------ workers

class Worker(threading.Thread):
    def __init__(self, index: int) -> None:
        super().__init__(daemon=True, name=f"astra-job-worker-{index}")
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}:{index}"
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    def _listen(self) -> psycopg.Connection[Any] | None:
        dsn = get_settings().control_db_url.get_secret_value().replace("postgresql+psycopg://", "postgresql://")
        try:
            conn = psycopg.connect(dsn, autocommit=True, connect_timeout=5)
            conn.execute("LISTEN astra_jobs")
            return conn
        except Exception:
            log.warning("job worker could not LISTEN; falling back to polling", exc_info=True)
            return None

    def run(self) -> None:
        listener = self._listen()
        last_recover = datetime.min.replace(tzinfo=UTC)
        try:
            while not self._stop_event.is_set():
                try:
                    if datetime.now(UTC) - last_recover > timedelta(seconds=30):
                        recover_stale()
                        last_recover = datetime.now(UTC)
                    if run_one(self.worker_id):
                        continue
                except Exception:
                    log.exception("job worker loop error")
                if listener is not None:
                    try:
                        for _ in listener.notifies(timeout=POLL_S, stop_after=1):
                            pass
                    except Exception:
                        log.warning("job listener lost; reconnecting", exc_info=True)
                        listener = self._listen()
                        self._stop_event.wait(POLL_S)
                else:
                    self._stop_event.wait(POLL_S)
        finally:
            if listener is not None:
                listener.close()


_workers: list[Worker] = []


def start_workers(count: int) -> list[Worker]:
    _ensure_handlers()
    for i in range(count):
        w = Worker(i)
        w.start()
        _workers.append(w)
    if count:
        log.info("started %d job worker(s)", count)
    return list(_workers)


def stop_workers(timeout: float = 10.0) -> None:
    for w in _workers:
        w.stop()
    for w in _workers:
        w.join(timeout)
    _workers.clear()
