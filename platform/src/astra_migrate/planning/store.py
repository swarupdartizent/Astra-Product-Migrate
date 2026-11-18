"""The plan's storage in the tenant database: one row per (project, kind, key)."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg

from astra_migrate.db.models import Tenant
from astra_migrate.tenancy.service import migrate_tenant_schema, tenant_connection
from astra_migrate.vault import get_vault

KINDS = ("scope", "edge", "task", "wave", "pin", "wave_plan", "risk", "cutover_choice", "runbook_step",
         "coexistence")


@contextmanager
def connect(t: Tenant) -> Iterator[psycopg.Connection[Any]]:
    with tenant_connection(t, get_vault()) as tc:
        migrate_tenant_schema(tc)
        yield tc


def items(tc: psycopg.Connection[Any], project_id: uuid.UUID, kind: str | None = None) -> dict[str, dict[str, Any]]:
    """key -> body (with kind for whole-plan reads)."""
    if kind:
        rows = tc.execute("SELECT key, body FROM estate.plan_items WHERE project_id = %s AND kind = %s ORDER BY key",
                          (project_id, kind)).fetchall()
        return {k: b for k, b in rows}
    rows = tc.execute("SELECT kind, key, body FROM estate.plan_items WHERE project_id = %s ORDER BY kind, key",
                      (project_id,)).fetchall()
    return {f"{k}/{key}": b for k, key, b in rows}


def get(tc: psycopg.Connection[Any], project_id: uuid.UUID, kind: str, key: str) -> dict[str, Any] | None:
    row = tc.execute("SELECT body FROM estate.plan_items WHERE project_id = %s AND kind = %s AND key = %s",
                     (project_id, kind, key)).fetchone()
    return row[0] if row else None


def put(tc: psycopg.Connection[Any], project_id: uuid.UUID, kind: str, key: str, body: dict[str, Any],
        by: str) -> None:
    tc.execute("INSERT INTO estate.plan_items(project_id, kind, key, body, updated_by) VALUES (%s,%s,%s,%s,%s) "
               "ON CONFLICT (project_id, kind, key) DO UPDATE SET body = excluded.body, "
               "updated_by = excluded.updated_by, updated_at = now()",
               (project_id, kind, key, json.dumps(body, default=str), by))


def put_many(tc: psycopg.Connection[Any], project_id: uuid.UUID, kind: str, rows: dict[str, dict[str, Any]],
             by: str, *, replace: bool = False) -> None:
    with tc.cursor() as cur:
        if replace:
            cur.execute("DELETE FROM estate.plan_items WHERE project_id = %s AND kind = %s", (project_id, kind))
        cur.executemany(
            "INSERT INTO estate.plan_items(project_id, kind, key, body, updated_by) VALUES (%s,%s,%s,%s,%s) "
            "ON CONFLICT (project_id, kind, key) DO UPDATE SET body = excluded.body, "
            "updated_by = excluded.updated_by, updated_at = now()",
            [(project_id, kind, k, json.dumps(b, default=str), by) for k, b in rows.items()])


def delete(tc: psycopg.Connection[Any], project_id: uuid.UUID, kind: str, key: str) -> bool:
    cur = tc.execute("DELETE FROM estate.plan_items WHERE project_id = %s AND kind = %s AND key = %s",
                     (project_id, kind, key))
    return cur.rowcount > 0


def snapshot(tc: psycopg.Connection[Any], project_id: uuid.UUID) -> dict[str, dict[str, Any]]:
    """The whole plan as kind/key -> body, for baselines and diffs."""
    return items(tc, project_id)
