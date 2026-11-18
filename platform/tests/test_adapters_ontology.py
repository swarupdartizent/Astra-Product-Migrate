"""I4: adapter contract, source and target adapters, golden datasets and the ontology service.

Runs against the real stack, including the local SQL Server. Fixture packs are generic and built here, with
unique names per run (published packs never change); the reference case's own packs are tested in
programmes/<reference>/tests.
"""

from __future__ import annotations

import base64
import json
import statistics
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar

import pymssql
import pytest
import yaml
from sqlalchemy import create_engine, text

from astra_migrate.adapters.contract import parse_target
from astra_migrate.adapters.sqlguard import ReadOnlyViolation, check_read_only
from astra_migrate.config import get_settings
from astra_migrate.golden.runner import _drop, admin_target
from tests.conftest import wait_job

pytestmark = pytest.mark.integration
H = dict[str, str]
RUN = uuid.uuid4().hex[:6]
DOMAIN = f"fixture-commerce-{RUN}"
ADAPTER = f"fixture-shop-source-{RUN}"
TARGET = f"fixture-shop-target-{RUN}"

# ------------------------------------------------------------------ fixture packs

SCHEMA_SQL = """
CREATE TABLE dbo.Customer (CustomerID int NOT NULL PRIMARY KEY, Name nvarchar(100) NOT NULL,
  ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.Orders (OrderID int NOT NULL PRIMARY KEY, CustomerID int NOT NULL REFERENCES dbo.Customer(CustomerID),
  OrderDate date NOT NULL, ShipDate date NOT NULL, Total decimal(12,2) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.OrderLine (LineID int NOT NULL PRIMARY KEY, OrderID int NOT NULL REFERENCES dbo.Orders(OrderID),
  Amount decimal(12,2) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.Attachment (DocID int NOT NULL PRIMARY KEY, DocName nvarchar(100) NOT NULL, LinkType char(1) NOT NULL,
  LinkKey int NOT NULL, Content varbinary(max) NOT NULL, ModifiedOn datetime2 NOT NULL)
GO
CREATE TABLE dbo.ScratchNoKey (Val int NOT NULL)
GO
CREATE PROCEDURE dbo.usp_Reprice @OrderID int AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.Orders SET Total = Total WHERE OrderID = @OrderID;
END
GO
CREATE TRIGGER dbo.trg_Orders_Guard ON dbo.Orders AFTER UPDATE AS
BEGIN
  IF EXISTS (SELECT 1 FROM inserted WHERE Total < 0) THROW 50001, 'Total cannot be negative.', 1;
END
GO
"""
DATA_SQL = """
INSERT INTO dbo.Customer VALUES (1, N'Alpha', '2026-01-01'), (2, N'Beta', '2026-01-02');
INSERT INTO dbo.Orders VALUES (10, 1, '2026-02-01', '2026-02-03', 30.00, '2026-02-01'),
  (11, 2, '2026-02-05', '2026-02-01', 20.00, '2026-02-05'), (12, 1, '2026-03-01', '2026-03-02', 15.01, '2026-03-01');
INSERT INTO dbo.OrderLine VALUES (100, 10, 10.00, '2026-02-01'), (101, 10, 20.00, '2026-02-01'),
  (102, 11, 20.00, '2026-02-05'), (103, 12, 15.00, '2026-03-01');
INSERT INTO dbo.Attachment VALUES (1, N'a.pdf', 'O', 10, 0x2550, '2026-02-01'),
  (2, N'b.pdf', 'C', 1, 0x2550, '2026-02-01'), (3, N'c.pdf', 'O', 99, 0x2550, '2026-02-01');
INSERT INTO dbo.ScratchNoKey VALUES (1);
GO
"""
DELTA_SQL = "UPDATE dbo.Orders SET ModifiedOn = '2026-11-30' WHERE OrderID = 12;\nGO\n"
EXPECTED = {
    "metadata": {"counts": {"table": 5, "procedure": 1, "trigger": 1},
                 "dependencies": ["dbo.usp_Reprice->dbo.Orders"]},
    "traps": {"FX-NO-KEY": ["dbo.ScratchNoKey"], "FX-TRIGGER-RULE": ["dbo.trg_Orders_Guard"]},
    "hidden_rules": ["dbo.trg_Orders_Guard"],
    "interfaces": [],
    "extract": {"full": {"customer": 2, "order": 3, "order_line": 4}, "documents": 3, "broken_links": ["3"],
                "delta": {"customer": 0, "order": 1, "order_line": 0}},
    "rules": {"FX-ORDER-DATES": ["11"], "FX-ORDER-TOTAL": ["12"]},
    "concepts": ["fx.customer", "fx.order", "fx.order_line"],
}


