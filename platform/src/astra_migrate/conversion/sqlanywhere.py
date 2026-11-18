"""SAP SQL Anywhere (Watcom-SQL) to Microsoft SQL Server conversion (E10.F1.S1).

Rule-based and explicit: every rewrite is named in the result, and constructs that have no safe automatic
equivalent are not guessed. They go to review with the reason. A converted object is only "converted" after it
compiles on SQL Server (see workbench.py).

Covered: data types, identity columns, defaults, date and string functions, Watcom procedure and function
headers and parameters, DECLARE, IF/ELSEIF/ELSE/END IF, MESSAGE, CALL, SELECT ... INTO variables, and row-level
AFTER triggers whose body is a condition that rejects the change.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

I = re.IGNORECASE  # noqa: E741


@dataclass
class Conversion:
    kind: str
    name: str
    source: str
    converted: str | None
    rules: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    review: list[str] = field(default_factory=list)

    @property
    def needs_review(self) -> bool:
        return bool(self.review)


# ------------------------------------------------------------------ constructs that go to review

REVIEW = [
    (re.compile(r"\bON\s+EXCEPTION\s+RESUME\b", I),
     "ON EXCEPTION RESUME has no SQL Server equivalent; errors must be handled with TRY...CATCH by a person."),
    (re.compile(r"\b(SIGNAL|RESIGNAL)\b", I),
     "SIGNAL/RESIGNAL error handling needs a THROW/TRY...CATCH design."),
    (re.compile(r"\bFOR\s+\w+\s+AS\s+\w+\s+(?:DYNAMIC\s+SCROLL\s+|SCROLL\s+|NO\s+SCROLL\s+)?CURSOR\b", I),
     "FOR ... CURSOR loops need a set-based rewrite or an explicit cursor."),
    (re.compile(r"\bDEFAULT\s+GLOBAL\s+AUTOINCREMENT\b", I),
     "GLOBAL AUTOINCREMENT partitions key ranges per database; choose a SQL Server key strategy."),
    (re.compile(r"\bDEFAULT\s+TIMESTAMP\b", I),
     "DEFAULT TIMESTAMP updates the column on every change; SQL Server needs a trigger for this."),
    (re.compile(r"\bIFNULL\s*\(", I),
     "IFNULL(a, b, c) returns b when a is null and c otherwise; rewrite as CASE after checking the argument count."),
    (re.compile(r"\bDATEFORMAT\s*\(", I),
     "DATEFORMAT pictures differ from FORMAT patterns; convert each picture by hand."),
    (re.compile(r"\bSTART\s+AT\b", I),
     "TOP ... START AT needs ORDER BY ... OFFSET ... FETCH with the right ordering."),
    (re.compile(r"\bBEGIN\s+ATOMIC\b", I),
     "BEGIN ATOMIC needs an explicit transaction design."),
    (re.compile(r"\bWAITFOR\b|\bxp_cmdshell\b|\bxp_\w+\b", I),
     "Calls to system procedures or waits need a design decision on the hosted target."),
]

# ------------------------------------------------------------------ simple rewrites (order matters)

TYPES = [
    (r"\blong\s+nvarchar\b", "nvarchar(max)", "long nvarchar"), (r"\blong\s+varchar\b", "varchar(max)", "long varchar"),
    (r"\blong\s+binary\b", "varbinary(max)", "long binary"),
    (r"\bunsigned\s+bigint\b", "decimal(20,0)", "unsigned bigint"),
    (r"\bunsigned\s+int(?:eger)?\b", "bigint", "unsigned int"),
    (r"\bunsigned\s+smallint\b", "int", "unsigned smallint"),
    (r"\bunsigned\s+tinyint\b", "smallint", "unsigned tinyint"), (r"\bdouble\b", "float", "double"),
    (r"\buniqueidentifierstr\b", "char(36)", "uniqueidentifierstr"),
    (r"(?<!current\s)(?<!default\s)\btimestamp\b(?!\s*\()", "datetime2", "timestamp"),
]
DEFAULTS = [
    (r"\bDEFAULT\s+AUTOINCREMENT\b", "IDENTITY(1,1)", "identity column"),
    (r"\bDEFAULT\s+CURRENT\s+TIMESTAMP\b", "DEFAULT SYSDATETIME()", "default current timestamp"),
    (r"\bDEFAULT\s+CURRENT\s+DATE\b", "DEFAULT CAST(GETDATE() AS date)", "default current date"),
]
FUNCTIONS = [
    (r"\bTODAY\s*\(\s*\*?\s*\)", "CAST(GETDATE() AS date)", "TODAY()"),
    (r"\bNOW\s*\(\s*\*?\s*\)", "GETDATE()", "NOW()"),
    (r"\bCURRENT\s+TIMESTAMP\b", "SYSDATETIME()", "CURRENT TIMESTAMP"),
    (r"\bCURRENT\s+DATE\b", "CAST(GETDATE() AS date)", "CURRENT DATE"),
    (r"\bNUMBER\s*\(\s*\*\s*\)", "ROW_NUMBER() OVER (ORDER BY (SELECT NULL))", "NUMBER(*)"),
    (r"\bLENGTH\s*\(", "LEN(", "LENGTH"), (r"\bCHAR_LENGTH\s*\(", "LEN(", "CHAR_LENGTH"),
    (r"\bSUBSTR\s*\(", "SUBSTRING(", "SUBSTR"), (r"\bUCASE\s*\(", "UPPER(", "UCASE"),
    (r"\bLCASE\s*\(", "LOWER(", "LCASE"), (r"\bSTRING\s*\(", "CONCAT(", "STRING()"),
]
COMMA = "','"
DATE_DIFFS = {"YEARS": "year", "MONTHS": "month", "DAYS": "day", "HOURS": "hour", "MINUTES": "minute",
              "SECONDS": "second"}


def _sub(pattern: str, repl: str, text: str) -> tuple[str, int]:
    return re.subn(pattern, repl, text, flags=I)


def _split_args(s: str) -> list[str]:
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


def _call_args(text: str, start: int) -> tuple[list[str], int] | None:
    """Arguments of the call whose '(' is at text[start]; returns (args, index after ')')."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return _split_args(text[start + 1:i]), i + 1
    return None


