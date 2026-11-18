"""The conversion workbench (E10.F1.S1, E10.F1.S2): a SQL Server database where converted code is compiled and
its recorded test cases are run, never against the customer's source or the target product.

Every check runs inside one transaction that is always rolled back: the tables the code needs are created (from
the pinned target baseline and from the source's own data dictionary), the converted object is created, the test
case's rows are inserted, the object is called, and everything disappears again. Nothing persists between checks.

The workbench login is a deployment setting (ASTRA_WORKBENCH_SQLSERVER = user:password@host:port/database).
Without it, conversion runs are Blocked with that reason rather than reported as passing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from astra_migrate.config import get_settings
from astra_migrate.logging import register_secret

SAFE_TYPE = re.compile(r"^[a-z][a-z0-9_ ]*(\(\s*(\d+|max)\s*(,\s*\d+)?\s*\))?$", re.IGNORECASE)
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
SQLSERVER_TYPES = {
    "bigint", "int", "smallint", "tinyint", "bit", "decimal", "numeric", "money", "smallmoney", "float", "real",
    "date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "time", "char", "varchar", "nchar",
    "nvarchar", "text", "ntext", "binary", "varbinary", "image", "uniqueidentifier", "xml", "sql_variant",
}


class WorkbenchBlocked(RuntimeError):
    """No workbench is configured on this deployment, or it cannot be reached. The message says why."""


@dataclass(frozen=True)
class WorkbenchTarget:
    host: str
    port: int
    user: str
    password: str
    database: str


def workbench_target() -> WorkbenchTarget:
    raw = get_settings().workbench_sqlserver
    if not raw:
        raise WorkbenchBlocked("No SQL Server workbench is configured on this deployment (ASTRA_WORKBENCH_SQLSERVER), "
                               "so converted code cannot be compiled or tested.")
    secret = raw.get_secret_value()
    cred, rest = secret.rsplit("@", 1)
    user, password = cred.split(":", 1)
    hostport, _, database = rest.partition("/")
    host, port = hostport.rsplit(":", 1)
    register_secret(password)
    return WorkbenchTarget(host, int(port), user, password, database or "astra_workbench")


@dataclass
class Table:
    schema: str
    name: str
    columns: list[tuple[str, str]]  # (name, SQL Server type)
    not_null: frozenset[str] = frozenset()
    primary_key: tuple[str, ...] = ()


def q(ident: str) -> str:
    return "[" + ident.replace("]", "]]") + "]"


def sqlserver_type(t: str) -> str:
    """A column type that is safe to put into DDL; unknown or unsafe types become nvarchar(max)."""
    t = (t or "").strip().lower()
    if not SAFE_TYPE.match(t):
        return "nvarchar(max)"
    base = re.sub(r"\(.*\)", "", t).strip()
    return t if base in SQLSERVER_TYPES else "nvarchar(max)"


def tables_from_baseline(content: dict[str, Any]) -> list[Table]:
    out = []
    for o in content.get("objects", []):
        if o.get("type") != "table" or not o.get("columns"):
            continue
        out.append(Table(o.get("schema") or "dbo", o["name"],
                         [(str(c["name"]), sqlserver_type(str(c.get("type", "")))) for c in o["columns"]]))
    return out


@dataclass
class Compile:
    ok: bool
    error: str | None = None
    unresolved: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "error": self.error, "unresolved": self.unresolved}


@dataclass
class TestOutcome:
    test_id: str
    name: str
    passed: bool
    inputs: dict[str, Any]
    expected: Any
    actual: Any
    differences: list[str]
    error: str | None = None


def _plain(v: Any) -> Any:
    if isinstance(v, Decimal):
        return format(v.normalize(), "f") if v == v.to_integral_value() else str(v.normalize())
    if isinstance(v, datetime | date):
        return v.isoformat()
    if isinstance(v, bytes):
        return v.hex()
    if isinstance(v, bool):
        return int(v)
    return v


def _norm(v: Any) -> str | None:
    if v is None:
        return None
    p = _plain(v)
    if isinstance(p, float) and p.is_integer():
        p = int(p)
    s = str(p)
    if re.fullmatch(r"-?\d+\.\d*?0+", s):
        s = s.rstrip("0").rstrip(".")
    return s


def _message(e: Exception) -> str:
    args: tuple[Any, ...] = tuple(getattr(e, "args", ()))
    if len(args) >= 2 and isinstance(args[1], bytes):
        text = args[1].decode("utf-8", "replace")
        return re.sub(r"\s*DB-Lib error message.*$", "", text, flags=re.DOTALL).strip()
    return str(e)


class Workbench:
    def __init__(self, target: WorkbenchTarget | None = None) -> None:
        import pymssql

        self.t = target or workbench_target()
        try:
            boot = pymssql.connect(server=self.t.host, port=str(self.t.port), user=self.t.user,
                                   password=self.t.password, database="master", autocommit=True, login_timeout=20,
                                   tds_version="7.4")
            cur = boot.cursor()
            cur.execute(f"IF DB_ID(N'{self.t.database.replace(chr(39), '')}') IS NULL "
                        f"CREATE DATABASE {q(self.t.database)}")
            boot.close()
            self.conn = pymssql.connect(server=self.t.host, port=str(self.t.port), user=self.t.user,
                                        password=self.t.password, database=self.t.database, autocommit=False,
                                        login_timeout=20, tds_version="7.4")
        except pymssql.Error as e:
            raise WorkbenchBlocked(f"The SQL Server workbench cannot be reached: {_message(e)}") from e

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> Workbench:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -------------------------------------------------------------- inside one rolled-back transaction

    def _exec(self, cur: Any, sql: str, params: tuple[Any, ...] | None = None) -> None:
        cur.execute(sql, params) if params else cur.execute(sql)

    def _schema(self, cur: Any, tables: list[Table]) -> None:
        schemas = sorted({t.schema for t in tables if t.schema.lower() != "dbo"})
        for s in schemas:
            self._exec(cur, f"IF SCHEMA_ID(N'{s.replace(chr(39), '')}') IS NULL EXEC('CREATE SCHEMA {q(s)}')")
        seen: set[str] = set()
        for t in tables:
            key = f"{t.schema}.{t.name}".lower()
            if key in seen or not t.columns:
                continue
            seen.add(key)
            cols = ", ".join(f"{q(c)} {typ} {'NOT NULL' if c in t.not_null else 'NULL'}" for c, typ in t.columns)
            if t.primary_key:
                cols += f", PRIMARY KEY ({', '.join(q(c) for c in t.primary_key)})"
            self._exec(cur, f"CREATE TABLE {q(t.schema)}.{q(t.name)} ({cols})")

    def _unresolved(self, cur: Any, qualified: str) -> list[str]:
        cur.execute("SELECT DISTINCT COALESCE(referenced_schema_name + '.', '') + referenced_entity_name "
                    "FROM sys.sql_expression_dependencies WHERE referencing_id = OBJECT_ID(%s) "
                    "AND referenced_id IS NULL AND is_ambiguous = 0", (qualified,))
        return sorted(str(r[0]) for r in cur.fetchall() if str(r[0]).lower() not in ("inserted", "deleted"))

    def compile(self, tables: list[Table], sql: str, qualified: str) -> Compile:
        import pymssql

        cur = self.conn.cursor()
        try:
            self._schema(cur, tables)
            try:
                self._exec(cur, sql)
            except pymssql.Error as e:
                return Compile(False, _message(e))
            return Compile(True, None, self._unresolved(cur, qualified))
        except pymssql.Error as e:
            return Compile(False, f"The workbench schema could not be built: {_message(e)}")
        finally:
            cur.close()
            self.conn.rollback()

    def scenario(self, tables: list[Table], steps: list[tuple[str, tuple[Any, ...] | None]],
                 checks: list[tuple[str, str]]) -> tuple[str | None, list[tuple[str, Any]]]:
        """Build the tables, run the steps, then run each check query (one scalar each), all in one transaction
        that is rolled back. Returns (the first error, or None) and the check values."""
        import pymssql

        cur = self.conn.cursor()
        try:
            self._schema(cur, tables)
            for sql, params in steps:
                self._exec(cur, sql, params)
            values: list[tuple[str, Any]] = []
            for name, sql in checks:
                cur.execute(sql)
                row = cur.fetchone()
                values.append((name, _plain(row[0]) if row else None))
            return None, values
        except pymssql.Error as e:
            return _message(e), []
        finally:
            cur.close()
            self.conn.rollback()

    def run_test(self, tables: list[Table], sql: str, kind: str, qualified: str, case: dict[str, Any]
                 ) -> TestOutcome:
        """Run one recorded case: insert its rows, call the object with its inputs, compare what comes back."""
        import pymssql

        tid, name = str(case.get("id", "")), str(case.get("name", ""))
        inputs: dict[str, Any] = dict(case.get("inputs") or {})
        expected = case.get("expected") or {}
        outs = [str(o) for o in case.get("outputs") or []]
        bad = [k for k in [*inputs, *outs] if not IDENT.fullmatch(str(k))]
        if bad:
            return TestOutcome(tid, name, False, inputs, expected, None,
                               [f"Parameter names must be plain identifiers: {', '.join(map(str, bad))}"])
        target = ".".join(q(part) for part in qualified.split(".", 1))
        cur = self.conn.cursor(as_dict=False)
        try:
            self._schema(cur, tables)
            self._exec(cur, sql)
            for table, rows in (case.get("setup") or {}).items():
                for row in rows:
                    cols = list(row)
                    schema, _, tname = table.rpartition(".")
                    self._exec(cur, f"INSERT INTO {q(schema or 'dbo')}.{q(tname)} ({', '.join(q(c) for c in cols)}) "
                                    f"VALUES ({', '.join(['%s'] * len(cols))})", tuple(row[c] for c in cols))
            actual: dict[str, Any] = {}
            if kind == "trigger":
                pass  # the setup rows fired the trigger; an expected error is checked below
            elif kind == "function":
                args = ", ".join(["%s"] * len(inputs))
                cur.execute(f"SELECT {target}({args})", tuple(inputs.values()))
                row = cur.fetchone()
                actual["value"] = _plain(row[0]) if row else None
            else:
                decl = "".join(f"DECLARE @o_{o} nvarchar(max); " for o in outs)
                params = [f"@{k} = %s" for k in inputs] + [f"@{o} = @o_{o} OUTPUT" for o in outs]
                tail = f"; SELECT {', '.join(f'@o_{o} AS {q(o)}' for o in outs)}" if outs else ""
                cur.execute(f"{decl}EXEC {target} {', '.join(params)}{tail}", tuple(inputs.values()))
                sets: list[list[list[Any]]] = []
                while True:
                    if cur.description:
                        sets.append([[_plain(v) for v in r] for r in cur.fetchall()])
                    if not cur.nextset():
                        break
                if outs and sets:
                    actual["outputs"] = dict(zip(outs, sets.pop()[0], strict=True))
                actual["rows"] = sets[0] if sets else []
            diffs = _compare(expected, actual)
            if expected.get("error"):
                diffs.append(f"expected the error {expected['error']!r}, but the case ran without one")
            return TestOutcome(tid, name, not diffs, inputs, expected, actual, diffs)
        except pymssql.Error as e:
            msg = _message(e)
            want = expected.get("error")
            if want and str(want).lower() in msg.lower():
                return TestOutcome(tid, name, True, inputs, expected, {"error": msg}, [])
            return TestOutcome(tid, name, False, inputs, expected, {"error": msg},
                               [f"error: expected {want!r}, got {msg!r}" if want else f"The case failed: {msg}"], msg)
        finally:
            cur.close()
            self.conn.rollback()


def _compare(expected: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    diffs: list[str] = []
    if "value" in expected and _norm(expected["value"]) != _norm(actual.get("value")):
        diffs.append(f"value: expected {expected['value']!r}, got {actual.get('value')!r}")
    for k, v in (expected.get("outputs") or {}).items():
        got = (actual.get("outputs") or {}).get(k)
        if _norm(v) != _norm(got):
            diffs.append(f"output {k}: expected {v!r}, got {got!r}")
    if "rows" in expected:
        exp = [[_norm(x) for x in r] for r in expected["rows"]]
        got_rows = [[_norm(x) for x in r] for r in actual.get("rows") or []]
        if len(exp) != len(got_rows):
            diffs.append(f"rows: expected {len(exp)}, got {len(got_rows)}")
        for i, (e, g) in enumerate(zip(exp, got_rows, strict=False)):
            if e != g:
                diffs.append(f"row {i + 1}: expected {e}, got {g}")
    return diffs