def domain_manifest() -> dict[str, Any]:
    return {
        "apiVersion": "astra.packs/v1", "type": "domain", "name": DOMAIN, "version": "1.0.0",
        "title": "Fixture commerce ontology", "publisher": "Test suite",
        "content": {"ontology": {"namespace": "fx", "concepts": [
            {"id": "fx.thing", "label": "Thing", "definition": "Root of the fixture commerce concepts.",
             "attributes": [{"name": "modified_at", "type": "datetime", "description": "Last change"}]},
            {"id": "fx.customer", "label": "Customer", "definition": "A party that buys goods from the shop.",
             "synonyms": ["buyer", "client"], "parent": "fx.thing",
             "attributes": [{"name": "name", "type": "text", "description": "Customer name"}]},
            {"id": "fx.order", "label": "Purchase order", "definition": "A customer's request to buy goods.",
             "synonyms": ["sales order", "PO"], "parent": "fx.thing",
             "attributes": [{"name": "order_date", "type": "date", "description": "Ordered on"},
                            {"name": "ship_date", "type": "date", "description": "Shipped on"},
                            {"name": "total", "type": "money", "description": "Order total"}],
             "relations": [{"name": "customer", "type": "refers_to", "target": "fx.customer"}]},
            {"id": "fx.order_line", "label": "Order line", "definition": "One priced item on a purchase order.",
             "parent": "fx.thing", "attributes": [{"name": "amount", "type": "money", "description": "Line amount"}],
             "relations": [{"name": "order", "type": "part_of", "target": "fx.order"}]}]}},
        "adds": {"rules": [
            {"id": "FX-ORDER-DATES", "statement": "An order ships on or after its order date.",
             "applies_to": ["fx.order"],
             "check": {"kind": "order", "concept": "fx.order", "first": "order_date", "second": "ship_date"}},
            {"id": "FX-ORDER-TOTAL", "statement": "An order total equals the sum of its lines, to the cent.",
             "applies_to": ["fx.order"],
             "check": {"kind": "sum_equals", "concept": "fx.order", "total": "total", "child_concept": "fx.order_line",
                       "child_relation": "order", "part": "amount"}}]},
        "tests": [{"name": "Passes the fixture golden dataset", "kind": "golden_dataset",
                   "dataset": f"{ADAPTER}@1.0.0:fixture-v1"}],
    }


TABLE_Q = ("SELECT t.name AS name, SCHEMA_NAME(t.schema_id) AS [schema], "
           "USER_NAME(COALESCE(t.principal_id, s.principal_id)) AS owner, t.modify_date AS modified_at "
           "FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.is_ms_shipped = 0")


