"""Control-plane database engine and sessions."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from astra_migrate.config import get_settings
from astra_migrate.logging import register_secret


@lru_cache(maxsize=1)
def engine() -> Engine:
    url = get_settings().control_db_url.get_secret_value()
    register_secret(url.split(":")[2].split("@")[0] if url.count(":") >= 2 else None)
    return create_engine(url, pool_pre_ping=True, pool_size=10, max_overflow=10)


@lru_cache(maxsize=1)
def _factory() -> sessionmaker[Session]:
    return sessionmaker(bind=engine(), expire_on_commit=False)


@contextmanager
def session_scope() -> Iterator[Session]:
    s = _factory()()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one transaction per request."""
    with session_scope() as s:
        yield s
