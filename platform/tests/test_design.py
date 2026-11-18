"""I9 design and build: mapping proposals with evidence and confidence, low-confidence items in expert review, the
configuration translator with retirements, forms parity, customer code to the target's naming rules, integrations
and desktop links, reports, page drafts and security profiles, and transformation code that cannot be approved until
its own version's tests pass on the SQL Server workbench."""

from __future__ import annotations

import uuid
import zlib
from typing import Any

import pytest
import yaml
from sqlalchemy import create_engine, text

from astra_migrate.adapters.contract import TargetDesign
from astra_migrate.config import get_settings
from astra_migrate.conversion.workbench import Workbench, WorkbenchBlocked
from astra_migrate.design import build, mapping, parity, streams
from tests.conftest import wait_job
from tests.test_adapters_ontology import _connection, _reader, _run, bundle, target_manifest
from tests.test_discovery import AS_OF
from tests.test_planning_api import COMP, SRC, _blueprint, _ensure_published, setup  # noqa: F401

pytestmark = pytest.mark.integration
H = dict[str, str]
RUN = uuid.uuid4().hex[:6]
DTARGET = f"fixture-design-target-{RUN}"
REF = {"reference": "fixture vendor design note"}

DESIGN: dict[str, Any] = {
    "mechanisms": [
        {"key": "api", "kind": "rest_api", "label": "REST API", "directions": ["inbound"], "source": REF,
         "confidence": "confirmed"},
        {"key": "query", "kind": "read_query", "label": "Read-only query service", "directions": ["read"],
         "source": REF, "confidence": "confirmed"},
        {"key": "hooks", "kind": "webhook", "label": "Webhooks", "directions": ["outbound"], "source": REF,
         "confidence": "reported"}],
    "report_access": "query",
    "retirements": [{"object_type": "region_setting", "name_pattern": "^SHIP$",
                     "replacement": "Shipping rules move to the target's standard carrier settings.",
                     "source": REF, "confidence": "reported"}],
    "naming": {"schema": "cust", "prefix": "x_", "case": "snake", "max_length": 60, "source": REF,
               "confidence": "confirmed"},
    "configuration_areas": [{"key": "regions", "label": "Regional settings", "source_kinds": ["region_setting"],
                             "method": "api"}],
    "pages": {"name": "Page designer", "source": REF, "confidence": "confirmed"},
}


def _design_target() -> dict[str, Any]:
    m = target_manifest(0)
    m["name"] = DTARGET
    m["content"]["design"] = DESIGN
    return m


BASELINE = {"format": "astra.baseline/v1", "product": "Fixture", "product_version": "2", "provided_by": "Test suite",
            "provided_on": "2026-11-18", "objects": [
                {"type": "table", "name": "Customer", "schema": "dbo", "columns": [
                    {"name": "CustomerID", "type": "int", "nullable": False},
                    {"name": "Name", "type": "nvarchar(50)", "nullable": False},
                    {"name": "ModifiedOn", "type": "datetime2"}]},
                {"type": "table", "name": "Orders", "schema": "dbo", "columns": [
                    {"name": "OrderID", "type": "int", "nullable": False},
                    {"name": "CustomerID", "type": "int", "nullable": False},
                    {"name": "OrderDate", "type": "date"}, {"name": "ShippedOn", "type": "date"},
                    {"name": "Total", "type": "decimal(12,2)"}, {"name": "ModifiedOn", "type": "datetime2"}]},
                {"type": "table", "name": "OrderLine", "schema": "dbo", "columns": [
                    {"name": "LineID", "type": "int", "nullable": False}, {"name": "OrderID", "type": "int"},
                    {"name": "Amount", "type": "decimal(12,2)"}, {"name": "ModifiedOn", "type": "datetime2"}]}]}


