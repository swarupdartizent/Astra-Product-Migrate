"""I10 loads, validation, reconciliation, documents, parity and coexistence, end to end on the fixture estate.

Approved transformation code runs on SQL Server; a fake target accepts or rejects records over HTTP. The fixture
holds real problems: order 11 ships before it was ordered, order 12's total is one cent more than its lines, one
document links to an order that does not exist, and one customer name is refused by the target."""

from __future__ import annotations

import base64
import json
import threading
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar

import pytest
import yaml
from sqlalchemy import create_engine, text

from astra_migrate.config import get_settings
from astra_migrate.db.control import session_scope
from astra_migrate.db.models import Tenant
from astra_migrate.design.parity import compare as form_compare
from astra_migrate.loads import coexistence, parity, validate
from astra_migrate.planning import store
from tests.conftest import wait_job
from tests.test_adapters_ontology import _connection, _reader, _run, bundle, domain_manifest, target_manifest
from tests.test_design import BASELINE, DESIGN, _pdf
from tests.test_discovery import AS_OF
from tests.test_planning_api import SRC, _blueprint, _ensure_published, setup  # noqa: F401

pytestmark = pytest.mark.integration
H = dict[str, str]
RUN = uuid.uuid4().hex[:6]
LTARGET = f"fixture-load-target-{RUN}"


class _Target(BaseHTTPRequestHandler):
    received: ClassVar[list[dict[str, Any]]] = []

    def _send(self, code: int, body: Any) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        raw = self.rfile.read(int(self.headers.get("content-length", "0"))).decode()
        if self.path == "/oauth/token":
            self._send(200, {"access_token": "tok-load", "expires_in": 300})
            return
        if self.headers.get("authorization") != "Bearer tok-load":
            self._send(401, {})
            return
        body = json.loads(raw)
        _Target.received.append({"path": self.path, **body})
        if "NOT-A-NAME" in raw:
            self._send(422, {"error": "Customer names may not contain digits."})
        else:
            self._send(201, {"ok": True})

    def do_GET(self) -> None:
        self._send(404, {"error": "no such document"})

    def log_message(self, *args: Any) -> None:
        pass


def _load_target(port: int) -> dict[str, Any]:
    m = target_manifest(port)
    m["name"] = LTARGET
    m["content"]["design"] = DESIGN
    m["content"]["load"]["endpoints"] = [
        {"entity": "customer", "method": "POST", "path": "/api/customers", "table": "dbo.Customer"},
        {"entity": "order", "method": "POST", "path": "/api/orders", "table": "dbo.Orders"},
        {"entity": "order_line", "method": "POST", "path": "/api/lines", "table": "dbo.OrderLine"}]
    m["content"]["documents"] = {"read_path": "/documents/{key}", "source": {"reference": "fixture"},
                                 "confidence": "confirmed"}
    return m


def _baseline() -> dict[str, Any]:
    b = json.loads(json.dumps(BASELINE))
    for o in b["objects"]:
        for c in o["columns"]:
            if c["name"] == "Name":
                c["type"] = "nvarchar(100)"
    return b


