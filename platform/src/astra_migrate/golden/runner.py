"""Golden datasets (E22.F1.S1): synthetic estates with known correct outcomes.

A golden dataset ships inside a source adapter pack: build scripts, an optional delta script and the
expected answers. The runner:

1. builds the estate in a fresh database on a local engine, with an administrator login that only test
   environments have (ASTRA_GOLDEN_SQLSERVER_ADMIN);
2. creates a read-only login for it and proves the login cannot write;
3. runs the adapter's operations exactly as on a customer estate: connection check, metadata and
   coverage, traps, full extraction, delta extraction after the delta script, and the executable rules
   of the domain packs;
4. scores every measure against the expected answers (precision and recall where it applies);
5. drops the database, unless asked to keep it as a demonstration estate.
"""

from __future__ import annotations

import logging
import re
import secrets
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import yaml

from astra_migrate.adapters import source
from astra_migrate.adapters.contract import SourceAdapterContent, Trap
from astra_migrate.adapters.engines import ConnParams, EngineError, open_session
from astra_migrate.config import get_settings
from astra_migrate.logging import register_secret
from astra_migrate.ontology.model import DomainContent
from astra_migrate.packs.schema import Manifest
from astra_migrate.rules.checks import run_checks

log = logging.getLogger(__name__)
HIDDEN_RULE_RE = re.compile(r"\b(RAISERROR|THROW)\b", re.IGNORECASE)


class GoldenBlocked(RuntimeError):
    """The run cannot happen here (no engine administrator configured). The message says why."""


@dataclass(frozen=True)
class AdminTarget:
    host: str
    port: int
    user: str
    password: str


def admin_target() -> AdminTarget:
    raw = get_settings().golden_sqlserver_admin
    if not raw:
        raise GoldenBlocked("No SQL Server administrator is configured for golden datasets on this deployment "
                            "(ASTRA_GOLDEN_SQLSERVER_ADMIN). Golden runs happen in test environments only.")
    secret = raw.get_secret_value()
    cred, hostport = secret.rsplit("@", 1)
    user, password = cred.split(":", 1)
    host, port = hostport.rsplit(":", 1)
    register_secret(password)
    return AdminTarget(host, int(port), user, password)


def split_batches(sql: str) -> list[str]:
    return [b.strip() for b in re.split(r"^\s*GO\s*$", sql, flags=re.IGNORECASE | re.MULTILINE) if b.strip()]


@dataclass
class Measure:
    name: str
    passed: bool
    expected: Any
    actual: Any
    precision: float | None = None
    recall: float | None = None
    detail: str = ""


@dataclass
class Scorecard:
    dataset: str
    database: str
    measures: list[Measure] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(m.passed for m in self.measures)

    def as_dict(self) -> dict[str, Any]:
        return {"dataset": self.dataset, "database": self.database, "passed": self.passed,
                "measures": [m.__dict__ for m in self.measures]}


def _pr(expected: set[str], actual: set[str]) -> tuple[float, float]:
    tp = len(expected & actual)
    precision = tp / len(actual) if actual else (1.0 if not expected else 0.0)
    recall = tp / len(expected) if expected else 1.0
    return round(precision, 4), round(recall, 4)


def _set_measure(name: str, expected: list[str], actual: list[str]) -> Measure:
    e, a = {x.lower() for x in expected}, {x.lower() for x in actual}
    p, r = _pr(e, a)
    return Measure(name, e == a, sorted(expected), sorted(set(actual)), p, r,
                   "" if e == a else f"missing: {sorted(e - a)[:10]}; unexpected: {sorted(a - e)[:10]}")


class _Admin:
    def __init__(self, t: AdminTarget, database: str = "master") -> None:
        import pymssql

        self.conn = pymssql.connect(server=t.host, port=str(t.port), user=t.user, password=t.password,
                                    database=database, autocommit=True, login_timeout=30, tds_version="7.4")

    def run(self, sql: str) -> None:
        cur = self.conn.cursor()
        try:
            cur.execute(sql)
        finally:
            cur.close()

    def close(self) -> None:
        self.conn.close()