def _project(client: Any, admin: H, tenant_factory: Any, setup: dict[str, Any]) -> tuple[dict[str, Any], str, str]:  # noqa: F811
    _ensure_published(client, admin, DTARGET, "1.0.0", bundle(_design_target()))
    tenant = tenant_factory()
    proj = client.post(f"/api/v1/tenants/{tenant['id']}/projects", headers=admin, json={"name": "Design"}).json()
    r = client.post(f"/api/v1/projects/{proj['id']}/blueprint/versions", headers=admin,
                    json={"content": _blueprint("whole_estate"), "message": "Design fixture"})
    assert r.status_code in (200, 201), r.text
    user, pw = _reader(setup["database"])
    conn = _connection(client, admin, tenant, setup["database"], user, pw, "design-src", adapter=f"{SRC}@1.0.0")
    assert _run(client, admin, conn["id"], "check")["run"]["status"] == "succeeded"
    d = client.post(f"/api/v1/projects/{proj['id']}/discovery-runs", headers=admin,
                    json={"connection_id": conn["id"], "as_of": AS_OF.isoformat()})
    wait_job(client, admin, d.json()["job_id"], timeout_s=180)
    b = client.post("/api/v1/target-baselines", headers=admin, json={
        "adapter_name": DTARGET, "name": f"design {uuid.uuid4().hex[:6]}", "baseline_yaml": yaml.safe_dump(BASELINE),
        "synthetic": True})
    assert b.status_code == 201, b.text
    assert client.put(f"/api/v1/projects/{proj['id']}/baseline", headers=admin,
                      json={"baseline_id": b.json()["id"], "reason": "design test"}).status_code == 200
    dr = client.post(f"/api/v1/projects/{proj['id']}/delta-runs", headers=admin, json={"connection_id": conn["id"]})
    wait_job(client, admin, dr.json()["job_id"], timeout_s=120)
    return tenant, proj["id"], conn["id"]