def _prepare(client: Any, admin: H, tenant_factory: Any, user_factory: Any, setup: dict[str, Any],  # noqa: F811
             port: int) -> dict[str, Any]:
    _ensure_published(client, admin, LTARGET, "1.0.0", bundle(_load_target(port)))
    if client.get(f"/api/v1/packs/{domain_manifest()['name']}/1.0.0", headers=admin).status_code == 404:
        client.post("/api/v1/packs", headers=admin, json=bundle(domain_manifest()))
    tenant = tenant_factory()
    proj = client.post(f"/api/v1/tenants/{tenant['id']}/projects", headers=admin, json={"name": "Loads"}).json()
    pid = proj["id"]
    bp = _blueprint("parallel_run")
    bp["domain_packs"] = [f"{domain_manifest()['name']}@1.0.0"]
    bp["documents"] = {"retrieval_sample_size": 2}
    assert client.post(f"/api/v1/projects/{pid}/blueprint/versions", headers=admin,
                       json={"content": bp, "message": "Loads fixture"}).status_code in (200, 201)
    user, pw = _reader(setup["database"])
    conn = _connection(client, admin, tenant, setup["database"], user, pw, "load-src", adapter=f"{SRC}@1.0.0")
    assert _run(client, admin, conn["id"], "check")["run"]["status"] == "succeeded"
    wait_job(client, admin, client.post(f"/api/v1/projects/{pid}/discovery-runs", headers=admin, json={
        "connection_id": conn["id"], "as_of": AS_OF.isoformat()}).json()["job_id"], timeout_s=180)
    b = client.post("/api/v1/target-baselines", headers=admin, json={
        "adapter_name": LTARGET, "name": f"load {uuid.uuid4().hex[:6]}", "baseline_yaml": yaml.safe_dump(_baseline()),
        "synthetic": True})
    assert client.put(f"/api/v1/projects/{pid}/baseline", headers=admin,
                      json={"baseline_id": b.json()["id"], "reason": "load test"}).status_code == 200
    wait_job(client, admin, client.post(f"/api/v1/projects/{pid}/delta-runs", headers=admin,
                                        json={"connection_id": conn["id"]}).json()["job_id"], timeout_s=120)
    sme_h, _ = user_factory(("data_sme", "project", pid))
    arch_h, _ = user_factory(("solution_architect", "project", pid))
    owner_h, owner_id = user_factory(("customer_data_owner", "project", pid))
    wait_job(client, admin, client.post(f"/api/v1/projects/{pid}/design-runs", headers=admin,
                                        json={"connection_id": conn["id"]}).json()["job_id"], timeout_s=180)
    items = client.get(f"/api/v1/projects/{pid}/design/items", headers=sme_h,
                       params={"stream": "mapping", "limit": 500}).json()["items"]
    ship = next(i for i in items if i["key"] == "dbo.orders.shipdate")
    client.post(f"/api/v1/review-items/{ship['review_item_id']}/decide", headers=sme_h, json={
        "action": "change", "note": "Shipping date was renamed in the new version.",
        "changed_value": "dbo.Orders.ShippedOn"})
    keys = [i["key"] for i in items if i["status"] == "proposed"
            and i["key"].startswith(("dbo.orders.", "dbo.customer.", "dbo.orderline."))]
    ok = client.post(f"/api/v1/projects/{pid}/design/decisions", headers=sme_h, json={
        "stream": "mapping", "keys": keys, "action": "approve", "reason": "Checked against the new model."})
    assert ok.status_code == 200, ok.text
    bj = wait_job(client, admin, client.post(f"/api/v1/projects/{pid}/build", headers=admin).json()["job_id"],
                  timeout_s=240)
    if bj["status"] == "failed" and "workbench" in (bj.get("error") or "").lower():
        pytest.skip(f"SQL Server workbench unavailable: {bj.get('error')}")
    arts = client.get(f"/api/v1/projects/{pid}/build-artifacts", headers=arch_h,
                      params={"kind": "transformation"}).json()
    assert {a["status"] for a in arts} == {"tests_passed"}, arts
    for a in arts:
        assert client.post(f"/api/v1/build-artifacts/{a['id']}/approve", headers=arch_h,
                           json={"note": "Tests pass on the workbench."}).status_code == 200
    ext = _run(client, admin, conn["id"], "extract", "full")
    assert ext["run"]["status"] == "succeeded", ext
    client.post(f"/api/v1/tenants/{tenant['id']}/secrets", headers=admin,
                json={"name": "load-target-secret", "description": "test", "value": "s3cret-load"})
    tc = client.post(f"/api/v1/tenants/{tenant['id']}/target-connections", headers=admin, json={
        "name": "load-target", "adapter": f"{LTARGET}@1.0.0", "base_url": f"http://127.0.0.1:{port}",
        "client_id": "astra", "client_secret_ref": "secret://load-target-secret"})
    assert tc.status_code == 201, tc.text
    return {"tenant": tenant, "pid": pid, "conn": conn["id"], "extract": ext["run"]["id"], "target": tc.json()["id"],
            "sme": sme_h, "owner": owner_h, "owner_id": owner_id, "arts": arts}


def _start(client: Any, h: H, pid: str, **body: Any) -> dict[str, Any]:
    r = client.post(f"/api/v1/projects/{pid}/load-runs", headers=h, json=body)
    assert r.status_code == 201, r.text
    job = wait_job(client, h, r.json()["job_id"], timeout_s=240)
    assert job["status"] == "succeeded", job
    return dict(client.get(f"/api/v1/load-runs/{r.json()['id']}", headers=h).json())


def test_loads_validation_reconciliation_and_coexistence(client: Any, admin: H, tenant_factory: Any,
                                                         user_factory: Any, setup: dict[str, Any]) -> None:  # noqa: F811
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Target)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        _flow(client, admin, tenant_factory, user_factory, setup, srv.server_port)
    finally:
        srv.shutdown()