def adapter_manifest() -> dict[str, Any]:
    return {
        "apiVersion": "astra.packs/v1", "type": "source_adapter", "name": ADAPTER, "version": "1.0.0",
        "title": "Fixture shop source adapter", "publisher": "Test suite",
        "content": {
            "contract": "astra.adapters/v1", "product": {"name": "Fixture shop", "versions": ["1"]},
            "engines": [{"engine": "sqlserver", "min_version": "11.0"}],
            "object_types": [
                {"key": "table", "label": "Tables", "queries": {"sqlserver": TABLE_Q}},
                {"key": "procedure", "label": "Procedures", "code": True, "queries": {"sqlserver": (
                    "SELECT p.name AS name, SCHEMA_NAME(p.schema_id) AS [schema], 'dbo' AS owner, "
                    "p.modify_date AS modified_at, OBJECT_DEFINITION(p.object_id) AS definition "
                    "FROM sys.procedures p")},
                 "dependencies": {"sqlserver": (
                     "SELECT SCHEMA_NAME(p.schema_id) + '.' + p.name AS name, COALESCE(d.referenced_schema_name, "
                     "'dbo') + '.' + d.referenced_entity_name AS depends_on FROM sys.sql_expression_dependencies d "
                     "JOIN sys.procedures p ON p.object_id = d.referencing_id")}},
                {"key": "trigger", "label": "Triggers", "code": True, "queries": {"sqlserver": (
                    "SELECT tr.name AS name, 'dbo' AS [schema], 'dbo' AS owner, tr.modify_date AS modified_at, "
                    "OBJECT_DEFINITION(tr.object_id) AS definition FROM sys.triggers tr")}}],
            "entities": [
                {"name": "customer", "table": "dbo.Customer", "key": ["CustomerID"], "delta_column": "ModifiedOn",
                 "concept": "fx.customer", "attributes": {"name": "Name"}},
                {"name": "order", "table": "dbo.Orders", "key": ["OrderID"], "delta_column": "ModifiedOn",
                 "concept": "fx.order", "attributes": {"order_date": "OrderDate", "ship_date": "ShipDate",
                                                       "total": "Total"},
                 "relations": {"customer": {"entity": "customer", "column": "CustomerID",
                                            "concept_relation": "customer"}}},
                {"name": "order_line", "table": "dbo.OrderLine", "key": ["LineID"], "delta_column": "ModifiedOn",
                 "concept": "fx.order_line", "attributes": {"amount": "Amount"},
                 "relations": {"order": {"entity": "order", "column": "OrderID", "concept_relation": "order"}}}],
            "documents": {"table": "dbo.Attachment", "key": "DocID", "name_column": "DocName",
                          "content_column": "Content", "delta_column": "ModifiedOn", "link_type_column": "LinkType",
                          "link_key_column": "LinkKey", "link_types": {"O": "order", "C": "customer"}},
            "traps": [
                {"id": "FX-NO-KEY", "title": "Table without a primary key", "description": "Rows cannot be matched.",
                 "severity": "medium", "stream": "data", "advice": "Agree a key before extraction.",
                 "detect": {"kind": "query", "queries": {"sqlserver": (
                     "SELECT SCHEMA_NAME(t.schema_id) + '.' + t.name AS hit FROM sys.tables t WHERE NOT EXISTS "
                     "(SELECT 1 FROM sys.key_constraints k "
                     "WHERE k.parent_object_id = t.object_id AND k.type = 'PK')")}}},
                {"id": "FX-TRIGGER-RULE", "title": "Rule in a trigger", "description": "A trigger stops changes.",
                 "severity": "high", "stream": "customizations", "advice": "Re-create the rule on the target.",
                 "detect": {"kind": "object_exists", "object_type": "trigger",
                            "definition_pattern": "\\b(RAISERROR|THROW)\\b"}}],
            "golden_datasets": [{"name": "fixture-v1", "path": "golden/fixture-v1", "engine": "sqlserver"}]},
        "tests": [{"name": "Passes its golden dataset", "kind": "golden_dataset",
                   "dataset": f"{ADAPTER}@1.0.0:fixture-v1", "packs": [f"{DOMAIN}@1.0.0"]}],
    }


def target_manifest(port: int) -> dict[str, Any]:
    _ = port
    return {
        "apiVersion": "astra.packs/v1", "type": "target_adapter", "name": TARGET, "version": "1.0.0",
        "title": "Fixture shop target adapter", "publisher": "Test suite",
        "content": {"contract": "astra.adapters/v1", "product": {"name": "Fixture target", "versions": ["1"]},
                    "load": {"method": "rest_api", "auth": "oauth2_client_credentials", "token_path": "/oauth/token",
                             "endpoints": [{"entity": "order", "method": "POST", "path": "/api/orders"}],
                             "rate_limit": {"requests_per_minute": 600, "burst": 2,
                                            "source": {"reference": "fixture"}, "recorded_on": "2026-11-18"}},
                    "constraints": [
                        {"id": "FXT-NO-DB", "kind": "database_access", "title": "No database writes",
                         "statement": "Loads go through the API only, never to the database.",
                         "applies_to": ["fx.order"], "source": {"reference": "fixture vendor note"},
                         "recorded_on": "2026-11-18", "confidence": "confirmed"}]},
    }


def bundle(manifest: dict[str, Any], extra: dict[str, str] | None = None) -> dict[str, Any]:
    files = {"pack.yaml": yaml.safe_dump(manifest, sort_keys=False), **(extra or {})}
    return {"files": {k: base64.b64encode(v.encode()).decode() for k, v in files.items()}}


def golden_files() -> dict[str, str]:
    base = "golden/fixture-v1"
    return {f"{base}/dataset.yaml": yaml.safe_dump({"name": "fixture-v1", "engine": "sqlserver",
                                                     "build": ["schema.sql", "data.sql"], "delta": "delta.sql",
                                                     "expected": "expected.yaml"}),
            f"{base}/schema.sql": SCHEMA_SQL, f"{base}/data.sql": DATA_SQL, f"{base}/delta.sql": DELTA_SQL,
            f"{base}/expected.yaml": yaml.safe_dump(EXPECTED)}


