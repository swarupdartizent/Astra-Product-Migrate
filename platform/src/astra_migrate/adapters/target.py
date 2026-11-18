"""Target adapter operations (E05.F3.S1-S3).

Loads go only through the vendor's APIs with OAuth2 client credentials. The contract has no database
load method, and this module has no database driver, so a direct write to a target database cannot
be expressed. Every call is rate-limited to the adapter's recorded limit and logged with its result.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from opentelemetry import trace
from sqlalchemy import insert
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.adapters.contract import Baseline, TargetAdapterContent, parse_target
from astra_migrate.connector_secrets import read_for_connector
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import LoadCall, Pack, TargetBaseline, TargetConnection, Tenant
from astra_migrate.jobs.runner import JobContext, JobFailed, handler
from astra_migrate.logging import register_secret
from astra_migrate.packs.registry import manifest_of
from astra_migrate.packs.schema import parse_ref
from astra_migrate.vault import get_vault

MAX_RETRIES_429 = 3


class TargetError(ValueError):
    pass


class RateLimiter:
    """Token bucket: `per_minute` requests with up to `burst` at once."""

    def __init__(self, per_minute: int, burst: int = 1) -> None:
        self.rate = per_minute / 60.0
        self.capacity = float(max(1, burst))
        self.tokens = self.capacity
        self.updated = time.monotonic()
        self.lock = threading.Lock()

    def acquire(self) -> float:
        """Block until a request may go. Returns the milliseconds waited."""
        waited = 0.0
        while True:
            with self.lock:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return waited * 1000
                need = (1 - self.tokens) / self.rate
            time.sleep(need)
            waited += need


def target_pack(session: Session, ref: str) -> tuple[Pack, TargetAdapterContent]:
    name, version = parse_ref(ref)
    from sqlalchemy import select

    p = session.scalar(select(Pack).where(Pack.name == name, Pack.version == version,
                                          Pack.status.in_(("published", "deprecated"))))
    if p is None or p.type != "target_adapter":
        raise TargetError(f"{ref} is not a published target adapter.")
    return p, parse_target(manifest_of(p).content)


@dataclass
class LoadResult:
    calls: int
    loaded: int
    rejected: int
    rate_limited: int
    waited_ms: float


class TargetClient:
    def __init__(self, conn: TargetConnection, content: TargetAdapterContent, client_secret: str,
                 http: httpx.Client | None = None) -> None:
        register_secret(client_secret)
        self.conn, self.content, self.secret = conn, content, client_secret
        self.http = http or httpx.Client(base_url=conn.base_url.rstrip("/"), timeout=60.0)
        rl = content.load.rate_limit
        self.limiter = RateLimiter(rl.requests_per_minute, rl.burst)
        self.token: str | None = None
        self.token_expires = 0.0

    def _token(self) -> str:
        if self.token and time.monotonic() < self.token_expires - 30:
            return self.token
        if not self.content.load.token_path:
            raise TargetError("Blocked: the target adapter does not yet record the target's OAuth2 token endpoint.")
        r = self.http.post(self.content.load.token_path, data={
            "grant_type": "client_credentials", "client_id": self.conn.client_id, "client_secret": self.secret,
            **({"scope": " ".join(self.content.load.scopes)} if self.content.load.scopes else {})})
        if r.status_code != 200:
            raise TargetError(f"The target refused the client credentials (HTTP {r.status_code}).")
        body = r.json()
        tok = body.get("access_token")
        if not tok:
            raise TargetError("The target's token response had no access_token.")
        register_secret(tok)
        self.token, self.token_expires = tok, time.monotonic() + float(body.get("expires_in", 300))
        return str(tok)

    def _log(self, *, entity: str | None, method: str, path: str, status: int | None, outcome: str, records: int,
             waited: float, latency: float, remaining: str | None, error: str | None) -> None:
        ctx = trace.get_current_span().get_span_context()
        with session_scope() as s:
            s.execute(insert(LoadCall).values(
                id=uuid.uuid4(), tenant_id=self.conn.tenant_id, connection_id=self.conn.id, adapter=self.conn.adapter,
                entity=entity, method=method, path=path, status_code=status, outcome=outcome, records=records,
                waited_ms=round(waited, 2), latency_ms=round(latency, 2), rate_limit_remaining=remaining,
                error=error, trace_id=format(ctx.trace_id, "032x") if ctx.is_valid else None))

    def call(self, method: str, path: str, body: Any = None, label: str = "test") -> tuple[int | None, Any, str | None]:
        """One authenticated call for an end-to-end test, logged like every other call. Returns
        (status, parsed body, error)."""
        waited = self.limiter.acquire()
        t0 = time.perf_counter()
        try:
            r = self.http.request(method, path, json=body, headers={"Authorization": f"Bearer {self._token()}"})
        except httpx.HTTPError as e:
            self._log(entity=label, method=method, path=path, status=None, outcome="error", records=0,
                      waited=waited, latency=(time.perf_counter() - t0) * 1000, remaining=None,
                      error=type(e).__name__)
            return None, None, f"The target could not be reached: {type(e).__name__}"
        ok = 200 <= r.status_code < 300
        self._log(entity=label, method=method, path=path, status=r.status_code, outcome="ok" if ok else "rejected",
                  records=0, waited=waited, latency=(time.perf_counter() - t0) * 1000,
                  remaining=r.headers.get("x-ratelimit-remaining"), error=None if ok else r.text[:500])
        try:
            parsed: Any = r.json()
        except ValueError:
            parsed = r.text[:2000]
        return r.status_code, parsed, None

    def load(self, entity: str, records: list[dict[str, Any]]) -> LoadResult:
        ep = next((e for e in self.content.load.endpoints if e.entity == entity), None)
        if ep is None:
            raise TargetError(f"Blocked: the target adapter records no load endpoint for '{entity}'.")
        res = LoadResult(0, 0, 0, 0, 0.0)
        for i in range(0, len(records), ep.batch_size):
            batch = records[i:i + ep.batch_size]
            body: Any = batch if ep.batch_size > 1 else batch[0]
            for attempt in range(MAX_RETRIES_429 + 1):
                waited = self.limiter.acquire()
                res.waited_ms += waited
                t0 = time.perf_counter()
                try:
                    r = self.http.request(ep.method, ep.path, json=body,
                                          headers={"Authorization": f"Bearer {self._token()}"})
                except httpx.HTTPError as e:
                    self._log(entity=entity, method=ep.method, path=ep.path, status=None, outcome="error",
                              records=len(batch), waited=waited, latency=(time.perf_counter() - t0) * 1000,
                              remaining=None, error=type(e).__name__)
                    raise TargetError(f"The target could not be reached: {type(e).__name__}") from e
                latency = (time.perf_counter() - t0) * 1000
                remaining = r.headers.get("x-ratelimit-remaining")
                res.calls += 1
                if r.status_code == 429:
                    res.rate_limited += 1
                    retry_after = float(r.headers.get("retry-after", "1") or 1)
                    self._log(entity=entity, method=ep.method, path=ep.path, status=429, outcome="rate_limited",
                              records=len(batch), waited=waited, latency=latency, remaining=remaining,
                              error=f"retry after {retry_after}s")
                    if attempt == MAX_RETRIES_429:
                        raise TargetError("The target kept refusing calls for rate limiting.")
                    time.sleep(min(retry_after, 60))
                    continue
                ok = 200 <= r.status_code < 300
                self._log(entity=entity, method=ep.method, path=ep.path, status=r.status_code,
                          outcome="ok" if ok else "rejected", records=len(batch), waited=waited, latency=latency,
                          remaining=remaining, error=None if ok else r.text[:500])
                if ok:
                    res.loaded += len(batch)
                else:
                    res.rejected += len(batch)
                break
        return res


@handler("target.load")
def run_load(ctx: JobContext) -> dict[str, Any]:
    with session_scope() as s:
        conn = s.get(TargetConnection, uuid.UUID(ctx.payload["connection_id"]))
        if conn is None:
            raise JobFailed("The target connection no longer exists.")
        t = s.get(Tenant, conn.tenant_id)
        assert t is not None
        _p, content = target_pack(s, conn.adapter)
        secret = read_for_connector(s, get_vault(), t, conn.client_secret_ref, f"target:{conn.name}")
        s.expunge_all()
    client = TargetClient(conn, content, secret)
    try:
        res = client.load(ctx.payload["entity"], list(ctx.payload["records"]))
    except TargetError as e:
        raise JobFailed(str(e)) from e
    with session_scope() as s:
        audit.record(s, ctx.actor, "target.load_finished", tenant_id=conn.tenant_id, target_type="target_connection",
                     target_id=str(conn.id), details={"entity": ctx.payload["entity"], **res.__dict__})
    return dict(res.__dict__)


# ------------------------------------------------------------------ baselines

def store_baseline(session: Session, adapter_name: str, name: str, raw: dict[str, Any], user_id: uuid.UUID,
                   actor: audit.Actor, synthetic: bool) -> TargetBaseline:
    b = Baseline.model_validate(raw)
    canonical = json.dumps(b.model_dump(mode="json", by_alias=True), sort_keys=True)
    from sqlalchemy import select

    if session.scalar(select(TargetBaseline).where(TargetBaseline.adapter_name == adapter_name,
                                                   TargetBaseline.name == name)):
        raise TargetError(f"A baseline named '{name}' already exists for {adapter_name}. Baselines never change; "
                          "use a new name.")
    tb = TargetBaseline(adapter_name=adapter_name, name=name, product_version=b.product_version,
                        provided_by=b.provided_by,
                        provided_on=datetime.combine(b.provided_on, datetime.min.time(), UTC),
                        content=json.loads(canonical), digest=hashlib.sha256(canonical.encode()).hexdigest(),
                        object_count=len(b.objects), synthetic=synthetic, created_by=user_id)
    session.add(tb)
    session.flush()
    audit.record(session, actor, "target.baseline_stored", target_type="target_baseline", target_id=str(tb.id),
                 details={"adapter": adapter_name, "name": name, "product_version": b.product_version,
                          "objects": len(b.objects), "digest": tb.digest, "synthetic": synthetic})
    return tb