def test_design_and_build_end_to_end(client: Any, admin: H, tenant_factory: Any, user_factory: Any,
                                     setup: dict[str, Any]) -> None:  # noqa: F811
    tenant, pid, conn = _project(client, admin, tenant_factory, setup)
    sme_h, _ = user_factory(("data_sme", "project", pid))
    arch_h, _ = user_factory(("solution_architect", "project", pid))
    base = f"/api/v1/projects/{pid}"

    run = client.post(f"{base}/design-runs", headers=admin, json={"connection_id": conn})
    assert run.status_code == 201, run.text
    assert client.post(f"{base}/design-runs", headers=admin, json={"connection_id": conn}).status_code in (201, 409)
    job = wait_job(client, admin, run.json()["job_id"], timeout_s=180)
    assert job["status"] == "succeeded", job
    ov = client.get(f"{base}/design", headers=sme_h).json()
    assert ov["target_design"]["naming"]["schema"] == "cust" and ov["can_decide"]["mapping"]
    assert not ov["can_decide"]["page"]  # pages are decided by the solution architect

    # ---- mappings: evidence, confidence, low confidence to expert review
    items = {i["key"]: i for i in client.get(f"{base}/design/items", headers=sme_h,
                                             params={"stream": "mapping", "limit": 500}).json()["items"]}
    oid = items["dbo.orders.orderid"]
    assert oid["status"] == "proposed" and oid["confidence"] >= 0.9
    assert oid["target"]["table"] == "dbo.Orders" and oid["target"]["column"] == "OrderID"
    assert any("version delta" in e or "same table name" in e for e in oid["evidence"])
    name = items["dbo.customer.name"]
    assert any("may not fit" in f for f in name["flags"])
    ship = items["dbo.orders.shipdate"]
    assert ship["status"] == "in_review" and ship["review_item_id"]
    assert items["dbo.scratchnokey.val"]["target"] is None and items["dbo.scratchnokey.val"]["status"] == "in_review"
    refused = client.post(f"{base}/design/decisions", headers=sme_h, json={
        "stream": "mapping", "keys": ["dbo.orders.shipdate"], "action": "approve"}).json()
    assert refused["refused"][0]["reason"].startswith("The item is in the review queue")
    assert client.post(f"{base}/design/decisions", headers=arch_h, json={
        "stream": "mapping", "keys": ["dbo.orders.orderid"], "action": "approve"}).status_code == 403

    # the expert answers in the review queue with a changed target; the register follows
    ch = client.post(f"/api/v1/review-items/{ship['review_item_id']}/decide", headers=sme_h, json={
        "action": "change", "note": "Shipping date was renamed in the new version.",
        "changed_value": "dbo.Orders.ShippedOn"})
    assert ch.status_code == 200, ch.text
    shipped = client.get(f"{base}/design/item", headers=sme_h,
                         params={"stream": "mapping", "key": "dbo.orders.shipdate"}).json()
    assert shipped["status"] == "approved" and shipped["target"]["column"] == "ShippedOn"
    bad = client.post(f"{base}/design/decisions", headers=sme_h, json={
        "stream": "mapping", "keys": ["dbo.customer.modifiedon"], "action": "change",
        "reason": "Use another column instead.", "target": "dbo.Customer.Nope"})
    assert bad.status_code == 422
    keys = [k for k, i in items.items() if i["status"] == "proposed" and k.startswith(("dbo.orders.", "dbo.customer."))]
    ok = client.post(f"{base}/design/decisions", headers=sme_h, json={
        "stream": "mapping", "keys": keys, "action": "approve", "reason": "Checked against the new data model."})
    assert ok.status_code == 200 and set(ok.json()["decided"]) == set(keys), ok.text

    # ---- configuration: rebuilt in the target's area, or retired with a replacement
    cfg = {i["key"]: i for i in client.get(f"{base}/design/items", headers=arch_h,
                                           params={"stream": "configuration"}).json()["items"]}
    tax = cfg["region_setting:eu:tax"]
    assert tax["target"]["area"] == "regions" and tax["source"]["definition"] == {"vat": 20}
    ship_cfg = cfg["region_setting:eu:ship"]
    assert ship_cfg["status"] == "in_review" and ship_cfg["target"]["retire"]
    assert "standard carrier settings" in ship_cfg["target"]["replacement"]

    # ---- pages drafted from the entities' mappings; designer approval
    pages = {i["key"]: i for i in client.get(f"{base}/design/items", headers=arch_h,
                                             params={"stream": "page"}).json()["items"]}
    order_page = pages["page:order"]
    assert order_page["target"]["builder"] == "Page designer" and "needs designer approval" in order_page["flags"]
    fields = [f["target"] for s in order_page["target"]["sections"] for f in s.get("fields", [])]
    assert "dbo.Orders.OrderID" in fields
    assert client.post(f"{base}/design/decisions", headers=arch_h, json={
        "stream": "page", "keys": ["page:order"], "action": "approve"}).json()["decided"] == ["page:order"]

    # ---- build: transformation code from approved mappings, tested on the workbench
    b = client.post(f"{base}/build", headers=admin)
    assert b.status_code == 202
    bj = wait_job(client, admin, b.json()["job_id"], timeout_s=240)
    if bj["status"] == "failed" and "workbench" in (bj.get("error") or "").lower():
        pytest.skip(f"SQL Server workbench unavailable: {bj.get('error')}")
    assert bj["status"] == "succeeded", bj
    arts = {a["name"]: a for a in client.get(f"{base}/build-artifacts", headers=arch_h,
                                             params={"kind": "transformation"}).json()}
    orders = arts["dbo.Orders <- dbo.Orders"]
    assert orders["status"] == "tests_passed" and not orders["runnable"], orders
    cust = arts["dbo.Customer <- dbo.Customer"]
    detail = client.get(f"/api/v1/build-artifacts/{cust['id']}", headers=arch_h).json()
    assert cust["status"] == "tests_failed" and not detail["can_approve"]  # 100-character names do not fit in 50
    assert any("truncated" in (r["detail"] or "").lower() for r in detail["results"]), detail["results"]
    od = client.get(f"/api/v1/build-artifacts/{orders['id']}", headers=arch_h).json()
    assert "INSERT INTO [tgt].[dbo__Orders]" in od["code"] and od["inputs"]["mappings"]
    refused = client.post(f"/api/v1/build-artifacts/{cust['id']}/approve", headers=arch_h,
                          json={"note": "Ship it anyway please."})
    assert refused.status_code == 409
    approved = client.post(f"/api/v1/build-artifacts/{orders['id']}/approve", headers=arch_h,
                           json={"note": "Tests pass on the workbench; reviewed the casts."})
    assert approved.status_code == 200 and approved.json()["runnable"], approved.text
    again = wait_job(client, admin, client.post(f"{base}/build", headers=admin).json()["job_id"], timeout_s=240)
    assert again["status"] == "succeeded"
    still = {a["name"]: a for a in client.get(f"{base}/build-artifacts", headers=arch_h).json()}
    assert still["dbo.Orders <- dbo.Orders"]["version"] == 1  # unchanged code keeps its version

    # the database refuses an approval without passing tests, and any change to an artifact's digest
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    for sql, needle in (
        ("UPDATE build_artifacts SET status = 'approved', approved_by = (SELECT id FROM users WHERE kind = 'person' "
         "LIMIT 1) WHERE id = :i", "only after its tests pass"),
        ("UPDATE build_artifacts SET digest = 'x' WHERE id = :i", "immutable"),
    ):
        with pytest.raises(Exception, match=needle), eng.begin() as c:
            c.execute(text(sql), {"i": cust["id"]})
    eng.dispose()
    acts = {e["action"] for e in client.get("/api/v1/audit", headers=admin,
                                            params={"project_id": pid, "action": "design."}).json()["items"]}
    assert {"design.run_requested", "design.run_finished", "design.approve"} <= acts


