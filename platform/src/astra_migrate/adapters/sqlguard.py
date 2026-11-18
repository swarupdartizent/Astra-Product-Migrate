"""Read-only guard for adapter SQL (E05.F1.S1: adapters run with read-only access to sources).

Three layers keep sources safe; this module is the first:
1. Every statement an adapter pack ships is checked here at registration and again before it runs:
   one statement, starting with SELECT or WITH, and no data-changing, DDL, permission, execution or
   external-access keyword anywhere outside string literals and comments.
2. The connection check refuses an account that can write (engine permission queries).
3. Every adapter session runs inside a transaction that is always rolled back.
"""

from __future__ import annotations

import re


class ReadOnlyViolation(ValueError):
    pass


FORBIDDEN = (
    "insert", "update", "delete", "merge", "truncate", "drop", "alter", "create", "grant", "revoke", "deny",
    "exec", "execute", "call", "into", "openrowset", "opendatasource", "openquery", "bulk", "backup", "restore",
    "dbcc", "shutdown", "kill", "reconfigure", "xp_cmdshell", "sp_configure", "waitfor", "use", "declare",
    "set", "commit", "rollback", "begin", "load", "unload", "copy", "attach", "detach", "writetext",
    "updatetext", "readtext", "for",
)
_FORBIDDEN_RE = re.compile(r"\b(" + "|".join(FORBIDDEN) + r")\b", re.IGNORECASE)
# FOR is allowed only as part of FOR XML / FOR JSON PATH output shaping.
_FOR_OUTPUT = re.compile(r"\bfor\s+(xml|json)\b", re.IGNORECASE)


def _strip(sql: str) -> str:
    """Remove string literals, quoted identifiers and comments so keywords inside them don't count."""
    out = re.sub(r"--[^\n]*", " ", sql)
    out = re.sub(r"/\*.*?\*/", " ", out, flags=re.DOTALL)
    out = re.sub(r"'(?:[^']|'')*'", "''", out)
    out = re.sub(r"\[[^\]]*\]", "[x]", out)
    out = re.sub(r'"[^"]*"', '"x"', out)
    return out


def check_read_only(sql: str) -> None:
    if not sql or not sql.strip():
        raise ReadOnlyViolation("empty statement")
    body = _strip(sql).strip().rstrip(";").strip()
    if ";" in body:
        raise ReadOnlyViolation("only one statement is allowed")
    if not re.match(r"^(select|with)\b", body, re.IGNORECASE):
        raise ReadOnlyViolation("statements must start with SELECT or WITH")
    scrubbed = _FOR_OUTPUT.sub(" ", body)
    m = _FORBIDDEN_RE.search(scrubbed)
    if m:
        raise ReadOnlyViolation(f"'{m.group(1).upper()}' is not allowed in adapter queries")
