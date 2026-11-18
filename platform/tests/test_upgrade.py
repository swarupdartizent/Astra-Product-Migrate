"""I6: version delta, pattern advice, code conversion with recorded tests, and the hosting checklist (E09, E10).

Unit tests for the delta engine and the SQL Anywhere converter; workbench tests on the local SQL Server; then
an end-to-end run through the API on the discovery fixture estate.
"""

from __future__ import annotations

import csv
import io
import random
import uuid
from typing import Any

import pytest
import yaml

from astra_migrate.conversion.sqlanywhere import convert
from astra_migrate.conversion.workbench import Table, Workbench
from astra_migrate.delta.engine import Obj, advise_pattern, body_hash, code_hash, compare
from tests.conftest import wait_job
from tests.test_adapters_ontology import TARGET, _connection, _reader, _run, bundle, domain_manifest, target_manifest
from tests.test_discovery import disc_adapter, disc_files

H = dict[str, str]
DISC_ADAPTER = f"fixture-up-source-{uuid.uuid4().hex[:6]}"


@pytest.fixture(scope="module")
def estate(client: Any, admin: H) -> dict[str, Any]:
    """The discovery fixture estate under this module's own adapter name."""
    if client.get(f"/api/v1/packs/{domain_manifest()['name']}/1.0.0", headers=admin).status_code == 404:
        client.post("/api/v1/packs", headers=admin, json=bundle(domain_manifest()))
    m = disc_adapter()
    m["name"] = DISC_ADAPTER
    assert client.post("/api/v1/packs", headers=admin, json=bundle(m, disc_files())).status_code == 201
    g = client.post("/api/v1/golden-runs", headers=admin, json={"dataset": f"{DISC_ADAPTER}@1.0.0:estate",
                                                                 "keep": True})
    assert g.status_code == 202, g.text
    wait_job(client, admin, g.json()["job_id"], timeout_s=240)
    run = client.get(f"/api/v1/golden-runs/{g.json()['id']}", headers=admin).json()
    assert run["status"] == "passed", run
    assert client.post(f"/api/v1/packs/{DISC_ADAPTER}/1.0.0/publish", headers=admin).status_code == 200
    return {"database": run["scorecard"]["database"]}


def T(name: str, *cols: str, schema: str = "dbo", custom: bool = False) -> Obj:
    return Obj("table", schema, name, tuple(sorted((c, "int") for c in cols)), customer_specific=custom)


# ------------------------------------------------------------------ delta engine (unit)

SRC = [T("Customer", "id", "name"), T("Orders", "id", "total"), T("OrderLine", "id", "order_id", "amount", "qty"),
       T("Attachment", "id", "body"), T("Scratch", "x"), T("usr_Notes", "id", "note", custom=True),
       Obj("procedure", "dbo", "usp_A", (), code_hash("CREATE PROCEDURE dbo.usp_A AS SELECT 1"),
           body_hash("CREATE PROCEDURE dbo.usp_A AS SELECT 1", "usp_A"))]
TGT = [T("Customer", "id", "name"), T("Orders", "id", "total", "channel"),
       T("OrderItem", "id", "order_id", "amount", "qty"), T("Attachment", "id", "body", schema="docs"),
       T("Invoice", "id")]


def test_delta_sorts_every_object_into_one_group() -> None:
    r = compare(SRC, TGT)
    by = {d.source: d for d in r.differences}
    assert by["dbo.Customer"].group == "unchanged"
    assert by["dbo.Orders"].group == "changed_behaviour"
    assert by["dbo.Orders"].details["added_in_target"] == ["channel"]
    assert by["dbo.OrderLine"].group == "renamed_or_moved" and by["dbo.OrderLine"].target == "dbo.OrderItem"
    assert by["dbo.Attachment"].details["how"] == "moved" and by["dbo.Attachment"].target == "docs.Attachment"
    assert by["dbo.Scratch"].group == "removed_in_target" and by["dbo.usr_Notes"].group == "removed_in_target"
    assert r.not_in_scope == ["procedure:dbo.usp_A"]  # the baseline describes no procedures: never guessed
    assert r.new_in_target == ["table:dbo.Invoice"]
    assert r.counts == {"unchanged": 1, "renamed_or_moved": 2, "changed_behaviour": 1, "removed_in_target": 2}
    assert sum(r.counts.values()) + len(r.not_in_scope) == len(SRC)


