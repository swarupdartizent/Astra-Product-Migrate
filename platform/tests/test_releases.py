"""I13 release gate: golden suites scored by the platform's own engines across mapping, configuration, code,
planning, compliance and review; a release is blocked when any measure falls below the previous release."""

from __future__ import annotations

import copy
import json
import pathlib
import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine, text

from astra_migrate.config import get_settings
from astra_migrate.evaluation import __main__ as cli
from astra_migrate.evaluation import engine

H = dict[str, str]


def test_suites_cover_every_area_with_measures_between_0_and_1() -> None:
    card = engine.run()
    assert card["suites"]
    for suite in card["suites"].values():
        areas = {m.split(".", 1)[0] for m in suite["measures"]}
        assert areas == {"mapping", "configuration", "code", "planning", "compliance", "review"}
        assert all(0.0 <= v <= 1.0 for v in suite["measures"].values())


def test_the_current_code_passes_the_committed_baseline() -> None:
    """The release gate itself, run as a test: nothing may fall below the last recorded release."""
    baseline = json.loads(cli.DEFAULT_BASELINE.read_text(encoding="utf-8"))
    res = engine.compare(baseline, engine.run())
    assert res["passed"], res["regressions"]


def test_compare_finds_falls_disappearances_and_missing_suites() -> None:
    base = {"suites": {"s": {"digest": "a", "measures": {"m.x": 0.9, "m.y": 0.5, "m.z": 1.0}},
                       "gone": {"digest": "b", "measures": {"m.x": 1.0}}}}
    cur = {"suites": {"s": {"digest": "a2", "measures": {"m.x": 0.8, "m.y": 0.6}}}}
    res = engine.compare(base, cur)
    kinds = {(r["suite"], r["measure"]) for r in res["regressions"]}
    assert kinds == {("s", "m.x"), ("s", "m.z"), ("gone", None)} and not res["passed"]
    assert res["improved"] == [{"suite": "s", "measure": "m.y", "baseline": 0.5, "current": 0.6}]
    assert res["changed_suites"] == ["s"]
    assert engine.compare(None, cur)["passed"]  # the first release has nothing to fall below
    assert engine.compare(cur, copy.deepcopy(cur))["passed"]


def test_cli_gate_blocks_a_regression(tmp_path: pathlib.Path) -> None:
    card = engine.run()
    worse = copy.deepcopy(card)
    suite = next(iter(worse["suites"].values()))
    suite["measures"]["mapping.top1_accuracy"] = 1.01  # a baseline better than today: today regresses
    f = tmp_path / "baseline.json"
    f.write_text(json.dumps(worse), encoding="utf-8")
    assert cli.main(["gate", "--baseline", str(f)]) == 1
    assert cli.main(["record", "--release", "x", "--reason", "should be refused", "--baseline", str(f)]) == 1
    f.write_text(json.dumps(card), encoding="utf-8")
    assert cli.main(["gate", "--baseline", str(f)]) == 0
    assert cli.main(["record", "--release", "next", "--reason", "Scorecard after the I13 work.",
                     "--baseline", str(f)]) == 0
    assert json.loads(f.read_text(encoding="utf-8"))["release"] == "next"


@pytest.mark.integration
def test_api_records_released_and_blocked_releases(client: Any, admin: H, monkeypatch: pytest.MonkeyPatch) -> None:
    name = f"r-{uuid.uuid4().hex[:8]}"
    ok = client.post("/api/v1/releases", headers=admin, json={"name": name, "reason": "Release gate test run."})
    assert ok.status_code == 201, ok.text
    first = ok.json()
    assert first["status"] == "released" and first["regressions"] == [], first
    assert client.post("/api/v1/releases", headers=admin,
                       json={"name": name, "reason": "Release gate test run."}).status_code == 409

    real = engine.run
    def degraded() -> dict[str, Any]:
        card = real()
        for s in card["suites"].values():
            s["measures"]["review.order_agreement"] = 0.5
        return card
    from astra_migrate.api.routes import releases as routes

    monkeypatch.setattr(routes.engine, "run", degraded)
    bad = client.post("/api/v1/releases", headers=admin,
                      json={"name": f"{name}-b", "reason": "A release whose queue order got worse."})
    assert bad.status_code == 201 and bad.json()["status"] == "blocked"
    assert bad.json()["baseline_release"] == name
    assert {r["measure"] for r in bad.json()["regressions"]} == {"review.order_agreement"}
    prev = client.get("/api/v1/releases/evaluation", headers=admin).json()
    assert prev["passed"] is False and prev["baseline_release"] == name
    listed = client.get("/api/v1/releases", headers=admin).json()["releases"]
    assert [r["name"] for r in listed[:2]] == [f"{name}-b", name]

    eng = create_engine(get_settings().control_db_url.get_secret_value())
    try:
        # the app role cannot update releases at all, and a trigger refuses updates for every other role
        with pytest.raises(Exception, match="append-only|permission denied"), eng.begin() as c:
            c.execute(text("UPDATE releases SET status = 'released' WHERE name = :n"), {"n": f"{name}-b"})
        with pytest.raises(Exception, match="ck_release_no_regressions"), eng.begin() as c:
            c.execute(text("INSERT INTO releases(id, name, status, scorecard, regressions, improved, reason, "
                           "recorded_by) SELECT :i, 'x-bad', 'released', '{}', '[{\"m\": 1}]', '[]', "
                           "'forced through the back door', id FROM users WHERE kind = 'person' LIMIT 1"),
                      {"i": str(uuid.uuid4())})
    finally:
        eng.dispose()