# ------------------------------------------------------------------ rules (unit)

def _inputs(**kw: Any) -> streams.Inputs:
    base: dict[str, Any] = {"design": TargetDesign.model_validate(DESIGN), "objects": [], "config": [],
                            "interfaces": [], "rate_per_minute": 60, "entities": [], "mappings": [],
                            "code_types": {"procedure"}, "custom_tables": [], "converted": []}
    base.update(kw)
    return streams.Inputs(**base)


def test_integrations_pick_a_mechanism_by_direction_or_flag_desktop_links() -> None:
    d = dict(DESIGN)
    d["retirements"] = [*DESIGN["retirements"], {
        "object_type": "external_program", "when": {"desktop_only": True},
        "replacement": "Replace with a webhook to the document service.", "source": REF, "confidence": "reported"}]
    inp = _inputs(design=TargetDesign.model_validate(d), interfaces=[
        {"key": "program:billing", "name": "Billing", "kind": "program", "source": "query_log", "writes": ["dbo.X"],
         "reads": [], "executes": [], "per_day": 100000},
        {"key": "program:bi", "name": "BI", "kind": "program", "source": "query_log", "reads": ["dbo.X"]},
        {"key": "linked_server:hq", "name": "HQ", "kind": "linked_server", "source": "code", "writes": ["HQ.a.b.c"]},
        {"key": "external_program:mail", "name": "Mail", "kind": "external_program", "source": "configuration"}],
        objects=[streams.Obj("external_program", "Mail", None, {"desktop_only": 1})])
    got = {i.key: i for i in streams.integrations(inp)}
    assert got["interface:program:billing"].target["mechanism"] == "api"  # type: ignore[index]
    assert any("rate limit" in f for f in got["interface:program:billing"].flags)
    assert got["interface:program:bi"].target["mechanism"] == "query"  # type: ignore[index]
    assert got["interface:linked_server:hq"].target["mechanism"] == "hooks"  # type: ignore[index]
    mail = got["interface:external_program:mail"]
    assert mail.status == "in_review" and mail.target["retire"] and mail.review  # type: ignore[index]
    assert streams.integrations(_inputs(design=None, interfaces=[
        {"key": "program:bi", "name": "BI", "kind": "program", "reads": ["x"]}]))[0].status == "blocked"


def test_security_profiles_list_every_new_object() -> None:
    inp = _inputs(objects=[streams.Obj("security_profile", "Underwriter", None, {"detail": "[]"})])
    prof = streams.security(inp, ["page:Order", "report:cust.rpt_x"], {"profile:underwriter": {
        "entries": {"page:Order": "edit"}}})[0]
    assert prof.extra["entries"] == {"page:Order": "edit", "report:cust.rpt_x": None}
    assert prof.extra["missing"] == ["report:cust.rpt_x"]


def test_code_and_reports_follow_the_naming_rules() -> None:
    inp = _inputs(custom_tables=["dbo.UserNotes"], converted=[{"object_type": "procedure", "name": "dbo.usp_Calc",
                                                               "status": "compiled"}],
                  objects=[streams.Obj("view", "vOpenOrders", "dbo", {}, "CREATE VIEW dbo.vOpenOrders AS SELECT 1")])
    code = {i.key: i for i in streams.code(inp)}
    assert code["user_defined_table:dbo.usernotes"].target["qualified"] == "cust.x_user_notes"  # type: ignore[index]
    assert code["procedure:dbo.usp_calc"].target["qualified"] == "cust.x_usp_calc"  # type: ignore[index]
    rep = streams.reports(inp)[0]
    assert rep.target["qualified"] == "cust.x_rpt_v_open_orders" and rep.target["mechanism"] == "query"  # type: ignore[index]
    assert build.rename("EXEC dbo.usp_Calc; SELECT * FROM [dbo].[UserNotes] n; EXEC usp_Calc",
                        {"dbo.usp_Calc": "cust.x_usp_calc", "dbo.UserNotes": "cust.x_user_notes"}) == \
        "EXEC [cust].[x_usp_calc]; SELECT * FROM [cust].[x_user_notes] n; EXEC [cust].[x_usp_calc]"


