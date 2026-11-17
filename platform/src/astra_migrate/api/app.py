"""FastAPI application factory."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

from astra_migrate.api import errors
from astra_migrate.api.routes import access, core, secrets_audit_obs, tenants
from astra_migrate.config import get_settings
from astra_migrate.db.control import engine
from astra_migrate.logging import configure_logging, register_secret
from astra_migrate.observability import configure_tracing

API_PREFIX = "/api/v1"


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging()
    for sec in (settings.vault_token, settings.provisioner_password):
        register_secret(sec.get_secret_value())
    provider = configure_tracing()

    app = FastAPI(title="Astra Migrate API", version=settings.version, openapi_url=f"{API_PREFIX}/openapi.json",
                  docs_url=f"{API_PREFIX}/docs", redoc_url=None)
    errors.install(app)
    app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
                       allow_methods=["*"], allow_headers=["*"], allow_credentials=False)
    for r in (core.router, tenants.router, access.router, secrets_audit_obs.router):
        app.include_router(r, prefix=API_PREFIX)

    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider, excluded_urls="/api/v1/health")
    SQLAlchemyInstrumentor().instrument(engine=engine(), tracer_provider=provider)
    HTTPXClientInstrumentor().instrument(tracer_provider=provider)
    return app


app = create_app()
