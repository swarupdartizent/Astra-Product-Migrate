"""Release evaluation (E22.F1.S2): every golden suite is run through the platform's own engines and scored against
its known answers, giving one scorecard of measures between 0 and 1 (higher is better). The release gate blocks a
release when any measure of any suite falls below the previous release's scorecard, or disappears.

Areas and measures:
- mapping: top-1 accuracy; precision of the proposals that skip review; recall of wrong proposals sent to review
- configuration: accuracy of the target area, retirement or block decided for each item
- code: accuracy of the review routing, and of the converted text where conversion is automatic
- planning: accuracy of proposed dispositions; recall and precision of dependency cycles found
- compliance: accuracy of compliance level and of required approvers per subject type
- review: pairwise agreement of the queue order with the expected order; agreement of precedent grouping

Suites live in `testkit/evaluation/<name>/suite.yaml`. They are synthetic test assets with known answers, never
customer data. The engines run without a database, so the gate runs in CI.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import pathlib
from datetime import UTC, datetime
from typing import Any

import yaml

from astra_migrate.adapters.contract import TargetDesign
from astra_migrate.conversion import sqlanywhere
from astra_migrate.db.models import ReviewItem
from astra_migrate.design import mapping, streams
from astra_migrate.planning import deps, scope
from astra_migrate.review import service as reviews

FORMAT = "astra.evaluation/v1"
ENGINE_FILES = ["design/mapping.py", "design/streams.py", "conversion/sqlanywhere.py", "planning/scope.py",
                "planning/deps.py", "review/service.py", "evaluation/engine.py"]
SRC = pathlib.Path(__file__).resolve().parents[1]
EPSILON = 1e-9


def _ratio(n: int, d: int) -> float:
    return round(n / d, 4) if d else 1.0


# ------------------------------------------------------------------ areas

def score_mapping(spec: dict[str, Any]) -> dict[str, float]:
    inp = mapping.Inputs(
        [mapping.SourceColumn(c["table"], c["name"], c["type"], c.get("max_length"), c.get("nullable", True),
                              c.get("ordinal", i + 1)) for i, c in enumerate(spec["columns"])],
        [mapping.TargetTable(t.get("schema", "dbo"), t["name"], t["columns"], t.get("concept"))
         for t in spec["targets"]],
        {k.lower(): v.lower() for k, v in (spec.get("delta_tables") or {}).items()},
        {k.lower(): v for k, v in (spec.get("entities") or {}).items()},
        {k.lower(): v for k, v in (spec.get("precedents") or {}).items()},
        None, float(spec.get("threshold", mapping.DEFAULT_THRESHOLD)))
    items, _ = mapping.propose(inp)
    expected = {k.lower(): (v.lower() if v else None) for k, v in spec["expected"].items()}
    got = {i.key: (f"{i.target['table']}.{i.target['column']}".lower() if i.target else None) for i in items}
    right = {k for k in expected if got.get(k) == expected[k]}
    auto = [i for i in items if i.key in expected and i.status == "proposed"]
    wrong = [i for i in items if i.key in expected and i.key not in right]
    return {"mapping.top1_accuracy": _ratio(len(right), len(expected)),
            "mapping.auto_precision": _ratio(sum(1 for i in auto if i.key in right), len(auto)),
            "mapping.review_recall": _ratio(sum(1 for i in wrong if i.status == "in_review"), len(wrong))}


def score_configuration(spec: dict[str, Any]) -> dict[str, float]:
    inp = streams.Inputs(
        TargetDesign.model_validate(spec["design"]),
        [streams.Obj(o["type"], o["name"], o.get("schema"), o.get("detail") or {}) for o in spec.get("objects", [])],
        [streams.Config(c["kind"], c["key"], c["name"], c.get("scope"), json.dumps(c["definition"])
                        if not isinstance(c["definition"], str) else c["definition"], c.get("depends_on") or [])
         for c in spec["items"]], [], None, [], [], set(), [], [])
    out = {}
    for it in streams.configuration(inp):
        t = it.target or {}
        out[it.key] = "blocked" if it.status == "blocked" else "retire" if t.get("retire") else f"area:{t.get('area')}"
    exp = {k.lower(): v for k, v in spec["expected"].items()}
    return {"configuration.accuracy": _ratio(sum(1 for k, v in exp.items() if out.get(k) == v), len(exp))}


def score_code(spec: dict[str, Any]) -> dict[str, float]:
    routed = text = auto = 0
    for c in spec["cases"]:
        res = sqlanywhere.convert(c["kind"], c["name"], c["sql"])
        if bool(res.needs_review) == bool(c["review"]):
            routed += 1
        if not c["review"]:
            auto += 1
            conv = (res.converted or "").lower()
            if not res.needs_review and all(f.lower() in conv for f in c.get("contains", [])) \
                    and not any(f.lower() in conv for f in c.get("absent", [])):
                text += 1
    return {"code.review_routing_accuracy": _ratio(routed, len(spec["cases"])),
            "code.conversion_accuracy": _ratio(text, auto)}


def score_planning(spec: dict[str, Any]) -> dict[str, float]:
    right = 0
    for e in spec["elements"]:
        el = scope.Element(e["key"], e["kind"], e["stream"], e["element"], e.get("concept"), e.get("usage") or {},
                           e.get("props") or {})
        disp, _ev = scope.propose(el, e.get("delta"), bool(e.get("delta_scope")), e.get("window_days"))
        right += 1 if disp == e["expected"] else 0
    found_n = exp_n = hit = 0
    for g in spec.get("graphs", []):
        found = {frozenset(c) for c in deps.cycles(set(g["nodes"]), [tuple(x) for x in g["edges"]])}
        exp = {frozenset(c) for c in g["cycles"]}
        found_n, exp_n, hit = found_n + len(found), exp_n + len(exp), hit + len(found & exp)
    return {"planning.disposition_accuracy": _ratio(right, len(spec["elements"])),
            "planning.cycle_recall": _ratio(hit, exp_n), "planning.cycle_precision": _ratio(hit, found_n)}


def score_compliance(spec: dict[str, Any]) -> dict[str, float]:
    lvl = appr = 0
    for subject, exp in spec["expected"].items():
        c = reviews.classify(spec["controls"], subject)
        lvl += 1 if c.level == exp["level"] else 0
        appr += 1 if c.required_approvals == exp["approvals"] else 0
    n = len(spec["expected"])
    return {"compliance.level_accuracy": _ratio(lvl, n), "compliance.approvers_accuracy": _ratio(appr, n)}


def score_review(spec: dict[str, Any]) -> dict[str, float]:
    items = {i["id"]: ReviewItem(risk=i["risk"], compliance=i.get("compliance", "none"),
                                 confidence=i.get("confidence"), compliance_controls=i.get("controls", []))
             for i in spec["items"]}
    prio = {k: reviews.priority(v)[0] for k, v in items.items()}
    order = spec["expected_order"]
    pairs = list(itertools.combinations(order, 2))
    agree = sum(1 for a, b in pairs if prio[a] > prio[b])
    keys = {i["id"]: reviews.pattern_key(i["prefix"], *i["reasons"]) for i in spec.get("patterns", [])}
    group = {x: n for n, g in enumerate(spec.get("pattern_groups", [])) for x in g}
    pp = list(itertools.combinations(sorted(keys), 2))
    same = sum(1 for a, b in pp if (keys[a] == keys[b]) == (group.get(a) == group.get(b)))
    return {"review.order_agreement": _ratio(agree, len(pairs)), "review.grouping_agreement": _ratio(same, len(pp))}


AREAS = {"mapping": score_mapping, "configuration": score_configuration, "code": score_code,
         "planning": score_planning, "compliance": score_compliance, "review": score_review}
REQUIRED_AREAS = set(AREAS)


# ------------------------------------------------------------------ suites and scorecards

def suites_dir(root: pathlib.Path | None = None) -> pathlib.Path:
    return (root or SRC.parents[2]) / "testkit" / "evaluation"


def load_suites(root: pathlib.Path | None = None) -> dict[str, tuple[dict[str, Any], str]]:
    out = {}
    for f in sorted(suites_dir(root).glob("*/suite.yaml")):
        raw = f.read_bytes()
        spec = yaml.safe_load(raw)
        missing = REQUIRED_AREAS - set(spec)
        if missing:
            raise ValueError(f"{f.parent.name}: the suite has no {', '.join(sorted(missing))} section(s)")
        out[spec["name"]] = (spec, hashlib.sha256(raw).hexdigest())
    if not out:
        raise ValueError(f"No evaluation suites in {suites_dir(root)}")
    return out


def engine_digest() -> str:
    h = hashlib.sha256()
    for f in ENGINE_FILES:
        h.update(f.encode() + b"\0" + (SRC / f).read_bytes())
    return h.hexdigest()


def run(root: pathlib.Path | None = None) -> dict[str, Any]:
    suites = {}
    for name, (spec, digest) in load_suites(root).items():
        measures: dict[str, float] = {}
        for area, fn in AREAS.items():
            measures.update(fn(spec[area]))
        suites[name] = {"digest": digest, "measures": dict(sorted(measures.items()))}
    return {"format": FORMAT, "created_at": datetime.now(UTC).isoformat(), "engine_digest": engine_digest(),
            "suites": suites}


def compare(baseline: dict[str, Any] | None, current: dict[str, Any]) -> dict[str, Any]:
    """Regressions of `current` against `baseline`: a measure that fell or disappeared, or a suite that
    disappeared. With no baseline (the first release) nothing regresses."""
    regressions: list[dict[str, Any]] = []
    improved: list[dict[str, Any]] = []
    changed_suites: list[str] = []
    for suite, b in ((baseline or {}).get("suites") or {}).items():
        c = current["suites"].get(suite)
        if c is None:
            regressions.append({"suite": suite, "measure": None, "baseline": None, "current": None,
                                "detail": "The suite is missing."})
            continue
        if c["digest"] != b.get("digest"):
            changed_suites.append(suite)
        for m, bv in b["measures"].items():
            cv = c["measures"].get(m)
            if cv is None:
                regressions.append({"suite": suite, "measure": m, "baseline": bv, "current": None,
                                    "detail": "The measure is no longer produced."})
            elif cv < bv - EPSILON:
                regressions.append({"suite": suite, "measure": m, "baseline": bv, "current": cv,
                                    "detail": f"fell from {bv} to {cv}"})
            elif cv > bv + EPSILON:
                improved.append({"suite": suite, "measure": m, "baseline": bv, "current": cv})
    return {"passed": not regressions, "regressions": regressions, "improved": improved,
            "changed_suites": changed_suites}