def test_mapping_scores_names_types_and_precedents() -> None:
    assert mapping.name_similarity("CustomerID", "customer_id") == 1.0
    assert mapping.type_score("nvarchar", 100, "nvarchar(50)")[0] == 0.6
    tgt = mapping.TargetTable("dbo", "Client", [{"name": "ClientName", "type": "nvarchar(100)"},
                                                {"name": "ClientNo", "type": "int"}])
    inp = mapping.Inputs([mapping.SourceColumn("dbo.Client", "ClientName", "nvarchar", 100, True, 1),
                          mapping.SourceColumn("dbo.Client", "Legacy", "int", None, True, 2)], [tgt],
                         precedents={"dbo.client.clientname": [{"target": {"column": "ClientName"}}]})
    items, summary = mapping.propose(inp)
    by = {i.key: i for i in items}
    assert by["dbo.client.clientname"].confidence == 1.0 and by["dbo.client.clientname"].status == "proposed"
    assert any("earlier decision" in e for e in by["dbo.client.clientname"].evidence)
    assert by["dbo.client.legacy"].status == "in_review" and by["dbo.client.legacy"].review
    assert summary["columns"] == 2


def _pdf(text_: str, fields: list[str] | None = None) -> bytes:
    """A minimal valid PDF with one page of text and optional text fields."""
    stream = zlib.compress(f"BT /F1 12 Tf 72 720 Td ({text_}) Tj ET".encode())
    objs = [b"<< /Type /Catalog /Pages 2 0 R" + (b" /AcroForm 6 0 R" if fields else b"") + b" >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length " + str(len(stream)).encode() + b" /Filter /FlateDecode >>\nstream\n" + stream
            + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    if fields:
        objs.append(b"<< /Fields [" + b" ".join(f"{7 + i} 0 R".encode() for i in range(len(fields))) + b"] >>")
        objs += [f"<< /FT /Tx /T ({f}) /Rect [0 0 1 1] >>".encode() for f in fields]
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, start=1):
        offs.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offs)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return out


def test_form_parity_compares_pages_text_and_fields() -> None:
    golden = _pdf("Declarations page", ["insured_name", "policy_no"])
    assert parity.compare(_pdf("Declarations page", ["insured_name", "policy_no"]), golden)["passed"]
    worse = parity.compare(_pdf("Declarations pg", ["insured_name"]), golden)
    assert not worse["passed"] and any("policy_no" in d for d in worse["differences"])
    assert any("text differs" in d for d in worse["differences"])
    with pytest.raises(parity.ParityError):
        parity.read(b"not a pdf")


def test_generated_code_is_tested_on_sql_server() -> None:
    try:
        wb = Workbench()
    except WorkbenchBlocked as e:
        pytest.skip(str(e))
    try:
        cols = [{"name": "NoteID", "type": "int", "nullable": False}, {"name": "Body", "type": "nvarchar"}]
        keyed = build.run_code(wb, build.udt("cust.x_user_notes", cols, ["NoteID"]))
        assert all(r["passed"] for r in keyed), keyed
        unkeyed = build.run_code(wb, build.udt("cust.x_user_notes", cols, []))
        assert not all(r["passed"] for r in unkeyed)
        g = build.transformation(
            "dbo.Src", "dbo.Tgt",
            [{"source": {"table": "dbo.Src", "column": "A", "type": "int", "ordinal": 1},
              "target": {"table": "dbo.Tgt", "column": "Aa", "type": "nvarchar(10)"}}],
            [{"name": "A", "type": "int", "nullable": True, "ordinal": 1}],
            [{"name": "Aa", "type": "nvarchar(10)"}, {"name": "Req", "type": "int", "nullable": False}],
            [{"A": 5}])
        res = build.run_transformation(wb, g)
        assert not all(r["passed"] for r in res)  # Req is required and unmapped
        assert any("Req" in (r["detail"] or "") for r in res)
    finally:
        wb.close()