def _rewrite_calls(text: str, fn: str, build: object, rule: str, c: Conversion) -> str:
    pat = re.compile(rf"\b{fn}\s*\(", I)
    out, pos = "", 0
    for m in pat.finditer(text):
        if m.start() < pos:
            continue
        got = _call_args(text, m.end() - 1)
        if got is None:
            continue
        args, end = got
        replacement = build(args)  # type: ignore[operator]
        if replacement is None:
            continue
        out += text[pos:m.start()] + replacement
        pos = end
        if rule not in c.rules:
            c.rules.append(rule)
    return out + text[pos:]


def _expressions(text: str, c: Conversion) -> str:
    for pat, repl, label in TYPES:
        text, n = _sub(pat, repl, text)
        if n:
            c.rules.append(f"type: {label} -> {repl}")
    for pat, repl, rule in DEFAULTS:
        text, n = _sub(pat, repl, text)
        if n:
            c.rules.append(rule)
    for pat, repl, rule in FUNCTIONS:
        text, n = _sub(pat, repl, text)
        if n:
            c.rules.append(f"function: {rule}")
    for fn, unit in DATE_DIFFS.items():
        text = _rewrite_calls(text, fn, lambda a, u=unit: f"DATEDIFF({u}, {a[0]}, {a[1]})" if len(a) == 2 else None,
                              f"function: {fn}()", c)
    text = _rewrite_calls(text, "LIST", lambda a: f"STRING_AGG({a[0]}, {a[1] if len(a) > 1 else COMMA})"
                          if len(a) <= 2 else None, "function: LIST() -> STRING_AGG", c)
    text = _rewrite_calls(text, "LOCATE", lambda a: f"CHARINDEX({a[1]}, {a[0]})" if len(a) == 2 else None,
                          "function: LOCATE() -> CHARINDEX", c)
    if "||" in text:
        text = text.replace("||", "+")
        c.rules.append("operator: || -> +")
        c.warnings.append("String concatenation with + returns NULL when any part is NULL and fails on numbers; "
                          "check nullable and numeric parts (CONCAT handles both).")
    return text


# ------------------------------------------------------------------ procedural code