@pytest.fixture(scope="module")
def published(client: Any, admin: H) -> dict[str, Any]:
    """Register the fixture packs, run the golden dataset, then publish domain and adapter packs."""
    r = client.post("/api/v1/packs", headers=admin, json=bundle(domain_manifest()))
    assert r.status_code == 201, r.text
    r = client.post("/api/v1/packs", headers=admin, json=bundle(adapter_manifest(), golden_files()))
    assert r.status_code == 201, r.text
    # the domain test fails until a golden run exists for these exact contents
    t = client.post(f"/api/v1/packs/{DOMAIN}/1.0.0/test", headers=admin).json()
    assert not t["passed"] and any("No golden run" in c["message"] for c in t["checks"])
    g = client.post("/api/v1/golden-runs", headers=admin, json={"dataset": f"{ADAPTER}@1.0.0:fixture-v1",
                                                                 "packs": [f"{DOMAIN}@1.0.0"], "keep": True})
    assert g.status_code == 202, g.text
    job = wait_job(client, admin, g.json()["job_id"], timeout_s=240)
    run = client.get(f"/api/v1/golden-runs/{g.json()['id']}", headers=admin).json()
    assert job["status"] == "succeeded", (job, run.get("status_detail"),
                                          [m for m in (run.get("scorecard") or {}).get("measures", [])
                                           if not m["passed"]])
    assert run["status"] == "passed"
    for name in (DOMAIN, ADAPTER):
        p = client.post(f"/api/v1/packs/{name}/1.0.0/publish", headers=admin)
        assert p.status_code == 200, p.text
    return {"golden": run, "database": run["scorecard"]["database"]}


@pytest.fixture(scope="module", autouse=True)
def _cleanup_estates() -> Any:
    yield
    t = admin_target()
    conn = pymssql.connect(server=t.host, port=str(t.port), user=t.user, password=t.password, tds_version="7.4")
    cur = conn.cursor()
    cur.execute("SELECT name FROM sys.databases WHERE name LIKE 'golden[_]fixture%'")
    dbs = [r[0] for r in cur.fetchall()]
    cur.execute("SELECT name FROM sys.server_principals "
                "WHERE name LIKE 'astra[_]ro[_]%' OR name LIKE 'fx[_]reader[_]%'")
    logins = [r[0] for r in cur.fetchall()]
    conn.close()
    for d in dbs:
        _drop(t, d, "none")
    for lg in logins:
        _drop(t, "none", lg)


# ------------------------------------------------------------------ read-only guard and contract

@pytest.mark.parametrize("sql", [
    "SELECT * FROM dbo.Orders", "WITH x AS (SELECT 1 AS a) SELECT a FROM x",
    "SELECT name FROM sys.tables WHERE name = 'drop table x; delete'",
    "SELECT (SELECT c.name FROM sys.columns c FOR JSON PATH) AS j"])
def test_read_only_guard_allows_reads(sql: str) -> None:
    check_read_only(sql)


@pytest.mark.parametrize("sql", [
    "INSERT INTO dbo.Orders VALUES (1)", "SELECT 1; DELETE FROM dbo.Orders", "SELECT * INTO dbo.Copy FROM dbo.Orders",
    "EXEC sp_who", "UPDATE dbo.Orders SET Total = 0", "SELECT * FROM dbo.Orders WITH (UPDLOCK) FOR UPDATE",
    "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')", "DROP TABLE dbo.Orders", "GRANT SELECT ON x TO y",
    "WAITFOR DELAY '00:00:05'", "  "])
def test_read_only_guard_refuses_writes(sql: str) -> None:
    with pytest.raises(ReadOnlyViolation):
        check_read_only(sql)


def test_adapter_with_a_writing_query_is_refused_at_registration(client: Any, admin: H) -> None:
    m = adapter_manifest()
    m["name"] = f"fixture-bad-{RUN}"
    m["content"]["object_types"][0]["queries"]["sqlserver"] = "DELETE FROM dbo.Orders"
    m["content"]["golden_datasets"] = []
    m["tests"] = []
    r = client.post("/api/v1/packs", headers=admin, json=bundle(m))
    assert r.status_code == 422, r.text
    assert any("object_types" in e["field"] and "SELECT" in e["message"] for e in r.json()["errors"])