def _flow(client: Any, admin: H, tenant_factory: Any, user_factory: Any, setup: dict[str, Any],  # noqa: F811
          port: int) -> None:
    f = _prepare(client, admin, tenant_factory, user_factory, setup, port)
    pid, base = f["pid"], f"/api/v1/projects/{f['pid']}"

    # ---- a rehearsal: transform, validate and reconcile without sending anything
    before = len(_Target.received)
    r1 = _start(client, admin, pid, kind="rehearsal", extract_run_id=f["extract"])
    assert r1["number"] == 1 and len(_Target.received) == before
    assert {a["digest"] for a in r1["artifacts"]} == {a["digest"] for a in f["arts"]}
    orders = r1["summary"]["tables"]["dbo.orders"]
    assert orders["source"] == 3 and orders["transformed"] == 3 and orders["accepted"] == 1
    errs = client.get(f"/api/v1/load-runs/{r1['id']}/records", headers=admin).json()
    bad = {i["key"]: i for i in errs["items"]}
    assert bad["11"]["status"] == "invalid" and bad["11"]["failures"][0]["rule"] == "FX-ORDER-DATES"
    assert "ships on or after" in bad["11"]["reason"] and bad["11"]["failures"][0]["fix"]
    assert bad["12"]["failures"][0]["rule"] == "FX-ORDER-TOTAL" and "15.00" in bad["12"]["reason"]
    measures = {m["column"]: m for m in r1["summary"]["measures"] if m["table"] == "dbo.orders"}
    assert measures["Total"]["source"] == "65.01" and measures["Total"]["accepted"] == "30.00"
    assert r1["summary"]["dq"]["dbo.orders"]["after"] == pytest.approx(33.3)
    breaks = client.get(f"{base}/recon-breaks", headers=admin, params={"load_run_id": r1["id"]}).json()
    assert any(b["measure"] == "Total" and b["difference"] == "-35.01" for b in breaks)
    assert all(b["owner_user_id"] == f["owner_id"] for b in breaks)  # the project's single data owner

    # ---- the same pinned inputs give the same result
    r2 = _start(client, admin, pid, kind="rehearsal", extract_run_id=f["extract"])
    assert r2["input_digest"] == r1["input_digest"] and r2["summary"]["repeat_of"] == {"run": 1, "same_result": True}

    # ---- a real load: the target's reasons land in the error queue
    r3 = _start(client, admin, pid, kind="load", extract_run_id=f["extract"], target_connection_id=f["target"])
    queue = {(i["table"], i["key"]): i for i in client.get(f"/api/v1/load-runs/{r3['id']}/records",
                                                           headers=admin).json()["items"]}
    cust = queue[("dbo.customer", "3")]
    assert cust["status"] == "rejected" and cust["http_status"] == 422 and "digits" in cust["reason"]
    assert queue[("dbo.orders", "11")]["status"] == "invalid"
    sent = [x for x in _Target.received if x["path"] == "/api/orders"]
    assert [x["OrderID"] for x in sent] == [10]
    # fix order 11 in the queue and reload it alone
    fixed = {**queue[("dbo.orders", "11")]["payload"], "ShippedOn": "2026-02-06"}
    assert client.patch(f"/api/v1/load-runs/{r3['id']}/records", headers=f["sme"], json={
        "table": "dbo.orders", "key": "11", "owner": "Data SME", "triage": "fixed",
        "fixed_payload": fixed}).status_code == 200
    rl = client.post(f"/api/v1/load-runs/{r3['id']}/reload", headers=admin,
                     json={"records": [{"table": "dbo.orders", "key": "11"}]})
    assert rl.status_code == 201, rl.text
    job = wait_job(client, admin, rl.json()["job_id"], timeout_s=240)
    assert job["status"] == "succeeded", job
    r4 = client.get(f"/api/v1/load-runs/{rl.json()['id']}", headers=admin).json()
    assert r4["kind"] == "reload" and r4["summary"]["counts"] == {"loaded": 1}
    assert [x["OrderID"] for x in _Target.received if x["path"] == "/api/orders"] == [10, 11]

    # ---- a second load skips records the target already holds unchanged; a delta load sends only changes
    r5 = _start(client, admin, pid, kind="load", extract_run_id=f["extract"], target_connection_id=f["target"])
    assert r5["summary"]["counts"].get("unchanged", 0) >= 3
    delta = _run(client, admin, f["conn"], "extract", "delta")
    n = len(_Target.received)
    r6 = _start(client, admin, pid, kind="delta", extract_run_id=delta["run"]["id"],
                target_connection_id=f["target"])
    assert len(_Target.received) == n and r6["summary"]["counts"] == {}
    assert client.post(f"{base}/load-runs", headers=admin, json={
        "kind": "delta", "extract_run_id": f["extract"], "target_connection_id": f["target"]}).status_code == 422

    # ---- documents: every link checked, a repeatable sample read back
    docs = client.post(f"/api/v1/load-runs/{r3['id']}/document-checks", headers=admin).json()
    assert docs["documents"] == 3 and docs["broken_links"] == 1 and docs["sample_size"] == 2
    assert docs["sample"].get("missing") == 2 and not docs["passed"]
    listed = client.get(f"/api/v1/load-runs/{r3['id']}/document-checks", headers=admin,
                        params={"status": "broken"}).json()["items"]
    assert listed[0]["entity"] == "order" and listed[0]["link_key"] == "99"

    # ---- breaks have an owner until closed with a reason
    b = next(x for x in client.get(f"{base}/recon-breaks", headers=admin,
                                   params={"load_run_id": r3["id"], "status": "open"}).json())
    short = client.patch(f"/api/v1/recon-breaks/{b['id']}", headers=f["owner"], json={"close_reason": "ok"})
    assert short.status_code == 422
    closed = client.patch(f"/api/v1/recon-breaks/{b['id']}", headers=f["owner"],
                          json={"close_reason": "Explained by the rejected records, which are being fixed."})
    assert closed.status_code == 200 and closed.json()["status"] == "closed" and closed.json()["closed_by"]

    # ---- the database runs only approved code, and keeps a run's inputs fixed
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        with pytest.raises(Exception, match="only approved code"), eng.begin() as c:
            c.execute(text("INSERT INTO load_runs(id, tenant_id, project_id, number, kind, artifacts, packs, "
                           "input_digest, status, requested_by) VALUES (:i, :t, :p, 99, 'rehearsal', :a, '{}', 'x', "
                           "'queued', '{}')"),
                      {"i": str(uuid.uuid4()), "t": f["tenant"]["id"], "p": pid,
                       "a": json.dumps([{"id": str(uuid.uuid4()), "digest": "x"}])})
        with pytest.raises(Exception, match="pins its inputs"), eng.begin() as c:
            c.execute(text("UPDATE load_runs SET segment = '{}' WHERE id = :i"), {"i": r1["id"]})
    finally:
        eng.dispose()

    # ---- daily coexistence reconciliation: breaks to a named owner, one open row per problem
    with session_scope() as s:
        t = s.get(Tenant, uuid.UUID(f["tenant"]["id"]))
        assert t is not None
        s.expunge(t)
    with store.connect(t) as tc, tc.transaction():
        store.put(tc, uuid.UUID(pid), "coexistence", "order:W1", {
            "entity": "order", "wave": "W1", "system_of_record": "source", "end_date": "2027-03-31",
            "exit_reconciliation": "Orders reconcile by count and total."}, "test")
    sch = client.put(f"{base}/coexistence-schedule", headers=admin, json={
        "connection_id": f["conn"], "owner_user_id": f["owner_id"], "hour_utc": 6})
    assert sch.status_code == 200 and sch.json()["owner_user_id"] == f["owner_id"]
    for _ in range(2):
        j = wait_job(client, admin, client.post(f"{base}/coexistence-reconcile", headers=admin).json()["job_id"])
        assert j["status"] == "succeeded", j
    dash = client.get(f"{base}/coexistence", headers=admin).json()
    open_b = {b["measure"]: b for b in dash["open_breaks"]}
    assert Decimal(open_b["record count"]["source_value"]) == 3
    assert Decimal(open_b["record count"]["target_value"]) == 2
    assert open_b["Total"]["difference"] == "-15.01" and open_b["Total"]["owner_user_id"] == f["owner_id"]
    assert len(dash["open_breaks"]) == 2  # the second run updated the same rows
    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        with eng.begin() as c:
            c.execute(text("UPDATE coexistence_schedules SET next_run_at = now() - interval '1 minute' "
                           "WHERE project_id = :p"), {"p": pid})
    finally:
        eng.dispose()
    assert coexistence.tick() >= 1


