"""I5: discovery and the Migration Knowledge Graph (E08, E13.F2.S1).

Unit tests for the engines, then an end-to-end run through the API on a fixture estate built on the local
SQL Server. The reference case's own estate is scored in its golden dataset (programmes/<reference>/tests).
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timedelta
from typing import Any

import pytest
import yaml

from astra_migrate.adapters.source import MetadataObject
from astra_migrate.discovery import activity, codereader, configuration, profiler, usage
from tests.conftest import wait_job
from tests.test_adapters_ontology import (
    DATA_SQL,
    SCHEMA_SQL,
    _connection,
    _reader,
    _run,
    adapter_manifest,
    bundle,
    domain_manifest,
)

pytestmark = pytest.mark.integration
H = dict[str, str]
RUN = uuid.uuid4().hex[:6]
ADAPTER = f"fixture-disc-source-{RUN}"
AS_OF = datetime(2026, 11, 1)


# ------------------------------------------------------------------ engines (unit)

def test_statements_are_parsed_into_reads_writes_and_executions() -> None:
    assert activity.parse_statement("SELECT * FROM dbo.Orders o JOIN dbo.Customer c ON c.CustomerID = o.CustomerID") \
        == (["dbo.Customer", "dbo.Orders"], [], [])
    assert activity.parse_statement("UPDATE dbo.Orders SET Total = 1 WHERE OrderID = 2") == ([], ["dbo.Orders"], [])
    assert activity.parse_statement("INSERT INTO dbo.Audit (x) SELECT y FROM dbo.Orders") == \
        (["dbo.Orders"], ["dbo.Audit"], [])
    assert activity.parse_statement("EXEC dbo.usp_Reprice @OrderID = 1") == ([], [], ["dbo.usp_Reprice"])
    assert activity.parse_statement("WITH x AS (SELECT 1 AS a) SELECT a FROM x") == ([], [], [])
    assert activity.parse_statement("this is not sql") == ([], [], [])


def test_activity_files_need_a_timestamp_and_login() -> None:
    good = activity.parse_file(b'{"timestamp": "2026-10-01T10:00:00", "login": "a", "program": "p", '
                               b'"statement": "SELECT 1 FROM dbo.Orders"}\n', "x.jsonl")
    assert good[0].reads == ["dbo.Orders"]
    csv_ok = activity.parse_file(b"timestamp,login,host,program,statement\n2026-10-01T10:00:00,a,h,p,\n", "x.csv")
    assert csv_ok[0].statement is None
    with pytest.raises(activity.ActivityError, match="timestamp"):
        activity.parse_file(b'{"login": "a"}\n', "x.jsonl")
    with pytest.raises(activity.ActivityError, match="jsonl or .csv"):
        activity.parse_file(b"x", "x.txt")


def test_value_shapes_never_keep_values() -> None:
    assert profiler.shape("99-1000007") == "99-9999999"
    assert profiler.shape("AB12 c") == "AA99 A"
    assert profiler.shape("x" * 60) == "text(60+)"


def test_code_reader_finds_rules_with_fields_confidence_and_excerpt() -> None:
    trg = MetadataObject("trigger", "trg_Guard", "dbo", "dbo", None, (
        "CREATE TRIGGER dbo.trg_Guard ON dbo.Orders AFTER UPDATE AS\nBEGIN\n"
        "  IF EXISTS (SELECT 1 FROM inserted i WHERE i.Total < 0)\n"
        "    THROW 50001, 'Total cannot be negative.', 1;\nEND"), [], {"on_table": "Orders"})
    proc = MetadataObject("procedure", "usp_Reprice", "dbo", "dbo", None, (
        "CREATE PROCEDURE dbo.usp_Reprice AS\nBEGIN\n  UPDATE o SET Total = l.Amount * 2 FROM dbo.Orders o "
        "JOIN dbo.OrderLine l ON l.OrderID = o.OrderID;\nEND"), [], {})
    rules = codereader.read_all([trg, proc], set())
    v = next(r for r in rules if r.kind == "validation")
    assert v.confidence == 0.9 and v.reads == ["dbo.Orders.Total"] and "Total cannot be negative" in v.statement
    assert v.line_from == 3 and "   3  " in v.excerpt
    d = next(r for r in rules if r.kind == "derivation")
    assert d.sets == ["dbo.Orders.Total"] and "dbo.OrderLine.Amount" in d.reads


def test_usage_flows_through_code_and_triggers() -> None:
    objs = [
        MetadataObject("view", "vw_Totals", "dbo", "dbo", None, "x", ["dbo.Orders"], {}),
        MetadataObject("trigger", "trg_Audit", "dbo", "dbo", None, "x", ["dbo.Audit"], {"on_table": "Customer"}),
        MetadataObject("function", "fn_Unused", "dbo", "dbo", None, "x", ["dbo.Orders"], {}),
    ]
    events = [activity.Event(AS_OF - timedelta(days=d), "u", "h", "app", "s", ["dbo.vw_Totals"],
                             ["dbo.Customer"] if d == 3 else [], []) for d in range(1, 95)]
    res = usage.measure(events, objs, ["dbo.Orders", "dbo.Customer", "dbo.Audit", "dbo.Spare"], AS_OF, 90)
    assert set(res.unused) == {"dbo.fn_Unused", "dbo.Spare"}
    assert res.elements["dbo.audit"].via == ["dbo.trg_Audit"]
    assert res.evidence_days >= 89


def test_interfaces_exclude_the_product_client_and_the_platform() -> None:
    evs = [activity.Event(AS_OF, "u", "WS1", "ShopDesktop.exe", "s", ["dbo.Orders"], [], []),
           activity.Event(AS_OF, "etl", "DW1", "Loader", "s", ["dbo.Orders"], [], []),
           activity.Event(AS_OF, "bi", "BI1", "Microsoft Power BI", "s", ["dbo.Orders"], [], []),
           activity.Event(AS_OF, "ro", "A1", "astra-migrate-adapter", "s", [], [], []),
           activity.Event(AS_OF, "dba", "D1", "sqlcmd", None, [], [], [])]
    found = {i.key: i for i in usage.find_interfaces(evs, ["^ShopDesktop"], ["astra-migrate-adapter"], 1)}
    assert set(found) == {"program:loader", "program:microsoft power bi", "program:sqlcmd"}
    assert found["program:microsoft power bi"].kind == "report_tool"
    assert found["program:sqlcmd"].source == "login_log"


def test_configuration_differences_between_scopes() -> None:
    items = [configuration.ConfigItem("product", "A:P1", "P1", "A", '{"x": 1}'),
             configuration.ConfigItem("product", "B:P1", "P1", "B", '{"x": 2}'),
             configuration.ConfigItem("product", "A:P2", "P2", "A", "{}"),
             configuration.ConfigItem("rule", "R", "R", None, "x")]
    diff = configuration.scope_differences(items)
    assert diff["scopes"] == ["A", "B"]
    assert diff["only_in_some"] == [{"kind": "product", "name": "P2", "present_in": ["A"], "missing_in": ["B"]}]
    assert [d["name"] for d in diff["different"]] == ["P1"]


# ------------------------------------------------------------------ end to end through the API

CONFIG_SQL = """
CREATE TABLE dbo.Region (RegionID int NOT NULL PRIMARY KEY, Scope varchar(5) NOT NULL, Code varchar(10) NOT NULL,
  Settings nvarchar(200) NOT NULL)