def test_target_adapter_cannot_express_database_loads() -> None:
    m = target_manifest(0)["content"]
    bad = json.loads(json.dumps(m))
    bad["load"]["method"] = "database"
    with pytest.raises(Exception, match="method"):
        parse_target(bad)
    no_constraint = json.loads(json.dumps(m))
    no_constraint["constraints"][0]["kind"] = "forms"
    with pytest.raises(Exception, match="database_access"):
        parse_target(no_constraint)


def test_contract_is_published(client: Any, admin: H) -> None:
    c = client.get("/api/v1/adapters/contract", headers=admin).json()
    assert c["version"] == "astra.adapters/v1"
    assert [o["name"] for o in c["operations"]] == ["connect", "read_metadata", "read_code", "extract", "list_traps",
                                                    "load", "report_limits"]


# ------------------------------------------------------------------ golden dataset and ontology

def test_golden_run_scores_every_measure(published: dict[str, Any]) -> None:
    measures = {m["name"]: m for m in published["golden"]["scorecard"]["measures"]}
    assert measures["Connection is read-only and supported"]["passed"]
    assert measures["A write attempt with the adapter's login is refused by the engine"]["passed"]
    assert measures["Rule FX-ORDER-TOTAL violations"]["actual"] == ["12"]
    assert measures["Delta extract: order"]["actual"] == 1
    assert measures["Documents whose entity link does not resolve"]["actual"] == ["3"]
    assert measures["Metadata: dependencies found"]["recall"] == 1.0


def test_ontology_operations_name_their_version_and_are_fast(client: Any, admin: H, published: dict[str, Any]
                                                             ) -> None:
    packs = {"packs": [f"{DOMAIN}@1.0.0"]}
    found = client.get("/api/v1/ontology/find", headers=admin, params={"q": "sales order", **packs}).json()
    assert found["ontology_version"] == f"{DOMAIN}@1.0.0"
    assert found["results"][0]["id"] == "fx.order" and found["results"][0]["match"] == "exact"
    fuzzy = client.get("/api/v1/ontology/find", headers=admin, params={"q": "purchase ord", **packs}).json()
    assert fuzzy["results"][0]["id"] == "fx.order"
    c = client.get("/api/v1/ontology/concepts/fx.order_line", headers=admin, params=packs).json()
    assert c["ancestors"] == ["fx.thing"] and c["relations"][0]["target"] == "fx.order"
    k = client.get("/api/v1/ontology/concepts/fx.order/constraints", headers=admin, params=packs).json()
    assert {x["id"] for x in k["constraints"] if x["kind"] == "domain_rule"} == {"FX-ORDER-DATES", "FX-ORDER-TOTAL"}
    assert all(x["kind"] in ("domain_rule", "target_constraint") for x in k["constraints"])
    b = client.get("/api/v1/ontology/concepts/fx.order/bindings", headers=admin,
                   params={**packs, "adapter": ADAPTER}).json()
    assert b["bindings"][0]["adapter_ref"] == f"{ADAPTER}@1.0.0" and b["bindings"][0]["table_name"] == "dbo.Orders"
    p = client.get("/api/v1/ontology/concepts/fx.order/precedents", headers=admin, params=packs).json()
    assert p["precedents"] == [] and p["note"]
    assert client.get("/api/v1/ontology/concepts/fx.nothing", headers=admin, params=packs).status_code == 404
    # the service itself answers well under a second for 95% of calls
    timings = []
    for i in range(40):
        path = ["/api/v1/ontology/find", "/api/v1/ontology/concepts/fx.order",
                "/api/v1/ontology/concepts/fx.order/constraints", "/api/v1/ontology/concepts/fx.order/bindings"][i % 4]
        r = client.get(path, headers=admin, params={**packs, **({"q": "customer"} if i % 4 == 0 else {})})
        assert r.status_code == 200
        timings.append(r.json()["elapsed_ms"])
    assert statistics.quantiles(timings, n=20)[18] < 1000


def test_agents_can_use_the_ontology_through_tools(client: Any, admin: H, published: dict[str, Any]) -> None:
    from astra_migrate.agents.tools import CATALOGUE, Effect

    for name in ("find_concept", "get_concept", "get_constraints", "get_vendor_binding", "get_precedents"):
        assert CATALOGUE[name].effect == Effect.READ_METADATA


# ------------------------------------------------------------------ source connections