def test_parity_runs_explain_and_record_approvals(client: Any, admin: H, tenant_factory: Any,
                                                  user_factory: Any) -> None:
    t = tenant_factory()
    pid = client.post(f"/api/v1/tenants/{t['id']}/projects", headers=admin, json={"name": "Parity"}).json()["id"]
    tester, _ = user_factory(("test_engineer", "project", pid))

    def f(name: str, rows: list[dict[str, Any]]) -> dict[str, str]:
        return {"name": name, "content_base64": base64.b64encode(json.dumps(rows).encode()).decode()}

    src = [{"policy": "P1", "state": "TX", "premium": "1000.00"}, {"policy": "P2", "state": "CA", "premium": "500.10"}]
    tgt = [{"policy": "P1", "state": "TX", "premium": "1000.00"}, {"policy": "P2", "state": "CA", "premium": "500.11"}]
    r = client.post(f"/api/v1/projects/{pid}/parity-runs", headers=admin, json={
        "kind": "rating", "name": "Re-rate sample", "source": f("src.json", src), "target": f("tgt.json", tgt),
        "spec": {"keys": ["policy"], "fields": [{"name": "premium", "type": "money"}], "inputs": ["state"]}})
    assert r.status_code == 201, r.text
    run = r.json()
    assert not run["summary"]["passed"] and run["summary"]["totals"]["premium"]["difference"] == "0.01"
    cases = client.get(f"/api/v1/parity-runs/{run['id']}/cases", headers=tester).json()
    p2 = next(c for c in cases["items"] if c["key"] == "P2")
    assert p2["source_value"] == "500.10" and p2["target_value"] == "500.11" and p2["inputs"] == {"state": "CA"}
    assert any(c["key"] == "TOTAL" for c in cases["items"])
    d = client.post(f"/api/v1/parity-runs/{run['id']}/cases/decide", headers=tester, json={
        "cases": [{"key": c["key"], "field": c["field"]} for c in cases["items"]], "action": "approve",
        "note": "Rounding rule changed in the new rating engine; agreed with underwriting."}).json()
    assert d["passed"] and d["open"] == 0
    after = client.get(f"/api/v1/parity-runs/{run['id']}/cases", headers=tester).json()["items"]
    assert all(c["decided_by"] and c["status"] == "approved" for c in after)
    dup = client.post(f"/api/v1/projects/{pid}/parity-runs", headers=admin, json={
        "kind": "report", "name": "Duplicate keys", "source": f("s.json", src + src), "target": f("t.json", tgt),
        "spec": {"keys": ["policy"], "fields": [{"name": "premium", "type": "money"}]}})
    assert dup.status_code == 422