def _block_keywords(body: str, c: Conversion) -> str:
    """IF/THEN/ELSEIF/ELSE/END IF to T-SQL blocks, skipping CASE expressions."""
    tokens = re.split(r"(\bEND\s+IF\b|\bELSEIF\b|\bTHEN\b|\bELSE\b|\bCASE\b|\bEND\b|\bIF\b)", body, flags=I)
    out: list[str] = []
    stack: list[str] = []  # "if" or "case"
    for tok in tokens:
        up = re.sub(r"\s+", " ", tok.upper())
        if up == "CASE":
            stack.append("case")
            out.append(tok)
        elif up == "IF":
            stack.append("if")
            out.append("IF")
        elif up == "THEN":
            out.append(tok if stack and stack[-1] == "case" else "BEGIN")
        elif up == "ELSEIF":
            out.append("END ELSE IF")
        elif up == "ELSE":
            out.append(tok if stack and stack[-1] == "case" else "END ELSE BEGIN")
        elif up == "END IF":
            if stack and stack[-1] == "if":
                stack.pop()
            out.append("END")
        elif up == "END":
            if stack and stack[-1] == "case":
                stack.pop()
            out.append(tok)
        else:
            out.append(tok)
    converted = "".join(out)
    if converted != body:
        c.rules.append("control flow: IF ... THEN ... END IF -> IF BEGIN ... END")
    return converted


def _variables(body: str, names: list[str]) -> str:
    for n in sorted(set(names), key=len, reverse=True):
        body = re.sub(rf"(?<![@.\w]){re.escape(n)}\b", f"@{n}", body)
    return body


def _procedural(body: str, c: Conversion, params: list[str]) -> str:
    declared = [m.group(1) for m in re.finditer(r"\bDECLARE\s+(\w+)\s+", body, I)
                if m.group(1).upper() not in ("LOCAL", "CURSOR", "EXCEPTION")]
    if declared:
        c.rules.append("variables: DECLARE x -> DECLARE @x")
    body = _variables(body, params + declared)
    body, n = _sub(r"\bMESSAGE\s+(.+?)\s+TO\s+CLIENT\s*;", r"PRINT \1;", body)
    body, n2 = _sub(r"\bMESSAGE\s+(.+?);", r"PRINT \1;", body)
    if n or n2:
        c.rules.append("MESSAGE -> PRINT")
    def call(m: re.Match[str]) -> str:
        args = m.group(2).strip()
        return f"EXEC {m.group(1)}{' ' + args if args else ''};"
    body, n = re.subn(r"\bCALL\s+([\w.]+)\s*\((.*?)\)\s*;", call, body, flags=I)
    if n:
        c.rules.append("CALL p(...) -> EXEC p ...")
    # SELECT a, b INTO @x, @y FROM ...  ->  SELECT @x = a, @y = b FROM ...
    def into(m: re.Match[str]) -> str:
        cols, targets = _split_args(m.group(1)), [t.strip() for t in m.group(2).split(",")]
        if len(cols) != len(targets) or not all(t.startswith("@") for t in targets):
            c.review.append("SELECT ... INTO with a different number of columns and variables needs review.")
            return m.group(0)
        return "SELECT " + ", ".join(f"{t} = {col}" for t, col in zip(targets, cols, strict=True)) + " FROM"
    body, n = re.subn(r"\bSELECT\s+(.+?)\s+INTO\s+(@[\w@,\s]+?)\s+FROM\b", into, body, flags=I | re.DOTALL)
    if n:
        c.rules.append("SELECT ... INTO variables -> SELECT @v = ...")
    return _block_keywords(body, c)


def _params(raw: str) -> tuple[list[str], list[str]]:
    """Watcom parameters -> (T-SQL declarations, names)."""
    decls, names = [], []
    for p in _split_args(raw):
        m = re.match(r"(?:(IN|OUT|INOUT)\s+)?(\w+)\s+(.+?)(?:\s+DEFAULT\s+(.+))?$", p.strip(), I)
        if not m:
            continue
        mode, name, typ, default = m.group(1), m.group(2), m.group(3), m.group(4)
        names.append(name)
        d = f"@{name} {typ}"
        if default:
            d += f" = {default}"
        if mode and mode.upper() in ("OUT", "INOUT"):
            d += " OUTPUT"
        decls.append(d)
    return decls, names


def _strip_end(body: str) -> str:
    return "\n" + re.sub(r";\s*$", "", body.strip("\r\n").rstrip()) + ";"