def _reader(db: str) -> tuple[str, str]:
    t = admin_target()
    login, pw = f"fx_reader_{uuid.uuid4().hex[:8]}", "Rd1!" + uuid.uuid4().hex
    c = pymssql.connect(server=t.host, port=str(t.port), user=t.user, password=t.password, database=db,
                        autocommit=True, tds_version="7.4")
    cur = c.cursor()
    cur.execute(f"CREATE LOGIN [{login}] WITH PASSWORD = N'{pw}', CHECK_POLICY = OFF")
    cur.execute(f"CREATE USER [{login}] FOR LOGIN [{login}]")
    cur.execute(f"ALTER ROLE db_datareader ADD MEMBER [{login}]")
    cur.execute(f"GRANT VIEW DEFINITION TO [{login}]")
    c.close()
    return login, pw


def _connection(client: Any, admin: H, tenant: dict[str, Any], db: str, user: str, pw: str,
                name: str) -> dict[str, Any]:
    s = client.post(f"/api/v1/tenants/{tenant['id']}/secrets", headers=admin,
                    json={"name": f"{name}-pw", "description": "test", "value": pw})
    assert s.status_code == 201, s.text
    t = admin_target()
    r = client.post(f"/api/v1/tenants/{tenant['id']}/source-connections", headers=admin, json={
        "name": name, "adapter": f"{ADAPTER}@1.0.0", "engine": "sqlserver", "host": t.host, "port": t.port,
        "database": db, "username": user, "password_ref": f"secret://{name}-pw", "encrypt": False})
    assert r.status_code == 201, r.text
    return dict(r.json())


def _run(client: Any, admin: H, conn_id: str, kind: str, mode: str | None = None) -> dict[str, Any]:
    r = client.post(f"/api/v1/source-connections/{conn_id}/runs", headers=admin,
                    json={"kind": kind, **({"mode": mode} if mode else {})})
    assert r.status_code == 202, r.text
    wait_job(client, admin, r.json()["job_id"], timeout_s=120)
    return dict(client.get(f"/api/v1/adapter-runs/{r.json()['id']}", headers=admin).json())


def test_a_writable_account_is_refused(client: Any, admin: H, tenant_factory: Any, published: dict[str, Any]) -> None:
    t = admin_target()
    conn = _connection(client, admin, tenant_factory(), published["database"], t.user, t.password, "fx-writer")
    res = _run(client, admin, conn["id"], "check")
    assert res["run"]["status"] == "failed" and "read-only" in res["run"]["status_detail"]
    assert res["run"]["summary"]["read_only"] is False
    blocked = client.post(f"/api/v1/source-connections/{conn['id']}/runs", headers=admin, json={"kind": "harvest"})
    assert blocked.status_code == 409