def run_dataset(adapter: Manifest, files: dict[str, bytes], dataset: str, domain: list[Manifest], *,
                keep: bool = False, progress: Callable[[int, str], None] | None = None) -> Scorecard:
    say = progress or (lambda _p, _m: None)
    content = SourceAdapterContent.model_validate(adapter.content)
    g = next((d for d in content.golden_datasets if d.name == dataset), None)
    if g is None:
        raise ValueError(f"{adapter.ref} has no golden dataset '{dataset}'")
    if g.engine != "sqlserver":
        raise GoldenBlocked(f"Golden datasets on {g.engine} need an engine this deployment does not host.")
    base = g.path.rstrip("/")
    desc = yaml.safe_load(files[f"{base}/dataset.yaml"])
    expected = yaml.safe_load(files[f"{base}/{desc['expected']}"])
    target = admin_target()
    dbname = f"golden_{re.sub(r'[^a-z0-9]', '_', dataset.lower())}_{uuid.uuid4().hex[:8]}"
    login = f"astra_ro_{uuid.uuid4().hex[:10]}"
    password = "Ro1!" + secrets.token_urlsafe(18)
    register_secret(password)
    card = Scorecard(f"{adapter.ref}:{dataset}", dbname)

    say(5, "Creating the database")
    admin = _Admin(target)
    try:
        admin.run(f"CREATE DATABASE [{dbname}]")
        admin.run(f"CREATE LOGIN [{login}] WITH PASSWORD = N'{password}', CHECK_POLICY = OFF, "
                  f"DEFAULT_DATABASE = [{dbname}]")
    finally:
        admin.close()
    db_admin = _Admin(target, dbname)
    try:
        for i, script in enumerate(desc["build"]):
            say(10 + 10 * i, f"Building the estate: {script}")
            for batch in split_batches(files[f"{base}/{script}"].decode("utf-8")):
                db_admin.run(batch)
        db_admin.run(f"CREATE USER [{login}] FOR LOGIN [{login}]")
        db_admin.run(f"ALTER ROLE db_datareader ADD MEMBER [{login}]")
        db_admin.run(f"GRANT VIEW DEFINITION TO [{login}]")

        params = ConnParams(target.host, target.port, dbname, login, password)
        sess = open_session("sqlserver", params)
        try:
            say(35, "Checking the read-only connection")
            chk = sess.check(next((e.min_version for e in content.engines if e.engine == "sqlserver"), None))
            card.measures.append(Measure("Connection is read-only and supported", chk.ok and chk.read_only,
                                         True, {"read_only": chk.read_only, "version": chk.engine_version},
                                         detail="; ".join(chk.problems)))
            card.measures.append(_write_refused(target, dbname, login, password))

            say(45, "Reading metadata")
            meta = source.read_metadata(sess, content)
            exp_counts = expected.get("metadata", {}).get("counts", {})
            got = meta.by_type()
            for t, n in sorted(exp_counts.items()):
                card.measures.append(Measure(f"Metadata: {t} count", got.get(t, 0) == n, n, got.get(t, 0)))
            card.measures.append(Measure("Coverage report is complete", meta.complete, True, meta.complete,
                                         detail="; ".join(f"{c.object_type}: {c.error or c.status}"
                                                          for c in meta.coverage if c.status == "failed")))
            no_owner = [o.qualified for o in meta.objects if not o.owner]
            card.measures.append(Measure("Every object records its owner", not no_owner, 0, len(no_owner),
                                         detail=", ".join(no_owner[:10])))
            if "dependencies" in expected.get("metadata", {}):
                deps = {f"{o.qualified}->{d}" for o in meta.objects for d in o.depends_on}
                card.measures.append(_set_measure("Metadata: dependencies found", expected["metadata"]["dependencies"],
                                                  sorted(deps)))

            say(55, "Evaluating known traps")
            findings, trap_errors = source.evaluate_traps(sess, [(t, "pack") for t in content.traps], meta)
            card.measures.append(_set_measure("Traps flagged", list(expected.get("traps", {}).keys()),
                                              [f.trap_id for f in findings]))
            for f in findings:
                exp_hits = expected.get("traps", {}).get(f.trap_id)
                if exp_hits:
                    card.measures.append(_set_measure(f"Trap {f.trap_id} hits", exp_hits, f.hits))
            if trap_errors:
                card.measures.append(Measure("Every trap could be evaluated", False, [], trap_errors))

            hidden = [o.qualified for o in meta.objects if o.type == "trigger" and o.definition
                      and HIDDEN_RULE_RE.search(o.definition)]
            card.measures.append(_set_measure("Hidden rules found (triggers that enforce conditions)",
                                              expected.get("hidden_rules", []), hidden))
            iface_types = {o.key for o in content.object_types if o.interface}
            interfaces = [f"{o.type}:{o.qualified}" for o in meta.objects if o.type in iface_types]
            code_scan = {t.id for t in content.traps if t.detect.kind == "object_exists"}
            interfaces += [f"trap:{f.trap_id}:{h}" for f in findings
                           if f.stream == "integrations" and f.trap_id in code_scan for h in f.hits]
            card.measures.append(_set_measure("Interfaces found", expected.get("interfaces", []), interfaces))

            say(65, "Extracting data in full")
            full_counts, keys = _extract_counts(sess, content)
            for ent, n in sorted(expected.get("extract", {}).get("full", {}).items()):
                card.measures.append(Measure(f"Full extract: {ent}", full_counts.get(ent) == n, n,
                                             full_counts.get(ent)))
            docs = [d for batch in (source.extract_documents(sess, content.documents) if content.documents else [])
                    for d in batch]
            broken = [d.key for d in docs if not (d.link_entity and d.link_key and d.link_key in keys.get(d.link_entity,
                                                                                                         set()))]
            exp_docs = expected.get("extract", {}).get("documents")
            if exp_docs is not None:
                card.measures.append(Measure("Documents extracted with content", len(docs) == exp_docs
                                             and all(d.content is not None for d in docs), exp_docs, len(docs)))
                exp_broken = [str(x) for x in expected["extract"].get("broken_links", [])]
                card.measures.append(_set_measure("Documents whose entity link does not resolve", exp_broken, broken))
            marks = {e.name: source.watermark(sess, e) for e in content.entities if e.delta_column}
            if desc.get("activity") and "discovery" in expected:
                say(68, "Running discovery")
                _score_discovery(card, sess, content, chk.model_dump(), files[f"{base}/{desc['activity']}"],
                                 desc, expected["discovery"])
            results: dict[str, Any] = {}
            if domain:
                say(70, "Running domain rules on the estate as built")
                rules = [(r.id, r.check) for m in domain for r in m.adds.rules if r.check is not None]
                results = {r.rule_id: r for r in run_checks(sess, content, rules)}
        finally:
            sess.close()

        if desc.get("delta"):
            say(75, "Applying changes and extracting deltas")
            for batch in split_batches(files[f"{base}/{desc['delta']}"].decode("utf-8")):
                db_admin.run(batch)
            sess = open_session("sqlserver", params)
            try:
                delta_counts: dict[str, int] = {}
                for e in content.entities:
                    if e.name in marks and marks[e.name] is not None:
                        delta_counts[e.name] = sum(len(b) for b in source.extract_entity(sess, e, since=marks[e.name]))
                for ent, n in sorted(expected.get("extract", {}).get("delta", {}).items()):
                    card.measures.append(Measure(f"Delta extract: {ent}", delta_counts.get(ent) == n, n,
                                                 delta_counts.get(ent)))
            finally:
                sess.close()

        if domain:
            _score_domain(card, domain, results, expected)
    finally:
        db_admin.close()
        if not keep:
            _drop(target, dbname, login)
    say(100, "Done")
    return card