def test_delta_is_deterministic_whatever_the_input_order() -> None:
    first = compare(SRC, TGT)
    for seed in range(5):
        s, t = SRC[:], TGT[:]
        random.Random(seed).shuffle(s)  # noqa: S311
        random.Random(seed + 1).shuffle(t)  # noqa: S311
        again = compare(s, t)
        assert (again.input_digest, again.result_digest) == (first.input_digest, first.result_digest)


def test_origin_comes_from_the_standard_baseline_or_the_adapter() -> None:
    standard = [T("Customer", "id", "name"), T("Orders", "id"), T("OrderLine", "id", "order_id", "amount", "qty"),
                T("Attachment", "id", "body")]
    with_std = {d.source: d.origin for d in compare(SRC, TGT, standard).differences}
    assert with_std["dbo.Customer"] == "standard"
    assert with_std["dbo.Orders"] == "customized_standard"  # the customer added a column to a product table
    assert with_std["dbo.Scratch"] == "customer_specific" and with_std["dbo.usr_Notes"] == "customer_specific"
    without = {d.source: d.origin for d in compare(SRC, TGT).differences}
    assert without["dbo.usr_Notes"] == "customer_specific"  # the adapter marks its type as customization
    assert without["dbo.Customer"] == "unknown"  # no standard baseline: said, not guessed


def test_renamed_code_is_found_by_its_body() -> None:
    sql = "CREATE PROCEDURE dbo.usp_Old @x int AS SELECT @x * 2"
    new = sql.replace("usp_Old", "usp_New")
    s = [Obj("procedure", "dbo", "usp_Old", (), code_hash(sql), body_hash(sql, "usp_Old"))]
    t = [Obj("procedure", "dbo", "usp_New", (), code_hash(new), body_hash(new, "usp_New"))]
    d = compare(s, t).differences[0]
    assert d.group == "renamed_or_moved" and d.target == "dbo.usp_New"


def test_pattern_advice_gives_its_evidence() -> None:
    r = compare(SRC, TGT)
    a = advise_pattern("same_family_upgrade", r)
    assert a["recommended"] == "cross_product" and a["agrees"] is False  # 3 of 6 kept (50%) is below 60%
    assert advise_pattern("same_family_upgrade", compare(SRC[:2], TGT[:1] + [T("Orders", "id", "total")]))["agrees"]
    assert any("of 6" in x for x in a["reasons"])
    assert advise_pattern(None, None)["recommended"] is None
    assert advise_pattern("cross_product", r, source_count=3)["recommended"] == "consolidation"


# ------------------------------------------------------------------ SQL Anywhere conversion (unit)

PROC = """CREATE PROCEDURE dbo.sp_order_total(IN p_order_id INTEGER, OUT p_total NUMERIC(12,2))
BEGIN
  DECLARE v_count INTEGER;
  SELECT count(*), sum(qty * price) INTO v_count, p_total FROM dbo.order_line WHERE order_id = p_order_id;
  IF v_count = 0 THEN
    SET p_total = 0;
  ELSEIF v_count > 100 THEN
    MESSAGE 'large order' TO CLIENT;
  END IF;
  SELECT order_id, qty FROM dbo.order_line WHERE order_id = p_order_id ORDER BY qty;
END"""
FUNC = """CREATE FUNCTION dbo.fn_days(IN p_from DATE, IN p_to DATE) RETURNS INTEGER
BEGIN
  RETURN DAYS(p_from, p_to);
END"""
TRIG = """CREATE TRIGGER tr_line_qty AFTER INSERT ON dbo.order_line
REFERENCING NEW AS n FOR EACH ROW
BEGIN
  IF n.qty <= 0 THEN
    RAISERROR 17001 'Quantity must be positive';
  END IF;
END"""