# ------------------------------------------------------------------ rules (unit)

def test_validation_explains_rule_record_and_fix() -> None:
    ctx = validate.Context({"dbo.t": {"code": {"name": "Code", "type": "nvarchar(3)", "nullable": False},
                                      "amt": {"name": "Amt", "type": "decimal(5,2)"}}}, {"dbo.t": ["Id"]},
                           relations=[validate.Relation("dbo.t", "ParentId", "dbo.p", "Id", "parent")],
                           known_keys={"dbo.p": {"1"}})
    fails = validate.run(ctx, {"dbo.t": [{"Id": 1, "Code": "ABCD", "Amt": Decimal("1.234"), "ParentId": 2},
                                         {"Id": 2, "Code": None, "Amt": Decimal("1.00"), "ParentId": 1}]})
    one = {f.rule for f in fails[("dbo.t", "1")]}
    assert one == {"STRUCT-LENGTH", "STRUCT-SCALE", "REF-PARENT"}
    assert all(f.fix for f in fails[("dbo.t", "1")])
    assert [f.rule for f in fails[("dbo.t", "2")]] == ["STRUCT-REQUIRED"]


def test_parity_compares_money_to_the_cent() -> None:
    spec = parity.Spec(keys=["k"], fields=[parity.FieldSpec(name="v", type="money"),
                                           parity.FieldSpec(name="route", type="text")])
    cases, summary = parity.compare("workflow", spec, [{"k": "1", "v": "1.004", "route": "A"},
                                                       {"k": "2", "v": "1", "route": "B"}],
                                    [{"k": "1", "v": "1.00", "route": "A"}, {"k": "3", "v": "1", "route": "B"}])
    assert [(c.key, c.kind) for c in cases] == [("2", "missing_in_target"), ("3", "missing_in_source")]
    assert summary["cases"] == 3


def test_form_layout_differences_are_separate_from_content() -> None:
    golden = _pdf("Schedule", ["a"])
    res = form_compare(golden.replace(b"612 792", b"595 842"), golden)
    assert res["layout_only"] and res["layout_differences"] and not res["content_differences"]
    content = form_compare(_pdf("Schedul", ["a"]), golden)
    assert content["content_differences"] and not content["layout_only"]


def test_schedule_runs_once_a_day_at_its_hour() -> None:
    now = datetime(2026, 11, 18, 7, 30, tzinfo=UTC)
    assert coexistence.next_run(6, now) == now.replace(hour=6, minute=0) + timedelta(days=1)
    assert coexistence.next_run(9, now) == now.replace(hour=9, minute=0)