def _score_discovery(card: Scorecard, sess: Any, content: SourceAdapterContent, check: dict[str, Any],
                     activity_file: bytes, desc: dict[str, Any], exp: dict[str, Any]) -> None:
    from datetime import datetime

    from astra_migrate.discovery import activity, pipeline

    events = activity.parse_file(activity_file, desc["activity"])
    as_of = datetime.fromisoformat(str(desc.get("as_of") or exp["as_of"]))
    d = pipeline.run(sess, content, check, events, as_of)
    m = card.measures
    m.append(Measure("Discovery: every phase completed", all(p.status == "done" for p in d.phases.values()),
                     "done", {k: p.status for k, p in d.phases.items()},
                     detail="; ".join(f"{k}: {p.detail}" for k, p in d.phases.items() if p.status != "done")))
    broken = {b.relation: b.broken_rows for t in d.profile.tables for b in t.broken}
    for rel, n in sorted(exp.get("profile", {}).get("broken_references", {}).items()):
        m.append(Measure(f"Profile: broken references {rel}", broken.get(rel) == n, n, broken.get(rel)))
    cols = {f"{t.table}.{c.column}".lower(): c for t in d.profile.tables for c in t.columns}
    for col, rate in sorted(exp.get("profile", {}).get("null_rates", {}).items()):
        got = cols.get(col.lower())
        actual = round(got.null_rate, 4) if got else None
        m.append(Measure(f"Profile: null rate {col}", actual == rate, rate, actual))
    for col, shp in sorted(exp.get("profile", {}).get("dominant_shapes", {}).items()):
        got = cols.get(col.lower())
        shape_found = got.patterns[0] if got and got.patterns else None
        m.append(Measure(f"Profile: dominant shape {col}", shape_found == shp, shp, shape_found))
    m.append(Measure("Profile: every table has a quality score", all(t.error is None for t in d.profile.tables),
                     len(d.profile.tables), sum(1 for t in d.profile.tables if t.error is None)))
    m.append(_set_measure("Usage: elements with no use flagged for retirement review", exp.get("unused", []),
                          d.usage.unused))
    m.append(Measure("Usage: evidence covers the 90-day window", d.usage.evidence_days >= 90, ">= 90",
                     d.usage.evidence_days))
    m.append(_set_measure("Interfaces found (activity, code and configuration)", exp.get("interfaces", []),
                          [i.key for i in d.interfaces]))
    m.append(_set_measure("Report tools recognised", exp.get("report_tools", []),
                          [i.key for i in d.interfaces if i.kind == "report_tool"]))
    if "rules" in exp:
        m.append(_set_measure("Code reader: rules found (object, kind)", [f"{o}|{k}" for o, k in exp["rules"]],
                              [f"{r.object}|{r.kind}" for r in d.rules]))
    for key, fields in sorted(exp.get("rule_fields", {}).items()):
        obj, kind = key.split("|")
        found = next((r for r in d.rules if r.object == obj and r.kind == kind), None)
        m.append(_set_measure(f"Code reader: fields of {key}", fields, found.fields if found else []))
    cfg = exp.get("configuration", {})
    if cfg:
        m.append(Measure("Configuration: items by kind", d.config.by_kind() == cfg.get("counts"), cfg.get("counts"),
                         d.config.by_kind()))
        m.append(_set_measure("Configuration: items only in some books",
                              [f"{k}|{n}" for k, n in cfg.get("only_in_some", [])],
                              [f"{x['kind']}|{x['name']}" for x in d.config_diff["only_in_some"]]))
        m.append(_set_measure("Configuration: items that differ between books",
                              [f"{k}|{n}" for k, n in cfg.get("different", [])],
                              [f"{x['kind']}|{x['name']}" for x in d.config_diff["different"]]))
    if "documents" in exp and d.documents is not None:
        key = lambda r: (r["type"], r["age"], r["link_entity"])  # noqa: E731
        m.append(Measure("Documents sized by type and age", sorted(exp["documents"], key=key)
                         == sorted(d.documents.rows, key=key), len(exp["documents"]), len(d.documents.rows)))
    statuses = {s["stream"]: s["status"] for s in d.streams}
    m.append(Measure("Coverage report: status per stream", statuses == exp.get("streams"), exp.get("streams"),
                     statuses, detail="; ".join(f"{g.id}: {g.message}" for g in d.gaps)))
    bound = sum(1 for n in d.graph.nodes.values() if n.kind == "table")
    m.append(Measure("Knowledge graph holds every table, column and rule", bound == len(d.dictionary.tables())
                     and any(n.kind == "rule" for n in d.graph.nodes.values()), len(d.dictionary.tables()), bound))


