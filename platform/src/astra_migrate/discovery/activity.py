"""Activity evidence: login and query records (E08.F1.S3, E08.F2.S2).

Customers export login and query records from their database's own auditing (for example SQL Server
Audit or Extended Events, or SQL Anywhere request logs) and import them in the platform's activity format,
one record per line (JSON Lines) or per row (CSV with a header):

    timestamp   ISO 8601, required
    login       database login, required
    host        client machine
    program     client program name
    statement   the SQL text (empty for a login record)

Statements are parsed for the objects they read, write or execute. The SQL text is kept only in the
tenant's database; the parsed objects drive usage and interface discovery.
"""

from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass, field
from datetime import datetime

import sqlglot
from sqlglot import exp

MAX_RECORDS = 2_000_000
_EXEC = re.compile(r"^\s*EXEC(?:UTE)?\s+([\[\]\w.]+)", re.IGNORECASE)


class ActivityError(ValueError):
    pass


@dataclass
class Event:
    ts: datetime
    login: str
    host: str
    program: str
    statement: str | None
    reads: list[str] = field(default_factory=list)
    writes: list[str] = field(default_factory=list)
    executes: list[str] = field(default_factory=list)

    @property
    def objects(self) -> list[str]:
        return sorted(set(self.reads) | set(self.writes) | set(self.executes))


def _clean(name: str) -> str:
    parts = [p.strip("[]\"` ") for p in name.split(".") if p.strip()]
    if len(parts) == 1:
        parts = ["dbo", parts[0]]
    return ".".join(parts[-2:]) if len(parts) <= 2 else ".".join(parts)


def _qualified(t: exp.Table) -> str:
    parts = [p for p in (t.catalog, t.db, t.name) if p]
    return _clean(".".join(parts))


def parse_statement(sql: str, dialect: str = "tsql") -> tuple[list[str], list[str], list[str]]:
    """Objects a statement reads, writes and executes (schema.name; four-part names kept whole)."""
    m = _EXEC.match(sql)
    if m:
        return [], [], [_clean(m.group(1))]
    try:
        tree = sqlglot.parse_one(sql, read=dialect)
    except (sqlglot.errors.ParseError, sqlglot.errors.TokenError):
        return [], [], []
    if tree is None:
        return [], [], []
    ctes = {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}
    written: set[str] = set()
    target = None
    if isinstance(tree, exp.Insert | exp.Update | exp.Delete | exp.Merge):
        target = tree.this if not isinstance(tree.this, exp.Schema) else tree.this.this
        if isinstance(target, exp.Table):
            written.add(_qualified(target))
    reads: set[str] = set()
    for t in tree.find_all(exp.Table):
        if not t.name or t.name.lower() in ctes or t is target:
            continue
        reads.add(_qualified(t))
    return sorted(reads - written), sorted(written), []


def parse_file(data: bytes, filename: str) -> list[Event]:
    text = data.decode("utf-8-sig")
    rows: list[dict[str, object]] = []
    if filename.lower().endswith((".jsonl", ".ndjson", ".json")):
        for n, line in enumerate(text.splitlines(), 1):
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as e:
                    raise ActivityError(f"Line {n} is not valid JSON: {e.msg}") from e
    elif filename.lower().endswith(".csv"):
        rows = list(csv.DictReader(io.StringIO(text)))
    else:
        raise ActivityError("Use a .jsonl or .csv file in the activity format.")
    if len(rows) > MAX_RECORDS:
        raise ActivityError(f"At most {MAX_RECORDS:,} records per import.")
    events = []
    for n, r in enumerate(rows, 1):
        try:
            ts = datetime.fromisoformat(str(r["timestamp"]).replace("Z", "+00:00"))
            login = str(r["login"]).strip()
        except (KeyError, ValueError) as e:
            raise ActivityError(f"Record {n} needs a valid timestamp and login.") from e
        stmt = str(r.get("statement") or "").strip() or None
        ev = Event(ts, login, str(r.get("host") or "").strip(), str(r.get("program") or "").strip(), stmt)
        if stmt:
            ev.reads, ev.writes, ev.executes = parse_statement(stmt)
        events.append(ev)
    return events
