"""Live agent tests: real model calls through the gateway (E02.F1.S2, E02.F1.S1, E02.F1.S3, E02.F2.S1).

Run only when ANTHROPIC_API_KEY is set. They spend real tokens (a few cents per run). Without a key they
are skipped with that reason; nothing is simulated.
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import pytest

from tests.conftest import wait_job

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"),
                       reason="ANTHROPIC_API_KEY is not set: live model tests need a real key"),
]
H = dict[str, str]


@pytest.fixture(scope="module")
def reasoning_alias(client: Any, admin: H) -> dict[str, Any]:
    name = f"Anthropic live test {uuid.uuid4().hex[:6]}"
    p = client.post("/api/v1/models/providers", headers=admin, json={
        "name": name, "kind": "anthropic", "no_training_terms": True,
        "terms_reference": "Anthropic commercial terms: customer content is not used for training"}).json()
    c = client.put(f"/api/v1/models/providers/{p['id']}/credential", headers=admin,
                   json={"api_key": os.environ["ANTHROPIC_API_KEY"]})
    assert c.status_code == 200
    chk = client.post(f"/api/v1/models/providers/{p['id']}/check", headers=admin).json()
    assert chk["check_status"] == "ok", chk["check_detail"]
    body = {k: chk[k] for k in ("name", "kind", "endpoint", "no_training_terms", "terms_reference")}
    assert client.put(f"/api/v1/models/providers/{p['id']}", headers=admin,
                      json={**body, "enabled": True}).status_code == 200
    a = client.put("/api/v1/models/aliases/reasoning", headers=admin,
                   json={"provider_id": p["id"], "model": "claude-opus-5-5", "reason": "live test"})
    assert a.status_code == 200
    return dict(a.json())


def test_orchestrator_suite_passes_with_a_real_model_then_release_pin_and_run(
        client: Any, admin: H, tenant_factory: Any, reasoning_alias: dict[str, Any]) -> None:
    client.post("/api/v1/agents/catalog/import", headers=admin)
    v = client.get("/api/v1/agents/orchestrator/versions/1.0.0", headers=admin).json()
    if v["status"] == "draft":
        run = client.post("/api/v1/agents/orchestrator/versions/1.0.0/tests", headers=admin).json()
        assert wait_job(client, admin, run["job_id"], timeout_s=600)["status"] == "succeeded"
        tr = client.get(f"/api/v1/agent-test-runs/{run['id']}", headers=admin).json()
        assert tr["status"] == "passed", [(c["name"], c["status"], c["detail"]) for c in tr["results"]]
        model_cases = [c for c in tr["results"] if c["kind"] == "model"]
        assert model_cases and all(c["models"] for c in model_cases)
        injected = next(c for c in model_cases if c["name"] == "ignores instructions inside legacy text")
        assert injected["screening"][0]["flagged"] is True
        assert "update_stage" not in injected["tools_called"]
        rel = client.post("/api/v1/agents/orchestrator/versions/1.0.0/release", headers=admin,
                          json={"note": "Suite passed against the live model in CI."})
        assert rel.status_code == 200, rel.text

    t = tenant_factory()
    p = client.post(f"/api/v1/tenants/{t['id']}/projects", headers=admin, json={"name": "Live run"}).json()
    pin = client.put(f"/api/v1/projects/{p['id']}/agents/orchestrator", headers=admin,
                     json={"version": "1.0.0", "reason": "live test"})
    assert pin.status_code == 200
    run = client.post(f"/api/v1/projects/{p['id']}/agent-runs", headers=admin, json={
        "agent": "orchestrator", "objective": "Tell me where this project stands and ask the right person for "
                                              "anything that blocks progress."})
    assert run.status_code == 202, run.text
    job = wait_job(client, admin, run.json()["job_id"], timeout_s=600)
    detail = client.get(f"/api/v1/agent-runs/{run.json()['id']}", headers=admin).json()
    assert job["status"] == "succeeded", (job, detail["status_detail"])
    assert detail["output"] and detail["model_calls"] >= 1 and detail["denied_tool_calls"] == 0
    calls = client.get("/api/v1/models/calls", headers=admin, params={"agent_run_id": run.json()["id"]}).json()
    assert calls and all(c["served_model"] and c["api_version"] for c in calls)
    assert any(e["kind"] == "tool_call" and e["payload"]["name"] == "get_project_status" for e in detail["events"])