def _score_domain(card: Scorecard, domain: list[Manifest], results: dict[str, Any], expected: dict[str, Any]) -> None:
    for rule_id, exp_keys in sorted(expected.get("rules", {}).items()):
        r = results.get(rule_id)
        if r is None:
            card.measures.append(Measure(f"Rule {rule_id}", False, exp_keys, None,
                                         detail="no domain pack in this run defines the rule"))
        elif r.status != "ran":
            card.measures.append(Measure(f"Rule {rule_id}", False, exp_keys, None, detail=r.detail))
        else:
            card.measures.append(_set_measure(f"Rule {rule_id} violations", [str(k) for k in exp_keys],
                                              r.violations))
    concepts: set[str] = set()
    for m in domain:
        if "ontology" in m.content:
            concepts |= {c.id for c in DomainContent.model_validate(m.content).ontology.concepts}
    needed = expected.get("concepts", [])
    missing = sorted(set(needed) - concepts)
    card.measures.append(Measure("Ontology covers the golden mapping's concepts", not missing, len(needed),
                                 len(needed) - len(missing), detail=", ".join(missing)))


def _write_refused(t: AdminTarget, dbname: str, login: str, password: str) -> Measure:
    """Prove the read-only login cannot write, by trying (outside the adapter's guard)."""
    import pymssql

    conn = pymssql.connect(server=t.host, port=str(t.port), user=login, password=password, database=dbname,
                           autocommit=False, login_timeout=30, tds_version="7.4")
    cur = conn.cursor()
    try:
        cur.execute("CREATE TABLE dbo.__astra_write_probe (x int)")
        refused, detail = False, "the login created a table"
    except pymssql.Error as e:
        refused, detail = True, str(e.args[0][1] if e.args and isinstance(e.args[0], tuple) else e)[:200]
    finally:
        conn.rollback()
        conn.close()
    return Measure("A write attempt with the adapter's login is refused by the engine", refused, True, refused,
                   detail=detail if not refused else "")


def _extract_counts(sess: Any, content: SourceAdapterContent) -> tuple[dict[str, int], dict[str, set[str]]]:
    counts: dict[str, int] = {}
    keys: dict[str, set[str]] = {}
    for e in content.entities:
        ks: set[str] = set()
        for batch in source.extract_entity(sess, e):
            ks.update(k for k, _ in batch)
        counts[e.name], keys[e.name] = len(ks), ks
        if source.count_rows(sess, e) != len(ks):
            raise EngineError(f"{e.name}: extracted {len(ks)} rows but the table reports a different count")
    return counts, keys


def _drop(t: AdminTarget, dbname: str, login: str) -> None:
    try:
        a = _Admin(t)
        try:
            a.run(f"IF DB_ID(N'{dbname}') IS NOT NULL BEGIN ALTER DATABASE [{dbname}] SET SINGLE_USER WITH ROLLBACK "
                  f"IMMEDIATE; DROP DATABASE [{dbname}]; END")
            a.run(f"IF SUSER_ID(N'{login}') IS NOT NULL DROP LOGIN [{login}]")
        finally:
            a.close()
    except Exception:
        log.exception("could not drop golden database %s", dbname)


def traps_of(content: SourceAdapterContent) -> list[Trap]:
    return list(content.traps)
