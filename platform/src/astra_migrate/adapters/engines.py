"""Generic database engine drivers for source adapters.

Drivers know engines, not products. A product adapter pack supplies the catalogue queries; a driver
runs them in a read-only session and reports the engine, its version and whether the account is
read-only.

- sqlserver: Microsoft SQL Server and Azure SQL, through pymssql (FreeTDS).
- sqlanywhere: SAP SQL Anywhere, through sqlanydb, which needs SAP's client libraries on the node.
  Without them the driver reports itself unavailable and the work shows as Blocked.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Protocol

from astra_migrate.adapters.contract import ConnectionCheck
from astra_migrate.adapters.sqlguard import check_read_only
from astra_migrate.logging import register_secret

log = logging.getLogger(__name__)


class EngineUnavailable(RuntimeError):
    """The driver for this engine cannot run on this node (missing client libraries)."""


class EngineError(RuntimeError):
    """The engine refused the connection or a query. The message is safe to show."""


@dataclass(frozen=True)
class ConnParams:
    host: str
    port: int
    database: str
    user: str
    password: str = field(repr=False)
    encrypt: bool = False
    timeout_s: int = 30


def jsonable(v: Any) -> Any:
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, datetime | date):
        return v.isoformat()
    if isinstance(v, bytes | bytearray | memoryview):
        return None
    return v


class Session(Protocol):
    engine: str

    def query(self, sql: str, params: tuple[Any, ...] | None = None, *, limit: int | None = None
              ) -> list[dict[str, Any]]: ...
    def stream(self, sql: str, params: tuple[Any, ...] | None = None, batch: int = 1000
               ) -> Iterator[list[dict[str, Any]]]: ...
    def check(self, min_version: str | None) -> ConnectionCheck: ...
    def quote(self, ident: str) -> str: ...
    def close(self) -> None: ...


# ===================================================================== SQL Server

class SqlServerSession:
    engine = "sqlserver"

    def __init__(self, p: ConnParams) -> None:
        import pymssql

        register_secret(p.password)
        self.params = p
        try:
            self.conn = pymssql.connect(server=p.host, port=str(p.port), user=p.user, password=p.password,
                                        database=p.database, login_timeout=p.timeout_s, timeout=600,
                                        autocommit=False, appname="astra-migrate-adapter", tds_version="7.4")
        except pymssql.Error as e:
            raise EngineError(_mssql_message(e)) from e
        cur = self.conn.cursor()
        # Read committed snapshot is not assumed; reads use the default isolation inside one transaction
        # that is always rolled back.
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        cur.close()

    def quote(self, ident: str) -> str:
        return "[" + ident.replace("]", "]]") + "]"

    def query(self, sql: str, params: tuple[Any, ...] | None = None, *, limit: int | None = None
              ) -> list[dict[str, Any]]:
        check_read_only(sql)
        import pymssql

        cur = self.conn.cursor(as_dict=True)
        try:
            cur.execute(sql, params or ())
            rows = cur.fetchmany(limit) if limit else cur.fetchall()
        except pymssql.Error as e:
            raise EngineError(_mssql_message(e)) from e
        finally:
            cur.close()
        return [dict(r) for r in rows]

    def stream(self, sql: str, params: tuple[Any, ...] | None = None, batch: int = 1000
               ) -> Iterator[list[dict[str, Any]]]:
        check_read_only(sql)
        import pymssql

        cur = self.conn.cursor(as_dict=True)
        try:
            cur.execute(sql, params or ())
            while True:
                rows = cur.fetchmany(batch)
                if not rows:
                    break
                yield [dict(r) for r in rows]
        except pymssql.Error as e:
            raise EngineError(_mssql_message(e)) from e
        finally:
            cur.close()

    def _scalar(self, sql: str) -> Any:
        cur = self.conn.cursor()
        try:
            cur.execute(sql)
            row = cur.fetchone()
            return row[0] if row else None
        finally:
            cur.close()

    def check(self, min_version: str | None) -> ConnectionCheck:
        problems: list[str] = []
        evidence: list[str] = []
        version = str(self._scalar("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128))") or "")
        edition = str(self._scalar("SELECT CAST(SERVERPROPERTY('Edition') AS nvarchar(128))") or "")
        db = str(self._scalar("SELECT DB_NAME()") or "")
        login = str(self._scalar("SELECT SUSER_SNAME()") or "")
        flags = {
            "sysadmin": "SELECT IS_SRVROLEMEMBER('sysadmin')",
            "db_owner": "SELECT IS_MEMBER('db_owner')",
            "db_datawriter": "SELECT IS_MEMBER('db_datawriter')",
            "db_ddladmin": "SELECT IS_MEMBER('db_ddladmin')",
        }
        writable = False
        for name, q in flags.items():
            v = self._scalar(q)
            if v == 1:
                writable = True
                problems.append(f"The login is a member of {name}.")
        for perm in ("INSERT", "UPDATE", "DELETE", "ALTER", "CREATE TABLE", "CREATE PROCEDURE"):
            v = self._scalar(f"SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', '{perm}')")
            if v == 1:
                writable = True
                problems.append(f"The login holds database permission {perm}.")
        obj = "QUOTENAME(SCHEMA_NAME(t.schema_id)) + '.' + QUOTENAME(t.name)"
        n = self._scalar(
            f"SELECT COUNT(*) FROM sys.tables t WHERE HAS_PERMS_BY_NAME({obj}, 'OBJECT', 'INSERT') = 1 "
            f"OR HAS_PERMS_BY_NAME({obj}, 'OBJECT', 'UPDATE') = 1 OR HAS_PERMS_BY_NAME({obj}, 'OBJECT', 'DELETE') = 1")
        if n:
            writable = True
            problems.append(f"The login can change data in {n} table(s).")
        if not writable:
            evidence.append("Not a member of sysadmin, db_owner, db_datawriter or db_ddladmin.")
            evidence.append("No INSERT, UPDATE, DELETE, ALTER or CREATE permission on the database or any table.")
        if self._scalar("SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION')") != 1:
            problems.append("The login lacks VIEW DEFINITION, so procedure and trigger code cannot be read.")
        execs = self._scalar("SELECT COUNT(*) FROM sys.procedures p WHERE HAS_PERMS_BY_NAME("
                             "QUOTENAME(SCHEMA_NAME(p.schema_id)) + '.' + QUOTENAME(p.name), 'OBJECT', 'EXECUTE') = 1")
        if execs:
            evidence.append(f"Note: the login may execute {execs} procedure(s); the platform never executes them.")
        supported = True
        if min_version and version:
            try:
                supported = [int(x) for x in version.split(".")[:2]] >= [int(x) for x in min_version.split(".")[:2]]
            except ValueError:
                supported = True
            if not supported:
                problems.append(f"SQL Server {version} is older than the adapter supports ({min_version}).")
        return ConnectionCheck(ok=not writable and supported, engine="sqlserver", engine_version=version,
                               edition=edition, database=db, login=login, read_only=not writable,
                               read_only_evidence=evidence, supported=supported, problems=problems)

    def close(self) -> None:
        try:
            self.conn.rollback()
        finally:
            self.conn.close()


def _mssql_message(e: Exception) -> str:
    args = getattr(e, "args", ())
    if args and isinstance(args[0], tuple) and len(args[0]) == 2:
        code, msg = args[0]
        text = msg.decode(errors="replace") if isinstance(msg, bytes) else str(msg)
        return f"SQL Server error {code}: {text.splitlines()[0][:300]}"
    return f"SQL Server error: {str(e)[:300]}"


# ===================================================================== SQL Anywhere

class SqlAnywhereSession:
    engine = "sqlanywhere"

    def __init__(self, p: ConnParams) -> None:
        try:
            import sqlanydb  # type: ignore[import-not-found]
        except Exception as e:  # ImportError, or the native client library failing to load
            raise EngineUnavailable(
                "The SQL Anywhere driver is not available on this platform node: it needs the sqlanydb package "
                "and SAP SQL Anywhere client libraries.") from e
        register_secret(p.password)
        try:
            self.conn = sqlanydb.connect(host=f"{p.host}:{p.port}", dbn=p.database, uid=p.user, pwd=p.password)
        except Exception as e:
            raise EngineError(f"SQL Anywhere error: {str(e)[:300]}") from e

    def quote(self, ident: str) -> str:
        return '"' + ident.replace('"', '""') + '"'

    def query(self, sql: str, params: tuple[Any, ...] | None = None, *, limit: int | None = None
              ) -> list[dict[str, Any]]:
        check_read_only(sql)
        cur = self.conn.cursor()
        try:
            cur.execute(sql, params or ())
            cols = [d[0] for d in cur.description or []]
            rows = cur.fetchmany(limit) if limit else cur.fetchall()
            return [dict(zip(cols, r, strict=False)) for r in rows]
        finally:
            cur.close()

    def stream(self, sql: str, params: tuple[Any, ...] | None = None, batch: int = 1000
               ) -> Iterator[list[dict[str, Any]]]:
        check_read_only(sql)
        cur = self.conn.cursor()
        try:
            cur.execute(sql, params or ())
            cols = [d[0] for d in cur.description or []]
            while True:
                rows = cur.fetchmany(batch)
                if not rows:
                    break
                yield [dict(zip(cols, r, strict=False)) for r in rows]
        finally:
            cur.close()

    def check(self, min_version: str | None) -> ConnectionCheck:
        rows = self.query("SELECT PROPERTY('ProductVersion') AS v, DB_NAME() AS d, CURRENT USER AS u")
        version, db, user = (str(rows[0].get(k) or "") for k in ("v", "d", "u")) if rows else ("", "", "")
        auth = self.query("SELECT COUNT(*) AS n FROM SYS.SYSTABLEPERM WHERE grantee = USER_ID() AND "
                          "(insertauth <> 'N' OR deleteauth <> 'N' OR updateauth <> 'N' OR alterauth <> 'N')")
        writable = bool(auth and int(auth[0]["n"] or 0) > 0)
        problems = ["The user holds INSERT, UPDATE, DELETE or ALTER permission on tables."] if writable else []
        return ConnectionCheck(ok=not writable, engine="sqlanywhere", engine_version=version, database=db,
                               login=user, read_only=not writable,
                               read_only_evidence=[] if writable else ["No table write permissions granted."],
                               supported=True, problems=problems)

    def close(self) -> None:
        try:
            self.conn.rollback()
        finally:
            self.conn.close()


def open_session(engine: str, p: ConnParams) -> Session:
    if engine == "sqlserver":
        return SqlServerSession(p)
    if engine == "sqlanywhere":
        return SqlAnywhereSession(p)
    raise EngineUnavailable(f"No driver for engine '{engine}'.")