def test_watcom_procedures_become_transact_sql_and_name_each_rule() -> None:
    c = convert("procedure", "dbo.sp_order_total", PROC)
    assert not c.needs_review and c.converted
    assert "@p_total NUMERIC(12,2) OUTPUT" in c.converted
    assert "SELECT @v_count = count(*), @p_total = sum(qty * price) FROM" in c.converted
    assert "END ELSE IF @v_count > 100 BEGIN" in c.converted and "PRINT 'large order';" in c.converted
    assert {"MESSAGE -> PRINT", "SELECT ... INTO variables -> SELECT @v = ..."} <= set(c.rules)
    f = convert("function", "dbo.fn_days", FUNC)
    assert "DATEDIFF(day, @p_from, @p_to)" in (f.converted or "")


def test_types_defaults_and_functions_are_rewritten() -> None:
    c = convert("table", "dbo.t", "CREATE TABLE dbo.t (id INTEGER DEFAULT AUTOINCREMENT, note LONG VARCHAR, "
                                  "at TIMESTAMP DEFAULT CURRENT TIMESTAMP, d DOUBLE, s VARCHAR(10) DEFAULT 'x')")
    assert c.converted == ("CREATE TABLE dbo.t (id INTEGER IDENTITY(1,1), note varchar(max), "
                           "at datetime2 DEFAULT SYSDATETIME(), d float, s VARCHAR(10) DEFAULT 'x')")
    v = convert("view", "dbo.v", "CREATE VIEW dbo.v AS SELECT LIST(name, ';') AS n, TODAY() AS d, "
                                 "LOCATE(name, 'x') AS p FROM dbo.t")
    assert "STRING_AGG(name, ';')" in (v.converted or "") and "CHARINDEX('x', name)" in (v.converted or "")


@pytest.mark.parametrize("sql,reason", [
    ("CREATE PROCEDURE dbo.p() BEGIN DECLARE x INT; ON EXCEPTION RESUME END", "ON EXCEPTION RESUME"),
    ("CREATE PROCEDURE dbo.p() BEGIN FOR f AS c CURSOR FOR SELECT 1 DO END FOR; END", "CURSOR"),
    ("CREATE TABLE dbo.t (id INT DEFAULT GLOBAL AUTOINCREMENT)", "GLOBAL AUTOINCREMENT"),
    ("CREATE PROCEDURE dbo.p() BEGIN SELECT IFNULL(a, b, c) FROM t; END", "IFNULL"),
])
def test_unsafe_constructs_go_to_review_with_the_reason(sql: str, reason: str) -> None:
    c = convert("procedure" if "PROCEDURE" in sql else "table", "dbo.p", sql)
    assert c.needs_review and any(reason in r for r in c.review)


def test_before_triggers_and_complex_row_triggers_go_to_review() -> None:
    before = convert("trigger", "dbo.t", TRIG.replace("AFTER", "BEFORE"))
    assert before.needs_review and "BEFORE" in before.review[0]
    t = convert("trigger", "dbo.t", TRIG)
    assert not t.needs_review and "FROM inserted n WHERE n.qty <= 0" in (t.converted or "")


# ------------------------------------------------------------------ workbench (local SQL Server)

TABLES = [Table("dbo", "order_line", [("order_id", "int"), ("qty", "int"), ("price", "decimal(12,2)")])]
CASE = {"id": "c1", "name": "two lines", "inputs": {"p_order_id": 7}, "outputs": ["p_total"],
        "setup": {"dbo.order_line": [{"order_id": 7, "qty": 2, "price": 10.5}, {"order_id": 7, "qty": 1, "price": 3},
                                     {"order_id": 8, "qty": 1, "price": 1}]},
        "expected": {"outputs": {"p_total": "24.00"}, "rows": [[7, 1], [7, 2]]}}


