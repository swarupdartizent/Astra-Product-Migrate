"""Tracing (E01.F3.S2).

Every request, agent call, tool call and load step is an OpenTelemetry span. Spans go to two places:
- the OTLP collector (Jaeger locally, Azure Monitor in Azure) for deep inspection;
- the platform's own span store, which powers the time-and-cost dashboard by project, stage and agent.

Span attribute conventions (set by the code that starts the span):
  astra.category   http | agent | tool | load | job | other
  astra.tenant_id, astra.project_id, astra.stage, astra.agent
  gen_ai.request.model, astra.cost_usd
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import psycopg
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace import SpanKind, StatusCode
from psycopg.types.json import Jsonb

from astra_migrate.config import get_settings

log = logging.getLogger(__name__)
STORED_CATEGORIES = {"http", "agent", "tool", "load", "job", "other"}


def _category(span: ReadableSpan) -> str:
    attrs = span.attributes or {}
    if "astra.category" in attrs:
        return str(attrs["astra.category"])
    if "db.system" in attrs:
        return "db"
    if span.kind == SpanKind.SERVER or "http.route" in attrs:
        return "http"
    if span.kind == SpanKind.CLIENT:
        return "tool"
    return "other"


_COLS = ["span_id", "trace_id", "parent_span_id", "name", "kind", "category", "started_at", "duration_ms", "status",
         "tenant_id", "project_id", "stage", "agent", "model", "cost_usd", "attributes"]
_INSERT = (f"INSERT INTO trace_spans ({', '.join(_COLS)}) VALUES ({', '.join(['%s'] * len(_COLS))}) "
           "ON CONFLICT (span_id) DO NOTHING")


class SpanStoreExporter(SpanExporter):
    """Writes span summaries to the control database (database spans are left to the OTLP backend).
    Uses a plain driver connection, which is never instrumented, so the exporter does not trace itself."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._conn: psycopg.Connection[Any] | None = None

    def _connection(self) -> psycopg.Connection[Any]:
        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self._dsn, autocommit=True, connect_timeout=5)
        return self._conn

    def shutdown(self) -> None:
        if self._conn is not None and not self._conn.closed:
            self._conn.close()

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        rows: list[dict[str, Any]] = []
        for s in spans:
            cat = _category(s)
            if cat not in STORED_CATEGORIES or s.context is None or s.start_time is None or s.end_time is None:
                continue
            a = dict(s.attributes or {})
            rows.append({
                "span_id": format(s.context.span_id, "016x"),
                "trace_id": format(s.context.trace_id, "032x"),
                "parent_span_id": format(s.parent.span_id, "016x") if s.parent else None,
                "name": s.name[:200], "kind": s.kind.name.lower(), "category": cat,
                "started_at": datetime.fromtimestamp(s.start_time / 1e9, UTC),
                "duration_ms": (s.end_time - s.start_time) / 1e6,
                "status": "error" if s.status.status_code == StatusCode.ERROR else "ok",
                "tenant_id": a.get("astra.tenant_id"), "project_id": a.get("astra.project_id"),
                "stage": a.get("astra.stage"), "agent": a.get("astra.agent"),
                "model": a.get("gen_ai.request.model"),
                "cost_usd": float(str(a["astra.cost_usd"])) if "astra.cost_usd" in a else None,
                "attributes": {k: v if isinstance(v, str | int | float | bool) else str(v) for k, v in a.items()},
            })
        if not rows:
            return SpanExportResult.SUCCESS
        try:
            with self._connection().cursor() as cur:
                cur.executemany(_INSERT, [[Jsonb(r[c]) if c == "attributes" else r[c] for c in _COLS] for r in rows])
            return SpanExportResult.SUCCESS
        except Exception:
            self._conn = None
            log.warning("span store export failed; %d spans dropped", len(rows), exc_info=True)
            return SpanExportResult.FAILURE


_provider: TracerProvider | None = None


def configure_tracing(service_name: str = "astra-migrate-api") -> TracerProvider:
    global _provider
    if _provider is not None:
        return _provider
    s = get_settings()
    provider = TracerProvider(resource=Resource.create({
        "service.name": service_name, "service.version": s.version, "deployment.environment": s.environment}))
    if s.otlp_endpoint:
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{s.otlp_endpoint}/v1/traces")))
    dsn = s.control_db_url.get_secret_value().replace("postgresql+psycopg://", "postgresql://")
    provider.add_span_processor(BatchSpanProcessor(SpanStoreExporter(dsn), schedule_delay_millis=1000))
    trace.set_tracer_provider(provider)
    _provider = provider
    return provider


def tracer(name: str = "astra_migrate") -> trace.Tracer:
    return trace.get_tracer(name)


def tag_current(**attrs: str | float | int | None) -> None:
    span = trace.get_current_span()
    for k, v in attrs.items():
        if v is not None:
            span.set_attribute(f"astra.{k}", v)