def test_connection_harvest_and_extract_keep_data_in_the_tenant(client: Any, admin: H, tenant_factory: Any,
                                                               published: dict[str, Any]) -> None:
    db = published["database"]
    user, pw = _reader(db)
    tenant = tenant_factory()
    conn = _connection(client, admin, tenant, db, user, pw, "fx-reader")
    chk = _run(client, admin, conn["id"], "check")
    assert chk["run"]["status"] == "succeeded", chk
    assert chk["run"]["summary"]["engine_version"].startswith("16.") and chk["run"]["summary"]["read_only"]

    # a curator adds a trap; a trap with a writing query is refused
    bad = client.post(f"/api/v1/adapters/{ADAPTER}/traps", headers=admin, json={
        "reason": "testing curated traps", "trap": {
        "id": "FX-CURATED-BAD", "title": "Bad trap", "description": "Writes data.", "severity": "low", "stream": "data",
        "advice": "None at all.", "detect": {"kind": "query", "queries": {"sqlserver": "DELETE FROM dbo.Orders"}}}})
    assert bad.status_code == 422
    good = client.post(f"/api/v1/adapters/{ADAPTER}/traps", headers=admin, json={
        "reason": "seen on a project", "trap": {
        "id": "FX-CURATED-LATE-SHIP", "title": "Orders shipped before ordering", "description": "Dates look swapped.",
        "severity": "low", "stream": "data", "advice": "Check the date entry screen.",
        "detect": {"kind": "query", "queries": {"sqlserver": (
            "SELECT CAST(OrderID AS varchar(10)) AS hit FROM dbo.Orders WHERE ShipDate < OrderDate")}}}})
    assert good.status_code == 201, good.text

    h = _run(client, admin, conn["id"], "harvest")
    assert h["run"]["status"] == "succeeded", h
    assert h["run"]["summary"]["objects_by_type"] == {"table": 5, "procedure": 1, "trigger": 1}
    traps = {x["trap_id"]: x for x in h["traps"]}
    assert set(traps) == {"FX-NO-KEY", "FX-TRIGGER-RULE", "FX-CURATED-LATE-SHIP"}
    assert traps["FX-CURATED-LATE-SHIP"]["origin"] == "curated" and traps["FX-CURATED-LATE-SHIP"]["hits"] == ["11"]
    objs = client.get(f"/api/v1/adapter-runs/{h['run']['id']}/objects", headers=admin,
                      params={"object_type": "procedure"}).json()
    assert objs["total"] == 1 and objs["items"][0]["depends_on"] == ["dbo.Orders"]
    code = client.get(f"/api/v1/adapter-runs/{h['run']['id']}/objects/procedure/usp_Reprice", headers=admin,
                      params={"schema": "dbo"}).json()
    assert "UPDATE dbo.Orders" in code["definition"]

    full = _run(client, admin, conn["id"], "extract", "full")
    assert full["run"]["status"] == "succeeded", full
    counts = {c["entity"]: c for c in full["counts"]}
    assert counts["order"]["extracted"] == counts["order"]["source_count"] == 3
    docs = {d["doc_key"]: d for d in full["documents"]}
    assert docs["3"]["link_resolved"] is False and docs["1"]["link_entity"] == "order"

    t = admin_target()
    c = pymssql.connect(server=t.host, port=str(t.port), user=t.user, password=t.password, database=db,
                        autocommit=True, tds_version="7.4")
    c.cursor().execute("UPDATE dbo.Customer SET ModifiedOn = '2027-01-01' WHERE CustomerID = 2")
    c.close()
    delta = _run(client, admin, conn["id"], "extract", "delta")
    assert delta["run"]["status"] == "succeeded", delta
    assert {x["entity"]: x["extracted"] for x in delta["counts"]}["customer"] == 1

    # the rows live in the tenant's own database; the control plane holds counts only
    from astra_migrate.tenancy.service import db_password_path
    from astra_migrate.vault import get_vault

    pw_t = get_vault().get_secret(db_password_path(uuid.UUID(tenant["id"]))).value
    import psycopg

    tdb = create_engine(get_settings().control_db_url.get_secret_value())
    with tdb.connect() as cp:
        row = cp.execute(text("SELECT db_name, db_role FROM tenants WHERE id = :i"), {"i": tenant["id"]}).one()
    tdb.dispose()
    with psycopg.connect(host="127.0.0.1", port=15432, dbname=row[0], user=row[1], password=pw_t) as tc:
        n = tc.execute("SELECT count(*) FROM estate.extract_rows WHERE run_id = %s", (full["run"]["id"],)).fetchone()
        assert n is not None and n[0] == 2 + 3 + 4


# ------------------------------------------------------------------ target adapter, baselines and loads

class _Target(BaseHTTPRequestHandler):
    calls: ClassVar[list[str]] = []

    def _send(self, code: int, body: dict[str, Any], headers: dict[str, str] | None = None) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length).decode()
        if self.path == "/oauth/token":
            ok = "client_secret=s3cret-for-test" in raw and "grant_type=client_credentials" in raw
            self._send(200 if ok else 401, {"access_token": "tok-123", "expires_in": 300} if ok else {})
            return
        if self.headers.get("authorization") != "Bearer tok-123":
            self._send(401, {})
            return
        _Target.calls.append(raw)
        if len(_Target.calls) == 1:
            self._send(429, {"error": "slow down"}, {"Retry-After": "0", "X-RateLimit-Remaining": "0"})
        elif '"bad"' in raw:
            self._send(422, {"error": "invalid order"})
        else:
            self._send(201, {"ok": True}, {"X-RateLimit-Remaining": "41"})

    def log_message(self, *args: Any) -> None:
        pass