@pytest.mark.integration
def test_converted_code_compiles_and_replays_recorded_cases() -> None:
    proc, fn, trig = (convert("procedure", "dbo.sp_order_total", PROC), convert("function", "dbo.fn_days", FUNC),
                      convert("trigger", "dbo.tr_line_qty", TRIG))
    with Workbench() as wb:
        for c, q in ((proc, "dbo.sp_order_total"), (fn, "dbo.fn_days"), (trig, "dbo.tr_line_qty")):
            assert wb.compile(TABLES, c.converted or "", q).ok, q
        bad = wb.compile(TABLES, "CREATE PROCEDURE dbo.x AS SELECT nosuch FROM dbo.order_line", "dbo.x")
        assert not bad.ok and "nosuch" in (bad.error or "")
        unres = wb.compile(TABLES, "CREATE PROCEDURE dbo.y AS SELECT a FROM dbo.missing", "dbo.y")
        assert unres.ok and unres.unresolved == ["dbo.missing"]
        ok = wb.run_test(TABLES, proc.converted or "", "procedure", "dbo.sp_order_total", CASE)
        assert ok.passed, ok.differences
        wrong = wb.run_test(TABLES, proc.converted or "", "procedure", "dbo.sp_order_total",
                            {**CASE, "expected": {"outputs": {"p_total": "25"}, "rows": [[7, 1]]}})
        assert not wrong.passed and wrong.inputs == {"p_order_id": 7}
        assert wrong.differences == ["output p_total: expected '25', got '24.00'", "rows: expected 1, got 2"]
        f = wb.run_test(TABLES, fn.converted or "", "function", "dbo.fn_days",
                        {"inputs": {"a": "2026-01-01", "b": "2026-03-01"}, "expected": {"value": 59}})
        assert f.passed
        t = wb.run_test(TABLES, trig.converted or "", "trigger", "dbo.tr_line_qty",
                        {"setup": {"dbo.order_line": [{"order_id": 1, "qty": 0, "price": 1}]},
                         "expected": {"error": "Quantity must be positive"}})
        assert t.passed
        sneaky = wb.run_test(TABLES, proc.converted or "", "procedure", "dbo.sp_order_total",
                             {**CASE, "inputs": {"p_order_id = 1; DROP TABLE x; --": 1}})
        assert not sneaky.passed and "plain identifiers" in sneaky.differences[0]
        # nothing persists between checks
        cur = wb.conn.cursor()
        cur.execute("SELECT count(*) FROM sys.objects WHERE is_ms_shipped = 0")
        assert cur.fetchone() == (0,)
        wb.conn.rollback()


# ------------------------------------------------------------------ end to end through the API

def _baseline(client: Any, admin: H, adapter: str, name: str, objects: list[dict[str, Any]]) -> str:
    body = {"format": "astra.baseline/v1", "product": "Fixture", "product_version": "1", "provided_by": "Test suite",
            "provided_on": "2026-11-18", "objects": objects}
    r = client.post("/api/v1/target-baselines", headers=admin, json={
        "adapter_name": adapter, "name": name, "baseline_yaml": yaml.safe_dump(body), "synthetic": True})
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def _tbl(name: str, cols: dict[str, str], schema: str = "dbo") -> dict[str, Any]:
    return {"type": "table", "name": name, "schema": schema, "columns": [{"name": k, "type": v}
                                                                         for k, v in cols.items()]}


CUSTOMER = {"CustomerID": "int", "Name": "nvarchar(100)", "ModifiedOn": "datetime2"}
ORDERS = {"OrderID": "int", "CustomerID": "int", "OrderDate": "date", "ShipDate": "date", "Total": "decimal(12,2)",
          "ModifiedOn": "datetime2"}
LINE = {"LineID": "int", "OrderID": "int", "Amount": "decimal(12,2)", "ModifiedOn": "datetime2"}
ATTACH = {"DocID": "int", "DocName": "nvarchar(100)", "LinkType": "char(1)", "LinkKey": "int",
          "Content": "varbinary(max)", "ModifiedOn": "datetime2"}


