"""Discovery pipeline: every phase against one read-only session, assembled into the knowledge graph and the
coverage report. Pure: storage is the caller's job, so golden datasets can score the same code."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from astra_migrate.adapters import source
from astra_migrate.adapters.contract import SourceAdapterContent
from astra_migrate.adapters.engines import EngineError, Session
from astra_migrate.discovery import codereader, configuration, dictionary, profiler, usage
from astra_migrate.discovery.activity import Event
from astra_migrate.discovery.dictionary import DataDictionary
from astra_migrate.discovery.graph import STREAM_TITLES, STREAMS, TYPE_STREAM, Graph, Node, object_id, table_id
from astra_migrate.discovery.usage import Interface, UsageResult

PLATFORM_PROGRAMS = ["astra-migrate-adapter"]


@dataclass
class Phase:
    status: str  # done | partial | failed | skipped
    detail: str = ""
    counts: dict[str, Any] = field(default_factory=dict)


@dataclass
class Gap:
    id: str
    stream: str
    severity: str  # blocking | warning
    message: str


@dataclass
class Discovery:
    phases: dict[str, Phase]
    metadata: source.MetadataResult
    dictionary: DataDictionary
    profile: profiler.Profile
    usage: UsageResult
    rules: list[codereader.Rule]
    interfaces: list[Interface]
    config: configuration.ConfigResult
    config_diff: dict[str, Any]
    documents: configuration.DocSizing | None
    graph: Graph
    streams: list[dict[str, Any]]
    gaps: list[Gap]

    @property
    def coverage_pct(self) -> int:
        return round(100 * sum(1 for s in self.streams if s["status"] == "covered") / len(STREAMS))


def run(sess: Session, content: SourceAdapterContent, check: dict[str, Any], events: list[Event], as_of: datetime,
        *, window_days: int = usage.DEFAULT_WINDOW_DAYS, bindings: dict[str, str] | None = None,
        baseline_tables: set[str] | None = None, say: Callable[[int, str], None] | None = None) -> Discovery:
    say = say or (lambda _p, _m: None)
    phases: dict[str, Phase] = {}

    say(5, "Reading the object inventory")
    meta = source.read_metadata(sess, content)
    phases["inventory"] = Phase("done" if meta.complete else "partial", "", meta.by_type())

    say(15, "Reading the data dictionary")
    dd = dictionary.harvest(sess, content)
    tables = dd.tables()
    phases["dictionary"] = Phase("failed" if not dd.columns else ("partial" if dd.problems else "done"),
                                 "; ".join(dd.problems),
                                 {"tables": len(tables), "columns": len(dd.columns), "relations": len(dd.relations),
                                  "code_lists": len(dd.code_lists)})

    say(30, "Profiling tables")
    exclude = content.dictionary.profile_exclude if content.dictionary else []
    prof = profiler.profile(sess, dd, exclude)
    errors = [t.table for t in prof.tables if t.error]
    phases["profile"] = Phase("failed" if not prof.tables else ("partial" if errors else "done"),
                              f"Could not profile: {', '.join(errors)}" if errors else "",
                              {"tables": len(prof.tables), "failed": len(errors), "estate_score": prof.estate_score,
                               "broken_references": sum(b.broken_rows for t in prof.tables for b in t.broken)})

    say(50, "Measuring usage")
    use = usage.measure(events, meta.objects, sorted(tables), as_of, window_days)
    phases["usage"] = Phase("skipped" if not events else ("partial" if use.note else "done"),
                            "No activity records were imported." if not events else (use.note or ""),
                            {"evidence_days": use.evidence_days, "unused": len(use.unused)})

    say(60, "Reading code")
    automation_types = {o.key for o in content.object_types if o.interface}
    rules = codereader.read_all(meta.objects, automation_types)
    phases["code"] = Phase("done", "", {"rules": len(rules)})

    say(70, "Finding interfaces")
    product_clients = content.activity.product_clients if content.activity else []
    interfaces = (usage.find_interfaces(events, product_clients, PLATFORM_PROGRAMS, max(1, use.evidence_days))
                  + usage.code_interfaces(meta.objects)
                  + usage.configured_interfaces(meta.objects, automation_types))
    phases["interfaces"] = Phase("done" if events else "partial",
                                 "" if events else "Only code and configuration were searched; no activity records.",
                                 {"interfaces": len(interfaces)})

    say(80, "Reading configuration")
    cfg = configuration.read_configuration(sess, content)
    diff = configuration.scope_differences(cfg.items)
    phases["configuration"] = Phase("skipped" if not content.configuration else ("partial" if cfg.problems else "done"),
                                    "; ".join(cfg.problems) or ("" if content.configuration else
                                                                "The adapter declares no configuration readers."),
                                    {"items": len(cfg.items), **cfg.by_kind()})

    docs = None
    if content.documents:
        say(88, "Sizing documents")
        try:
            docs = configuration.size_documents(sess, content.documents, as_of)
            phases["documents"] = Phase("done", "", {"documents": docs.total_count, "bytes": docs.total_bytes})
        except EngineError as e:
            phases["documents"] = Phase("failed", str(e))
    else:
        phases["documents"] = Phase("skipped", "The adapter declares no document store.")

    say(94, "Building the knowledge graph")
    graph = build_graph(meta, dd, prof, use, rules, interfaces, cfg, docs, check, bindings or {}, baseline_tables)
    streams, gaps = coverage(phases, meta, use, interfaces, rules, cfg, check, window_days)
    return Discovery(phases, meta, dd, prof, use, rules, interfaces, cfg, diff, docs, graph, streams, gaps)


def _usage_props(u: usage.ElementUsage | None, unused: set[str]) -> dict[str, Any]:
    if u is None:
        return {}
    return {"reads": u.reads, "writes": u.writes, "executions": u.executions,
            "last_used": u.last_used.isoformat() if u.last_used else None, "via": u.via,
            "unused": u.element in unused}


def build_graph(meta: source.MetadataResult, dd: dictionary.DataDictionary, prof: profiler.Profile,
                use: usage.UsageResult, rules: list[codereader.Rule], interfaces: list[usage.Interface],
                cfg: configuration.ConfigResult, docs: configuration.DocSizing | None, check: dict[str, Any],
                bindings: dict[str, str], baseline_tables: set[str] | None) -> Graph:
    g = Graph()
    unused = set(use.unused)
    scores = {t.table.lower(): t for t in prof.tables}
    base = {b.lower() for b in (baseline_tables or set())}
    g.add(Node("platform:source", "platform", "platform", f"{check.get('engine')} {check.get('engine_version')}",
               props={k: check.get(k) for k in ("engine", "engine_version", "edition", "database", "read_only")}))
    udts = {o.qualified.lower() for o in meta.objects if o.type == "user_defined_table"}
    for t, cols in dd.tables().items():
        tp = scores.get(t.lower())
        g.add(Node(table_id(t), "table", "customizations" if t.lower() in udts else "data", t,
                   _usage_props(use.elements.get(t.lower()), unused), bindings.get(t.lower()),
                   t.split(".", 1)[1] if t.split(".", 1)[1].lower() in base else None,
                   {"rows": tp.rows if tp else None, "quality_score": tp.score if tp else None,
                    "columns": len(cols), "target_match": "same name (candidate)" if t.split(".", 1)[1].lower() in base
                    else None}))
        for c in cols:
            cp = next((x for x in (tp.columns if tp else []) if x.column == c.name), None)
            g.add(Node(f"column:{t.lower()}.{c.name.lower()}", "column", "data", f"{t}.{c.name}",
                       props={"type": c.data_type, "nullable": c.nullable,
                              "null_rate": round(cp.null_rate, 4) if cp else None,
                              "distinct": cp.distinct if cp else None}))
            g.link(table_id(t), f"column:{t.lower()}.{c.name.lower()}", "has_column")
    for r in dd.relations:
        g.link(table_id(r.from_table), table_id(r.to_table), "references",
               column=r.from_column, enforced=r.enforced)
    for cl in dd.code_lists:
        g.add(Node(f"code_list:{cl.name}", "code_list", "data", cl.name, props={"values": len(cl.values)}))
        g.link(f"code_list:{cl.name}", table_id(cl.table), "stored_in")
    for o in meta.objects:
        if o.type in ("table", "user_defined_table"):
            continue
        stream = TYPE_STREAM.get(o.type, "configuration")
        nid = object_id(o.type, o.qualified)
        g.add(Node(nid, o.type, stream, o.qualified, _usage_props(use.elements.get(o.qualified.lower()), unused),
                   props={"owner": o.owner, "modified_at": o.modified_at, "has_code": bool(o.definition)}))
    for o in meta.objects:
        for d in o.depends_on:
            src = object_id(o.type, o.qualified)
            dst = g.find(d)
            if dst:
                g.link(src, dst, "depends_on")
    for rule in rules:
        g.add(Node(f"rule:{rule.id}", "rule", "customizations", rule.statement,
                   props={"kind": rule.kind, "confidence": rule.confidence, "object": rule.object}))
        g.link(f"rule:{rule.id}", object_id(rule.object_type, rule.object), "defined_in")
        for f in rule.reads:
            g.link(f"rule:{rule.id}", f"column:{f.lower()}", "reads")
        for f in rule.sets:
            g.link(f"rule:{rule.id}", f"column:{f.lower()}", "sets")
    for i in interfaces:
        stream = "reports" if i.kind == "report_tool" else "integrations"
        g.add(Node(f"interface:{i.key}", "interface", stream, i.name,
                   {"events": i.events, "per_day": i.per_day,
                    "last_used": i.last_seen.isoformat() if i.last_seen else None},
                   props={"kind": i.kind, "source": i.source, "hosts": i.hosts, "logins": i.logins}))
        for kind, objs in (("reads", i.reads), ("writes", i.writes), ("executes", i.executes)):
            for name in objs:
                target = g.find(name)
                if target:
                    g.link(f"interface:{i.key}", target, kind)
        for ev in i.evidence:
            if ":" in ev:
                g.link(f"interface:{i.key}", object_id(*ev.split(":", 1)), "found_in")
                continue
            found = next((k for k in g.nodes if k.split(":", 1)[-1] == ev.lower()), None)
            if found:
                g.link(f"interface:{i.key}", found, "found_in")
    for item in cfg.items:
        nid = f"config:{item.kind}:{item.key.lower()}"
        g.add(Node(nid, "configuration", "configuration", item.name, props={"kind": item.kind, "scope": item.scope,
                                                                             "digest": item.digest}))
    for item in cfg.items:
        for dep in item.depends_on:
            g.link(f"config:{item.kind}:{item.key.lower()}", f"config:{dep.lower()}", "depends_on")
    if docs:
        g.add(Node("documents:store", "document_store", "data", "Embedded documents",
                   props={"documents": docs.total_count, "bytes": docs.total_bytes}))
    return g


def coverage(phases: dict[str, Phase], meta: source.MetadataResult, use: usage.UsageResult,
             interfaces: list[usage.Interface], rules: list[codereader.Rule], cfg: configuration.ConfigResult,
             check: dict[str, Any], window_days: int
             ) -> tuple[list[dict[str, Any]], list[Gap]]:
    gaps: list[Gap] = []

    def gap(stream: str, severity: str, key: str, message: str) -> None:
        gaps.append(Gap(f"{stream}:{key}", stream, severity, message))

    by_type = meta.by_type()
    if phases["dictionary"].status == "failed":
        gap("data", "blocking", "dictionary", "The data dictionary could not be read.")
    if phases["profile"].status != "done":
        failed_tables = phases["profile"].counts.get("failed", 0)
        gap("data", "blocking", "profile", f"{failed_tables} table(s) could not be profiled; see the profile."
            if failed_tables else "Profiling did not complete.")
    if phases["documents"].status == "failed":
        gap("data", "blocking", "documents", "Documents could not be sized: " + phases["documents"].detail)
    if phases["configuration"].status == "skipped":
        gap("configuration", "blocking", "readers", "The adapter declares no configuration readers.")
    elif phases["configuration"].status == "partial":
        gap("configuration", "blocking", "read", phases["configuration"].detail)
    missing_code = [c.object_type for c in meta.coverage if c.code_missing]
    if missing_code:
        gap("customizations", "blocking", "code", f"Code could not be read for: {', '.join(missing_code)}.")
    failed = [c.object_type for c in meta.coverage if c.status == "failed" and c.required]
    if failed:
        gap("customizations", "blocking", "inventory", f"Object types not read: {', '.join(failed)}.")
    if use.evidence_days == 0:
        gap("integrations", "blocking", "activity",
            "No login or query records were imported, so interfaces that only show in activity cannot be found.")
    elif use.evidence_days < window_days:
        gap("integrations", "warning", "activity",
            f"Activity records cover {use.evidence_days} of {window_days} days; rare interfaces may be missed.")
    reports = [i for i in interfaces if i.kind == "report_tool"]
    if not reports:
        gap("reports", "warning", "sources", "No report tools were seen and the adapter reads no report definitions.")
    if "security_profile" not in by_type:
        gap("users_security", "blocking", "profiles", "Security profiles were not read.")
    if use.evidence_days == 0:
        gap("users_security", "warning", "logins", "Database logins in use are unknown without activity records.")
    gap("process", "warning", "logs", "Process logs (workflow history, tickets) are not imported yet.")
    gap("agentification", "warning", "candidates",
        "Agentification candidates are ranked from process mining, which is not run yet.")
    if not check.get("engine_version"):
        gap("platform", "blocking", "engine", "The source engine and version are unknown.")

    counts = {
        "data": {"tables": phases["dictionary"].counts.get("tables", 0),
                 "estate_score": phases["profile"].counts.get("estate_score"),
                 "documents": phases["documents"].counts.get("documents")},
        "configuration": {"items": len(cfg.items)},
        "customizations": {"code_objects": sum(by_type.get(t, 0) for t in ("procedure", "trigger", "function")),
                           "user_defined_tables": by_type.get("user_defined_table", 0), "rules": len(rules)},
        "integrations": {"interfaces": len([i for i in interfaces if i.kind != "report_tool"]),
                         "evidence_days": use.evidence_days},
        "reports": {"report_tools": len(reports), "views": by_type.get("view", 0)},
        "users_security": {"security_profiles": by_type.get("security_profile", 0)},
        "process": {}, "agentification": {},
        "platform": {"engine": check.get("engine"), "version": check.get("engine_version")},
    }
    streams = []
    for s in STREAMS:
        mine = [g for g in gaps if g.stream == s]
        status = "gap" if any(g.severity == "blocking" for g in mine) else ("partial" if mine else "covered")
        if s in ("process", "agentification") and all(g.severity == "warning" for g in mine):
            status = "not_started"
        streams.append({"stream": s, "title": STREAM_TITLES[s], "status": status, "counts": counts[s],
                        "gaps": [g.id for g in mine]})
    return streams, gaps