def test_loads_go_through_the_api_with_rate_limits_and_every_call_logged(client: Any, admin: H,
                                                                        tenant_factory: Any) -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Target)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        port = srv.server_port
        assert client.post("/api/v1/packs", headers=admin, json=bundle(target_manifest(port))).status_code == 201
        assert client.post(f"/api/v1/packs/{TARGET}/1.0.0/publish", headers=admin).status_code == 200
        comp = client.post("/api/v1/packs/compose", headers=admin, json={"packs": [f"{TARGET}@1.0.0"]}).json()
        assert any(r["id"] == "TGT-FXT-NO-DB" and "recorded 2026-11-18" in r["sources"][0]["reference"]
                   for r in comp["rules"])
        tenant = tenant_factory()
        client.post(f"/api/v1/tenants/{tenant['id']}/secrets", headers=admin,
                    json={"name": "fx-target-secret", "description": "test", "value": "s3cret-for-test"})
        tc = client.post(f"/api/v1/tenants/{tenant['id']}/target-connections", headers=admin, json={
            "name": "fx-target", "adapter": f"{TARGET}@1.0.0", "base_url": f"http://127.0.0.1:{port}",
            "client_id": "astra", "client_secret_ref": "secret://fx-target-secret"})
        assert tc.status_code == 201, tc.text
        bad_entity = client.post(f"/api/v1/target-connections/{tc.json()['id']}/loads", headers=admin,
                                 json={"entity": "customer", "records": [{"a": 1}], "reason": "testing loads"})
        assert bad_entity.status_code == 422
        r = client.post(f"/api/v1/target-connections/{tc.json()['id']}/loads", headers=admin, json={
            "entity": "order", "records": [{"id": 1}, {"id": 2, "state": "bad"}, {"id": 3}], "reason": "testing loads"})
        assert r.status_code == 202, r.text
        job = wait_job(client, admin, r.json()["job_id"])
        assert job["status"] == "succeeded", job
        assert job["result"] == {"calls": 4, "loaded": 2, "rejected": 1, "rate_limited": 1,
                                 "waited_ms": job["result"]["waited_ms"]}
        calls = client.get(f"/api/v1/target-connections/{tc.json()['id']}/calls", headers=admin).json()
        assert sorted(c["outcome"] for c in calls) == ["ok", "ok", "rate_limited", "rejected"]
        assert any(c["rate_limit_remaining"] == "41" for c in calls)
        eng = create_engine(get_settings().control_db_url.get_secret_value())
        try:
            with pytest.raises(Exception, match="permission denied"), eng.begin() as cx:
                cx.execute(text("UPDATE load_calls SET outcome = 'ok' WHERE id = :i"), {"i": calls[0]["id"]})
        finally:
            eng.dispose()
    finally:
        srv.shutdown()


def test_baselines_are_named_immutable_and_pinned_per_project(client: Any, admin: H, tenant_factory: Any) -> None:
    baseline = {"format": "astra.baseline/v1", "product": "Fixture target", "product_version": "1.0",
                "provided_by": "Test suite (synthetic)", "provided_on": "2026-11-18",
                "objects": [{"type": "table", "name": "Orders", "schema": "dbo",
                             "columns": [{"name": "OrderID", "type": "int"}]}]}
    if client.get(f"/api/v1/packs/{TARGET}/1.0.0", headers=admin).status_code == 404:
        client.post("/api/v1/packs", headers=admin, json=bundle(target_manifest(0)))
    r = client.post("/api/v1/target-baselines", headers=admin, json={
        "adapter_name": TARGET, "name": "fixture 1.0", "baseline_yaml": yaml.safe_dump(baseline), "synthetic": True})
    assert r.status_code == 201, r.text
    assert r.json()["objects_by_type"] == {"table": 1} and r.json()["synthetic"] is True
    dup = client.post("/api/v1/target-baselines", headers=admin, json={
        "adapter_name": TARGET, "name": "fixture 1.0", "baseline_yaml": yaml.safe_dump(baseline), "synthetic": True})
    assert dup.status_code == 422
    t = tenant_factory()
    proj = client.post(f"/api/v1/tenants/{t['id']}/projects", headers=admin, json={"name": "Baseline project"}).json()
    pin = client.put(f"/api/v1/projects/{proj['id']}/baseline", headers=admin,
                     json={"baseline_id": r.json()["id"], "reason": "first rehearsal"})
    assert pin.status_code == 200 and pin.json()["pinned"]["name"] == "fixture 1.0"
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        with pytest.raises(Exception, match="permission denied"), eng.begin() as cx:
            cx.execute(text("UPDATE target_baselines SET name = 'x' WHERE id = :i"), {"i": r.json()["id"]})
    finally:
        eng.dispose()


def test_jobs_say_whether_they_can_be_cancelled(client: Any, admin: H, tenant_factory: Any) -> None:
    t = tenant_factory()
    jobs = client.get("/api/v1/jobs", headers=admin, params={"tenant_id": t["id"]}).json()
    assert jobs and all("can_cancel" in j for j in jobs) and not any(j["can_cancel"] for j in jobs)
    time.sleep(0)