def convert(kind: str, name: str, sql: str) -> Conversion:
    c = Conversion(kind, name, sql, None)
    for pat, reason in REVIEW:
        if pat.search(sql) and reason not in c.review:
            c.review.append(reason)
    text = _expressions(sql, c)
    k = kind.lower()
    if k in ("procedure", "function"):
        m = re.match(r"\s*CREATE\s+(?:OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION)\s+([\w.\"\[\]]+)\s*\((.*?)\)\s*"
                     r"(RETURNS\s+[\w(),\s]+?)?\s*(?:RESULT\s*\(.*?\)\s*)?BEGIN\b(.*)\bEND\s*;?\s*$",
                     text, I | re.DOTALL)
        if not m:
            if re.match(r"\s*CREATE\s+(PROCEDURE|FUNCTION)\s+[\w.\[\]]+\s+@", text, I) or "AS BEGIN" in text.upper():
                c.converted = text  # already Transact-SQL syntax (SQL Anywhere accepts both)
                c.rules.append("already Transact-SQL syntax")
                return c
            c.review.append("The procedure header could not be parsed as Watcom-SQL.")
            return c
        what, pname, rawparams, returns, body = m.groups()
        decls, names = _params(rawparams)
        c.rules.append(f"{what.lower()} header: Watcom parameters -> @parameters")
        body = _procedural(body, c, names)
        if what.upper() == "PROCEDURE":
            head = f"CREATE PROCEDURE {pname}" + (" " + ", ".join(decls) if decls else "")
            c.converted = f"{head}\nAS\nBEGIN\n  SET NOCOUNT ON;{_strip_end(body)}\nEND"
        else:
            if not returns:
                c.review.append("A function without RETURNS cannot be converted.")
                return c
            c.converted = (f"CREATE FUNCTION {pname} ({', '.join(decls)})\n{returns.strip()}\nAS\nBEGIN"
                           f"{_strip_end(body)}\nEND")
        return c
    if k == "trigger":
        return _trigger(text, c)
    if k in ("view", "table"):
        c.converted = text.strip().rstrip(";")
        return c
    c.review.append(f"Objects of type {kind} are not converted automatically.")
    return c


def _trigger(text: str, c: Conversion) -> Conversion:
    m = re.match(r"\s*CREATE\s+TRIGGER\s+([\w.]+)\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)(?:\s+OF\s+[\w,\s]+?)?"
                 r"\s+(?:ORDER\s+\d+\s+)?ON\s+([\w.]+)\s+REFERENCING\s+(.*?)\s+FOR\s+EACH\s+(ROW|STATEMENT)\s*"
                 r"BEGIN\b(.*)\bEND\s*;?\s*$", text, I | re.DOTALL)
    if not m:
        c.review.append("The trigger header could not be parsed as Watcom-SQL.")
        return c
    tname, timing, event, table, refs, level, body = m.groups()
    if timing.upper() == "BEFORE":
        c.review.append("BEFORE triggers that change the row need an INSTEAD OF trigger or a default; "
                        "SQL Server has no BEFORE triggers.")
        return c
    alias_new = re.search(r"\bNEW\s+(?:ROW\s+)?AS\s+(\w+)", refs, I)
    alias_old = re.search(r"\bOLD\s+(?:ROW\s+)?AS\s+(\w+)", refs, I)
    if level.upper() == "STATEMENT":
        c.review.append("Statement-level triggers with transition tables need a check of the table names.")
        return c
    # A row trigger whose body is IF <condition on the row> THEN <reject> END IF becomes a set-based check.
    bm = re.match(r"\s*IF\s+(.+?)\s+THEN\s+(?:RAISERROR\s+(\d+)\s+'((?:[^']|'')*)'|MESSAGE\s+'((?:[^']|'')*)'"
                  r"[^;]*;\s*ROLLBACK)[^;]*;?\s*END\s+IF\s*;?\s*$", body, I | re.DOTALL)
    if not bm:
        c.review.append("Row-level trigger logic other than a single rejecting condition needs a set-based "
                        "rewrite by a person.")
        return c
    cond, _num, msg1, msg2 = bm.groups()
    msg = (msg1 or msg2 or "").replace("'", "''").replace("''''", "''")
    src = "inserted" if event.upper() != "DELETE" else "deleted"
    found = alias_new or alias_old
    alias = found.group(1) if found else "r"
    c.rules.append("row trigger with a rejecting condition -> set-based AFTER trigger over " + src)
    c.converted = (f"CREATE TRIGGER {tname} ON {table} AFTER {event.upper()} AS\nBEGIN\n"
                   f"  IF EXISTS (SELECT 1 FROM {src} {alias} WHERE {cond.strip()})\n  BEGIN\n"
                   f"    RAISERROR('{msg}', 16, 1);\n    ROLLBACK TRANSACTION;\n  END\nEND")
    return c