GO
INSERT INTO dbo.Region VALUES (1, 'EU', 'TAX', '{"vat": 20}'), (2, 'US', 'TAX', '{"vat": 0}'), (3, 'EU', 'SHIP', '{}');
INSERT INTO dbo.Customer VALUES (3, N'NOT-A-NAME-123', '2026-01-03');
GO
"""


def disc_adapter() -> dict[str, Any]:
    m = adapter_manifest()
    m["name"], m["tests"] = ADAPTER, []
    m["content"]["golden_datasets"] = [{"name": "estate", "path": "golden/estate", "engine": "sqlserver"}]
    m["content"]["dictionary"] = {
        "columns": {"sqlserver": (
            "SELECT SCHEMA_NAME(t.schema_id) AS table_schema, t.name AS table_name, c.name AS column_name, "
            "TYPE_NAME(c.user_type_id) AS data_type, c.max_length AS max_length, c.is_nullable AS nullable, "
            "c.column_id AS ordinal FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id")},
        "relations": {"sqlserver": (
            "SELECT fk.name AS name, SCHEMA_NAME(pt.schema_id) AS from_schema, pt.name AS from_table, "
            "pc.name AS from_column, SCHEMA_NAME(rt.schema_id) AS to_schema, rt.name AS to_table, rc.name AS to_column "
            "FROM sys.foreign_key_columns k JOIN sys.foreign_keys fk ON fk.object_id = k.constraint_object_id "
            "JOIN sys.tables pt ON pt.object_id = k.parent_object_id JOIN sys.columns pc ON pc.object_id = "
            "k.parent_object_id AND pc.column_id = k.parent_column_id JOIN sys.tables rt ON rt.object_id = "
            "k.referenced_object_id JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = "
            "k.referenced_column_id")},
        "soft_relations": [{"from_table": "dbo.Attachment", "from_column": "LinkKey", "to_table": "dbo.Orders",
                            "to_column": "OrderID"}]}
    m["content"]["configuration"] = [{"kind": "region_setting", "label": "Region settings", "queries": {"sqlserver": (
        "SELECT Scope + ':' + Code AS [key], Code AS name, Scope AS scope, Settings AS definition, "
        "NULL AS depends_on FROM dbo.Region")}}]
    m["content"]["activity"] = {"product_clients": ["^ShopDesktop"]}
    return m


def disc_files() -> dict[str, str]:
    base = "golden/estate"
    return {f"{base}/dataset.yaml": yaml.safe_dump({"name": "estate", "engine": "sqlserver",
                                                     "build": ["schema.sql", "data.sql", "config.sql"],
                                                     "expected": "expected.yaml"}),
            f"{base}/schema.sql": SCHEMA_SQL, f"{base}/data.sql": DATA_SQL, f"{base}/config.sql": CONFIG_SQL,
            f"{base}/expected.yaml": yaml.safe_dump({
                "metadata": {"counts": {"table": 6}}, "hidden_rules": ["dbo.trg_Orders_Guard"], "interfaces": [],
                "traps": {"FX-NO-KEY": ["dbo.ScratchNoKey"], "FX-TRIGGER-RULE": ["dbo.trg_Orders_Guard"]}})}


def activity_log() -> str:
    lines = []
    for d in range(95):
        ts = AS_OF - timedelta(days=d, hours=2)
        lines.append({"timestamp": ts.isoformat(), "login": "clerk", "host": "WS1", "program": "ShopDesktop.exe",
                      "statement": "SELECT * FROM dbo.Orders o JOIN dbo.OrderLine l ON l.OrderID = o.OrderID"})
        lines.append({"timestamp": ts.isoformat(), "login": "clerk", "host": "WS1", "program": "ShopDesktop.exe",
                      "statement": "UPDATE dbo.Customer SET Name = Name WHERE CustomerID = 1"})
        lines.append({"timestamp": (ts + timedelta(hours=1)).isoformat(), "login": "etl", "host": "DW1",
                      "program": "NightlyLoader", "statement": "SELECT CustomerID, Name FROM dbo.Customer"})
    return "\n".join(json.dumps(x) for x in lines) + "\n"


@pytest.fixture(scope="module")
def estate(client: Any, admin: H) -> dict[str, Any]:
    if client.get(f"/api/v1/packs/{domain_manifest()['name']}/1.0.0", headers=admin).status_code == 404:
        client.post("/api/v1/packs", headers=admin, json=bundle(domain_manifest()))
    assert client.post("/api/v1/packs", headers=admin, json=bundle(disc_adapter(), disc_files())).status_code == 201
    g = client.post("/api/v1/golden-runs", headers=admin, json={"dataset": f"{ADAPTER}@1.0.0:estate", "keep": True})
    assert g.status_code == 202, g.text
    wait_job(client, admin, g.json()["job_id"], timeout_s=240)
    run = client.get(f"/api/v1/golden-runs/{g.json()['id']}", headers=admin).json()
    assert run["status"] == "passed", run
    assert client.post(f"/api/v1/packs/{ADAPTER}/1.0.0/publish", headers=admin).status_code == 200
    return {"database": run["scorecard"]["database"]}


def test_discovery_run_builds_the_graph_and_coverage_report(client: Any, admin: H, tenant_factory: Any,
                                                           estate: dict[str, Any]) -> None:
    user, pw = _reader(estate["database"])
    tenant = tenant_factory()
    conn = _connection(client, admin, tenant, estate["database"], user, pw, "disc-src", adapter=f"{ADAPTER}@1.0.0")
    assert _run(client, admin, conn["id"], "check")["run"]["status"] == "succeeded"
    proj = client.post(f"/api/v1/tenants/{tenant['id']}/projects", headers=admin, json={"name": "Discovery"}).json()

    # without activity the run still completes, and the coverage report says what is missing
    r = client.post(f"/api/v1/projects/{proj['id']}/discovery-runs", headers=admin,
                    json={"connection_id": conn["id"], "as_of": AS_OF.isoformat()})
    assert r.status_code == 202, r.text
    wait_job(client, admin, r.json()["job_id"], timeout_s=180)
    first = client.get(f"/api/v1/discovery-runs/{r.json()['id']}", headers=admin).json()
    assert first["status"] == "succeeded", first
    assert first["phases"]["usage"]["status"] == "skipped"
    rep = client.get(f"/api/v1/projects/{proj['id']}/coverage-reports", headers=admin).json()[0]
    assert "integrations:activity" in rep["blocking_open"]

    bad = client.post(f"/api/v1/source-connections/{conn['id']}/activity", headers=admin,
                      json={"filename": "log.jsonl", "content_base64": base64.b64encode(b'{"x": 1}\n').decode()})
    assert bad.status_code == 422
    up = client.post(f"/api/v1/source-connections/{conn['id']}/activity", headers=admin,
                     json={"filename": "log.jsonl",
                           "content_base64": base64.b64encode(activity_log().encode()).decode()})
    assert up.status_code == 201, up.text
    assert up.json()["records"] == 285 and up.json()["days"] >= 94

    r = client.post(f"/api/v1/projects/{proj['id']}/discovery-runs", headers=admin,
                    json={"connection_id": conn["id"], "as_of": AS_OF.isoformat()})
    wait_job(client, admin, r.json()["job_id"], timeout_s=180)
    run = client.get(f"/api/v1/discovery-runs/{r.json()['id']}", headers=admin).json()
    assert run["status"] == "succeeded" and run["summary"]["evidence_days"] >= 90, run
    rid = run["id"]

    prof = client.get(f"/api/v1/discovery-runs/{rid}/results/profile", headers=admin).json()
    tables = {t["table"]: t for t in prof["tables"]}
    att = tables["dbo.Attachment"]
    # link keys 99 (no such order) and 1 (a customer document) do not match an order
    assert [b["broken_rows"] for b in att["broken"] if b["relation"].startswith("soft:")] == [2]
    name = next(c for c in tables["dbo.Customer"]["columns"] if c["column"] == "Name")
    assert name["distinct"] == 3 and name["nulls"] == 0
    assert 0 < prof["estate_score"] <= 100 and set(prof["weights"]) == {"completeness", "validity", "integrity"}

    use = client.get(f"/api/v1/discovery-runs/{rid}/results/usage", headers=admin).json()
    assert "dbo.ScratchNoKey" in use["unused"] and "dbo.Orders" not in use["unused"]
    assert "dbo.trg_Orders_Guard" in use["unused"]  # Orders is only read, so its update trigger never fired
    itf = {i["key"]: i for i in client.get(f"/api/v1/discovery-runs/{rid}/results/interfaces", headers=admin).json()}
    assert set(itf) == {"program:nightlyloader"} and itf["program:nightlyloader"]["reads"] == ["dbo.Customer"]
    rules = client.get(f"/api/v1/discovery-runs/{rid}/results/rules", headers=admin).json()
    assert any(x["kind"] == "validation" and x["object"] == "dbo.trg_Orders_Guard" for x in rules)
    cfg = client.get(f"/api/v1/discovery-runs/{rid}/results/configuration", headers=admin).json()
    assert cfg["diff"]["only_in_some"][0]["name"] == "SHIP" and cfg["diff"]["different"][0]["name"] == "TAX"
    docs = client.get(f"/api/v1/discovery-runs/{rid}/results/documents", headers=admin).json()
    assert docs["total_count"] == 3 and {r["type"] for r in docs["rows"]} == {"pdf"}

    g = client.get(f"/api/v1/discovery-runs/{rid}/graph", headers=admin, params={"kind": "table"}).json()
    assert g["total"] == 6 and all(n["stream"] in ("data", "customizations") for n in g["nodes"])
    orders = client.get(f"/api/v1/discovery-runs/{rid}/graph/nodes", headers=admin,
                        params={"node_id": "table:dbo.orders"}).json()
    assert orders["node"]["concept"] == "fx.order"
    assert {e["type"] for e in orders["outgoing"]} >= {"has_column", "references"}
    assert any(e["type"] == "depends_on" for e in orders["incoming"])
    unused_nodes = client.get(f"/api/v1/discovery-runs/{rid}/graph", headers=admin, params={"unused": True}).json()
    assert unused_nodes["total"] == run["summary"]["unused"]
    review = [x for x in client.get(f"/api/v1/projects/{proj['id']}/reviews", headers=admin).json()
              if x["kind"] == "proposal"]
    assert review and review[0]["owner_role"] == "solution_architect"

    # coverage report: the discovery gate needs an accepted report, and blocking gaps must be waived first
    reps = client.get(f"/api/v1/projects/{proj['id']}/coverage-reports", headers=admin).json()
    current = next(x for x in reps if x["discovery_run_id"] == rid)
    assert [x["status"] for x in reps].count("draft") == 1 and len(current["streams"]) == 9
    gate = client.put(f"/api/v1/projects/{proj['id']}/stages/discovery", headers=admin, json={"status": "done"})
    assert "No accepted discovery coverage report" in gate.json()["detail"]
    if current["blocking_open"]:
        refused = client.post(f"/api/v1/coverage-reports/{current['id']}/decision", headers=admin,
                              json={"accept": True, "note": "Accepting with open gaps"})
        assert refused.status_code == 409
        for gid in current["blocking_open"]:
            w = client.post(f"/api/v1/coverage-reports/{current['id']}/waivers", headers=admin,
                            json={"gap_id": gid, "reason": "Not applicable to this fixture estate (test)."})
            assert w.status_code == 200, w.text
    ok = client.post(f"/api/v1/coverage-reports/{current['id']}/decision", headers=admin,
                     json={"accept": True, "note": "Discovery is complete for the fixture estate."})
    assert ok.status_code == 200 and ok.json()["status"] == "accepted", ok.text
    gate = client.put(f"/api/v1/projects/{proj['id']}/stages/discovery", headers=admin, json={"status": "done"})
    assert "No accepted discovery coverage report" not in gate.json().get("detail", "")
