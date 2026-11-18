"""Generated code with generated tests (E12.F4.S1, E12.F2.S3, E12.F3.S3).

Three kinds of code are generated from people's decisions and tested on the SQL Server workbench, each test run in
a transaction that is rolled back:

- Transformation code: one procedure per (source table, target table) from approved mappings. It reads a staged
  copy of the source (schema `src`) and writes target-shaped rows (schema `tgt`) for loading. Tests seed real sample
  rows from the latest extract (when there is one) plus edge rows, run the procedure under the target's NOT NULL
  rules, and check that every row arrives and every mapped value is preserved.
- Customer code rebuilt to the target's naming rules: user-defined tables (tests: the DDL compiles and the table has
  a primary key) and converted procedures, functions and triggers (tests: compiles, plus every recorded test case,
  with at least one case required).
- Report procedures on the report access mechanism: the view's query with source tables and columns renamed to their
  mapped targets (tests: compiles and runs).

Artifacts are versioned by digest: the same code and tests reuse the version, a change makes a new one.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

from astra_migrate.conversion.workbench import IDENT, Table, Workbench, q, sqlserver_type
from astra_migrate.design.mapping import family, length_of

STAGE_SRC, STAGE_TGT, XF_SCHEMA = "src", "tgt", "astra_xf"


def code_digest(code: str, tests: list[dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps({"code": code, "tests": tests}, sort_keys=True).encode()).hexdigest()


def stage_name(qualified: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", qualified.replace(".", "__"))


@dataclass
class Generated:
    kind: str  # transformation | code_object
    name: str
    code: str
    tests: list[dict[str, Any]]
    inputs: dict[str, Any]
    tables: list[Table]
    problems: list[str] = field(default_factory=list)

    @property
    def digest(self) -> str:
        return code_digest(self.code, self.tests)


# ------------------------------------------------------------------ transformation code (E12.F4.S1)

def stage_type(t: str, max_length: int | None) -> str:
    """The staged source column's type. The dictionary reports string and binary lengths in bytes (-1 = max) and
    no decimal precision, so decimals are staged wide enough not to round."""
    base = re.sub(r"\(.*\)", "", (t or "").lower()).strip()
    if "(" in (t or ""):
        return sqlserver_type(t)
    if base in ("varchar", "nvarchar", "char", "nchar", "varbinary", "binary") and max_length:
        size = "max" if max_length < 0 else str(max(1, max_length // 2 if base.startswith("n") else max_length))
        return sqlserver_type(f"{base}({size})")
    if base in ("decimal", "numeric"):
        return "decimal(38,10)"
    return sqlserver_type(t)


def _expr(m: dict[str, Any]) -> str:
    """Same-family columns are not cast, so SQL Server raises truncation and overflow errors on insert instead of
    silently cutting values; other families are converted explicitly."""
    col = f"s.{q(m['source']['column'])}"
    st, tt = str(m["source"].get("type") or ""), str(m["target"].get("type") or "")
    if family(st) == family(tt) and family(st) != "other":
        return col
    return f"CAST({col} AS {sqlserver_type(tt)})"


def _value_check(m: dict[str, Any], src_stage: str, tgt_stage: str) -> str:
    """Every non-null source value arrives in the target column, compared in the right domain: numbers as numbers
    (catches rounding), dates as datetime2 (catches lost time), everything else as text."""
    sc, tc = q(m["source"]["column"]), q(m["target"]["column"])
    fs, ft = family(str(m["source"].get("type") or "")), family(str(m["target"].get("type") or ""))
    if fs == ft == "numeric":
        a, b = f"CAST(s.{sc} AS float)", f"CAST({tc} AS float)"
    elif fs == ft == "date":
        a, b = f"CAST(s.{sc} AS datetime2)", f"CAST({tc} AS datetime2)"
    elif fs == ft:
        a, b = f"CAST(s.{sc} AS nvarchar(4000))", f"CAST({tc} AS nvarchar(4000))"
    else:
        a, b = f"CAST({_expr(m)} AS nvarchar(4000))", f"CAST({tc} AS nvarchar(4000))"
    return (f"SELECT COUNT(*) FROM (SELECT {a} AS v FROM {src_stage} AS s WHERE s.{sc} IS NOT NULL "
            f"EXCEPT SELECT {b} FROM {tgt_stage} WHERE {tc} IS NOT NULL) x")


def _sample(t: str, max_length: int | None, edge: bool) -> Any:
    """A typical or edge value that fits the staged source column (lengths in characters)."""
    fam, n = family(t), length_of(stage_type(t, max_length))
    if fam == "string":
        size = min(n or 20, 4000) if n and n > 0 else 20
        return ("Z" * size) if edge else "Sample"[:size]
    if fam == "numeric":
        return 0 if edge else 1
    if fam == "date":
        return "1900-01-01" if edge else "2026-01-01"
    if fam == "bool":
        return 0 if edge else 1
    if fam == "guid":
        return "00000000-0000-0000-0000-000000000000" if edge else "11111111-1111-1111-1111-111111111111"
    return None


def transformation(source_table: str, target_table: str, maps: list[dict[str, Any]],
                   source_columns: list[dict[str, Any]], target_columns: list[dict[str, Any]],
                   samples: list[dict[str, Any]]) -> Generated:
    proc = f"xf_{stage_name(target_table)}_from_{stage_name(source_table)}"[:128]
    src_stage = f"{q(STAGE_SRC)}.{q(stage_name(source_table))}"
    tgt_stage = f"{q(STAGE_TGT)}.{q(stage_name(target_table))}"
    maps = sorted(maps, key=lambda m: m["source"].get("ordinal") or 0)
    cols = ", ".join(q(m["target"]["column"]) for m in maps)
    exprs = ",\n         ".join(_expr(m) for m in maps)
    code = (f"CREATE PROCEDURE {q(XF_SCHEMA)}.{q(proc)}\nAS\nBEGIN\n    SET NOCOUNT ON;\n"
            f"    -- Generated from {len(maps)} approved mapping(s): {source_table} -> {target_table}\n"
            f"    INSERT INTO {tgt_stage} ({cols})\n    SELECT {exprs}\n    FROM {src_stage} AS s;\nEND")
    src_t = Table(STAGE_SRC, stage_name(source_table),
                  [(c["name"], stage_type(str(c["type"]), c.get("max_length"))) for c in source_columns],
                  frozenset(c["name"] for c in source_columns if not c.get("nullable", True)))
    tgt_t = Table(STAGE_TGT, stage_name(target_table),
                  [(str(c["name"]), sqlserver_type(str(c.get("type", "")))) for c in target_columns],
                  frozenset(str(c["name"]) for c in target_columns if c.get("nullable") is False))
    # seed rows: real sample rows first, then a typical and an edge row built from the source types
    names = {c["name"].lower(): c["name"] for c in source_columns}
    rows: list[dict[str, Any]] = []
    for r in samples[:50]:
        row = {names[k.lower()]: v for k, v in r.items() if k.lower() in names}
        if row:
            rows.append(row)
    for edge in (False, True):
        rows.append({c["name"]: (None if edge and c.get("nullable", True) else
                                 _sample(str(c["type"]), c.get("max_length"), edge)) for c in source_columns})
    tests: list[dict[str, Any]] = [
        {"name": "compiles", "kind": "compile"},
        {"name": "every source row arrives", "kind": "rows",
         "check": f"SELECT (SELECT COUNT(*) FROM {src_stage}) - (SELECT COUNT(*) FROM {tgt_stage})", "expect": 0},
    ]
    for m in maps:
        tests.append({"name": f"values preserved: {m['source']['column']} -> {m['target']['column']}",
                      "kind": "values", "check": _value_check(m, src_stage, tgt_stage), "expect": 0})
    mapped = {str(m["target"]["column"]).lower() for m in maps}
    problems = [f"required target column {c['name']} has no mapping"
                for c in target_columns if c.get("nullable") is False and str(c["name"]).lower() not in mapped]
    inputs = {"source_table": source_table, "target_table": target_table,
              "mappings": [{"source": m["source"]["column"], "target": m["target"]["column"],
                            "decided_by": (m.get("decision") or {}).get("by")} for m in maps],
              "seed_rows": rows, "real_sample_rows": min(len(samples), 50)}
    return Generated("transformation", f"{target_table} <- {source_table}", code, tests, inputs, [src_t, tgt_t],
                     problems)


def run_transformation(wb: Workbench, g: Generated) -> list[dict[str, Any]]:
    src_t = g.tables[0]
    steps: list[tuple[str, tuple[Any, ...] | None]] = [
        (f"IF SCHEMA_ID(N'{XF_SCHEMA}') IS NULL EXEC('CREATE SCHEMA {q(XF_SCHEMA)}')", None), (g.code, None)]
    for row in g.inputs["seed_rows"]:
        cols = [c for c in row if IDENT.fullmatch(c)]
        steps.append((f"INSERT INTO {q(src_t.schema)}.{q(src_t.name)} ({', '.join(q(c) for c in cols)}) "
                      f"VALUES ({', '.join(['%s'] * len(cols))})", tuple(row[c] for c in cols)))
    proc = re.search(r"CREATE PROCEDURE (\S+\.\S+)", g.code)
    assert proc is not None
    steps.append((f"EXEC {proc.group(1)}", None))
    checks = [(t["name"], t["check"]) for t in g.tests if t["kind"] in ("rows", "values")]
    err, values = wb.scenario(g.tables, steps, checks)
    results = [{"name": "compiles", "passed": True, "detail": None}]
    if err:
        results = [{"name": t["name"], "passed": False, "detail": err} for t in g.tests]
    else:
        got = dict(values)
        for t in g.tests:
            if t["kind"] == "compile":
                continue
            v = got.get(t["name"])
            results.append({"name": t["name"], "passed": v == t["expect"],
                            "detail": None if v == t["expect"] else f"{v} value(s) or row(s) differ"})
    for p in g.problems:
        results.append({"name": "required target columns mapped", "passed": False, "detail": p})
    return results


# ------------------------------------------------------------------ customer code (E12.F2.S3)

def rename(sql: str, renames: dict[str, str]) -> str:
    """Rewrite references to renamed objects: schema.name (with or without brackets), and bare names of four or
    more characters that are unique among the renamed objects."""
    bare: dict[str, list[str]] = {}
    for old in renames:
        bare.setdefault(old.split(".", 1)[-1].lower(), []).append(old)
    out = sql
    for old, new in sorted(renames.items(), key=lambda kv: -len(kv[0])):
        schema, _, name = old.partition(".")
        ns, _, nn = new.partition(".")
        out = re.sub(rf"\[?{re.escape(schema)}\]?\s*\.\s*\[?{re.escape(name)}\]?(?![A-Za-z0-9_\]])",
                     f"{q(ns)}.{q(nn)}", out, flags=re.IGNORECASE)
    for name, olds in bare.items():
        if len(olds) == 1 and len(name) >= 4:
            ns, _, nn = renames[olds[0]].partition(".")
            out = re.sub(rf"(?<![\.\w\[@#]){re.escape(name)}(?![\w\]])", f"{q(ns)}.{q(nn)}", out, flags=re.IGNORECASE)
    return out


def udt(qualified_new: str, columns: list[dict[str, Any]], key: list[str]) -> Generated:
    schema, _, name = qualified_new.partition(".")
    cols = ",\n    ".join(f"{q(c['name'])} {sqlserver_type(str(c['type']))} "
                          f"{'NULL' if c.get('nullable', True) else 'NOT NULL'}" for c in columns)
    pk = f",\n    CONSTRAINT {q('PK_' + name)[:130]} PRIMARY KEY ({', '.join(q(k) for k in key)})" if key else ""
    code = f"CREATE TABLE {q(schema)}.{q(name)} (\n    {cols}{pk}\n)"
    tests: list[dict[str, Any]] = [
        {"name": "compiles", "kind": "compile"},
        {"name": "has a primary key", "kind": "check",
              "check": f"SELECT COUNT(*) FROM sys.key_constraints WHERE type = 'PK' AND parent_object_id = "
                       f"OBJECT_ID(N'{schema}.{name}')", "expect": 1}]
    return Generated("code_object", qualified_new, code, tests, {"columns": columns, "key": key}, [],
                     [] if key else ["the source table has no primary key, so rows cannot be matched in deltas"])


def converted_object(kind: str, qualified_new: str, sql: str, cases: list[dict[str, Any]], tables: list[Table],
                     renames: dict[str, str]) -> Generated:
    code = rename(sql, renames)
    tests: list[dict[str, Any]] = [{"name": "compiles", "kind": "compile"}]
    for c in cases:
        setup = {renames.get(t, renames.get(t.lower(), t)): rows for t, rows in (c.get("setup") or {}).items()}
        tests.append({"name": str(c.get("name")), "kind": "case", "object_kind": kind,
                      "case": {**c, "setup": setup}})
    problems = [] if cases else ["no recorded test case: record at least one before the code can be approved"]
    return Generated("code_object", qualified_new, code, tests, {"kind": kind, "cases": len(cases)}, tables, problems)


def report_procedure(qualified_new: str, view_sql: str, table_map: dict[str, str],
                     column_map: dict[str, dict[str, str]], tables: list[Table]) -> Generated:
    body = re.sub(r"^\s*CREATE\s+(OR\s+ALTER\s+)?VIEW\s+\S+(\s*\([^)]*\))?\s+AS\s+", "", view_sql.strip(),
                  flags=re.IGNORECASE | re.DOTALL)
    body = rename(body, table_map)
    referenced = [t for t in table_map if re.search(re.escape(table_map[t].split(".", 1)[-1]), body, re.I)]
    cols: dict[str, set[str]] = {}
    for t in referenced:
        for s, tgt in (column_map.get(t.lower()) or {}).items():
            cols.setdefault(s.lower(), set()).add(tgt)
    for s, tg in cols.items():
        if len(tg) == 1 and s != next(iter(tg)).lower():
            body = re.sub(rf"(?<![\w@#]){re.escape(s)}(?!\w)", q(next(iter(tg))), body, flags=re.IGNORECASE)
    schema, _, name = qualified_new.partition(".")
    code = (f"CREATE PROCEDURE {q(schema)}.{q(name)}\nAS\nBEGIN\n    SET NOCOUNT ON;\n"
            f"    {body.strip().rstrip(';')};\nEND")
    tests: list[dict[str, Any]] = [{"name": "compiles", "kind": "compile"}, {"name": "runs", "kind": "exec"}]
    return Generated("code_object", qualified_new, code, tests, {"tables": table_map}, tables)


def run_code(wb: Workbench, g: Generated) -> list[dict[str, Any]]:
    qualified = g.name
    schema = qualified.split(".", 1)[0]
    pre: list[tuple[str, tuple[Any, ...] | None]] = [
        (f"IF SCHEMA_ID(N'{schema.replace(chr(39), '')}') IS NULL EXEC('CREATE SCHEMA {q(schema)}')", None)]
    results: list[dict[str, Any]] = []
    checks = [(t["name"], t["check"]) for t in g.tests if t["kind"] == "check"]
    steps = [*pre, (g.code, None)]
    if any(t["kind"] == "exec" for t in g.tests):
        steps.append((f"EXEC {q(schema)}.{q(qualified.split('.', 1)[1])}", None))
    err, values = wb.scenario(g.tables, steps, checks)
    if err:
        results.append({"name": "compiles", "passed": False, "detail": err})
    else:
        results.append({"name": "compiles", "passed": True, "detail": None})
        got = dict(values)
        for t in g.tests:
            if t["kind"] == "check":
                v = got.get(t["name"])
                results.append({"name": t["name"], "passed": v == t["expect"], "detail": None if v == t["expect"]
                                else f"got {v}, expected {t['expect']}"})
            elif t["kind"] == "exec":
                results.append({"name": t["name"], "passed": True, "detail": None})
    for t in g.tests:
        if t["kind"] == "case":
            o = wb.run_test(g.tables, g.code, t["object_kind"], qualified, t["case"])
            results.append({"name": f"recorded case: {t['name']}", "passed": o.passed,
                            "detail": "; ".join(o.differences) or None})
    for p in g.problems:
        results.append({"name": "requirements", "passed": False, "detail": p})
    return results