@pytest.mark.integration
def test_delta_conversion_and_checklist_end_to_end(client: Any, admin: H, tenant_factory: Any,
                                                   estate: dict[str, Any]) -> None:
    run = uuid.uuid4().hex[:6]
    if client.get(f"/api/v1/packs/{TARGET}/1.0.0", headers=admin).status_code == 404:
        client.post("/api/v1/packs", headers=admin, json=bundle(target_manifest(0)))
    target = _baseline(client, admin, TARGET, f"delta {run}", [
        _tbl("Customer", CUSTOMER), _tbl("Orders", {**ORDERS, "Channel": "varchar(10)"}), _tbl("OrderItem", LINE),
        _tbl("Attachment", ATTACH, schema="docs"), _tbl("Invoice", {"InvoiceID": "int"})])
    standard = _baseline(client, admin, DISC_ADAPTER, f"standard {run}", [
        _tbl("Customer", CUSTOMER), _tbl("Orders", ORDERS), _tbl("OrderLine", {"LineID": "int"}),
        _tbl("Attachment", ATTACH)])
    user, pw = _reader(estate["database"])
    tenant = tenant_factory()
    conn = _connection(client, admin, tenant, estate["database"], user, pw, "up-src",
                       adapter=f"{DISC_ADAPTER}@1.0.0")
    proj = client.post(f"/api/v1/tenants/{tenant['id']}/projects", headers=admin, json={"name": "Upgrade"}).json()

    early = client.post(f"/api/v1/projects/{proj['id']}/delta-runs", headers=admin, json={"connection_id": conn["id"]})
    assert early.status_code == 409  # no connection check yet
    assert _run(client, admin, conn["id"], "check")["run"]["status"] == "succeeded"
    nopin = client.post(f"/api/v1/projects/{proj['id']}/delta-runs", headers=admin, json={"connection_id": conn["id"]})
    assert nopin.status_code == 409 and "baseline" in nopin.json()["title"].lower()
    src_pin = client.put(f"/api/v1/projects/{proj['id']}/baseline", headers=admin,
                         json={"baseline_id": standard, "reason": "wrong kind of baseline"})
    assert src_pin.status_code == 422
    assert client.put(f"/api/v1/projects/{proj['id']}/baseline", headers=admin,
                      json={"baseline_id": target, "reason": "rehearsal"}).status_code == 200
    wrong_std = client.post(f"/api/v1/projects/{proj['id']}/delta-runs", headers=admin,
                            json={"connection_id": conn["id"], "standard_baseline_id": target})
    assert wrong_std.status_code == 422

    # ---- version delta
    r = client.post(f"/api/v1/projects/{proj['id']}/delta-runs", headers=admin,
                    json={"connection_id": conn["id"], "standard_baseline_id": standard})
    assert r.status_code == 202, r.text
    wait_job(client, admin, r.json()["job_id"], timeout_s=120)
    d = client.get(f"/api/v1/delta-runs/{r.json()['id']}", headers=admin).json()
    assert d["status"] == "succeeded", d
    assert d["counts"] == {"unchanged": 1, "renamed_or_moved": 2, "changed_behaviour": 1, "removed_in_target": 2}
    assert d["not_in_scope"] == 2 and d["new_in_target"] == 1  # procedure and trigger; Invoice
    assert d["origin_counts"] == {"standard": 3, "customized_standard": 1, "customer_specific": 2}
    rows = client.get(f"/api/v1/delta-runs/{d['id']}/differences", headers=admin,
                      params={"group": "renamed_or_moved"}).json()
    assert {(x["source"], x["target"]) for x in rows["items"]} == {("dbo.OrderLine", "dbo.OrderItem"),
                                                                   ("dbo.Attachment", "docs.Attachment")}
    lists = client.get(f"/api/v1/delta-runs/{d['id']}/lists", headers=admin).json()
    assert lists["not_in_scope"] == ["procedure:dbo.usp_Reprice", "trigger:dbo.trg_Orders_Guard"]
    exp = client.get(f"/api/v1/delta-runs/{d['id']}/export", headers=admin, params={"format": "csv"})
    assert exp.status_code == 200 and exp.headers["x-result-digest"] == d["result_digest"]
    table = list(csv.DictReader(io.StringIO(exp.text)))
    assert len(table) == 6 + 2 + 1 and {x["group"] for x in table} >= {"unchanged", "new_in_target"}
    js = client.get(f"/api/v1/delta-runs/{d['id']}/export", headers=admin, params={"format": "json"}).json()
    assert js["result_digest"] == d["result_digest"] and len(js["differences"]) == 6

    # the same inputs give the same result
    again = client.post(f"/api/v1/projects/{proj['id']}/delta-runs", headers=admin,
                        json={"connection_id": conn["id"], "standard_baseline_id": standard}).json()
    wait_job(client, admin, again["job_id"], timeout_s=120)
    d2 = client.get(f"/api/v1/delta-runs/{again['id']}", headers=admin).json()
    assert (d2["input_digest"], d2["result_digest"]) == (d["input_digest"], d["result_digest"])
    advice = client.get(f"/api/v1/projects/{proj['id']}/pattern-advice", headers=admin).json()
    assert advice["recommended"] == "cross_product" and advice["chosen"] is None  # 3 of 6 kept: 50%

    # ---- conversion on the workbench, with recorded cases
    case = {"object_name": "dbo.usp_Reprice", "name": "reprices one order", "inputs": {"OrderID": 10},
            "setup": {"dbo.Orders": [{"OrderID": 10, "CustomerID": 1, "OrderDate": "2026-01-01",
                                      "ShipDate": "2026-01-02", "Total": 5, "ModifiedOn": "2026-01-01"}]},
            "expected": {"rows": []}}
    assert client.post(f"/api/v1/projects/{proj['id']}/conversion-tests", headers=admin, json=case).status_code == 201
    failing = {**case, "name": "expects a row it will not get", "expected": {"rows": [[10]]}}
    assert client.post(f"/api/v1/projects/{proj['id']}/conversion-tests", headers=admin,
                       json=failing).status_code == 201
    dup = client.post(f"/api/v1/projects/{proj['id']}/conversion-tests", headers=admin, json=case)
    assert dup.status_code == 409
    c = client.post(f"/api/v1/projects/{proj['id']}/conversion-runs", headers=admin, json={"connection_id": conn["id"]})
    assert c.status_code == 202, c.text
    wait_job(client, admin, c.json()["job_id"], timeout_s=180)
    cr = client.get(f"/api/v1/conversion-runs/{c.json()['id']}", headers=admin).json()
    assert cr["status"] == "succeeded", cr
    assert cr["summary"]["objects"] == 2 and cr["summary"]["compiled"] == 2
    assert cr["summary"]["tests"] == {"passed": 1, "failed": 1}
    obj = client.get(f"/api/v1/conversion-runs/{cr['id']}/object", headers=admin,
                     params={"object_type": "procedure", "name": "dbo.usp_Reprice"}).json()
    failed = next(t for t in obj["tests"] if not t["passed"])
    assert failed["inputs"] == {"OrderID": 10} and failed["differences"] == ["rows: expected 1, got 0"]

    # ---- hosting checklist: generic areas, owners and statuses
    empty = client.get(f"/api/v1/projects/{proj['id']}/checklist", headers=admin).json()
    assert empty["total"] == 0 and set(empty["missing"]) == {f"generic:{a}" for a in ("sso", "mfa", "network",
                                                                                         "printing")}
    cl = client.post(f"/api/v1/projects/{proj['id']}/checklist/sync", headers=admin).json()
    assert cl["total"] == 4 and cl["missing"] == [] and not cl["complete"]
    sso = next(i for i in cl["items"] if i["category"] == "sso")
    assert sso["source"]["kind"] == "generic" and sso["owner_role"] == "customer_it_security_lead"
    no_owner = client.patch(f"/api/v1/checklist-items/{sso['id']}", headers=admin, json={"status": "done"})
    assert no_owner.status_code == 409
    me = client.get("/api/v1/me", headers=admin).json()
    assert client.patch(f"/api/v1/checklist-items/{sso['id']}", headers=admin,
                        json={"owner_user_id": me["id"]}).status_code == 200
    no_note = client.patch(f"/api/v1/checklist-items/{sso['id']}", headers=admin, json={"status": "done"})
    assert no_note.status_code == 422
    done = client.patch(f"/api/v1/checklist-items/{sso['id']}", headers=admin,
                        json={"status": "done", "note": "SAML set up with the customer's IdP; tested per role."})
    assert done.status_code == 200 and done.json()["status"] == "done" and done.json()["owner_name"]
    again_cl = client.post(f"/api/v1/projects/{proj['id']}/checklist/sync", headers=admin).json()
    assert again_cl["done"] == 1 and again_cl["total"] == 4  # syncing keeps owners and statuses
