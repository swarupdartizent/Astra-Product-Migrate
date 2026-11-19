"""Release gate command line (E22.F1.S2).

    python -m astra_migrate.evaluation run [--out FILE]
        Score every golden suite and print (or write) the scorecard.
    python -m astra_migrate.evaluation gate [--baseline FILE]
        Score now and compare with the previous release's scorecard. Exits 1 when any measure of any suite fell
        or disappeared, so CI blocks the release.
    python -m astra_migrate.evaluation record --release NAME --reason TEXT [--baseline FILE] [--force]
        Make the current scorecard the baseline for the next release. Refuses when it regresses, unless --force
        is given with a reason (for example a suite was made harder on purpose); the reason is kept in the file.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from datetime import UTC, datetime
from typing import Any

from astra_migrate.evaluation import engine

DEFAULT_BASELINE = engine.SRC.parents[2] / "testkit" / "releases" / "baseline.json"


def _load(path: pathlib.Path) -> dict[str, Any] | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def _report(res: dict[str, Any], baseline: dict[str, Any] | None) -> str:
    lines = [f"Baseline: {(baseline or {}).get('release', 'none (first release)')}"]
    for r in res["regressions"]:
        lines.append(f"  REGRESSION {r['suite']} {r['measure'] or ''}: {r['detail']}")
    for r in res["improved"]:
        lines.append(f"  improved   {r['suite']} {r['measure']}: {r['baseline']} -> {r['current']}")
    for s in res["changed_suites"]:
        lines.append(f"  note: suite {s} changed since the baseline")
    lines.append("Release gate: " + ("PASSED" if res["passed"] else "BLOCKED"))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m astra_migrate.evaluation")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--out", type=pathlib.Path)
    g = sub.add_parser("gate")
    g.add_argument("--baseline", type=pathlib.Path, default=DEFAULT_BASELINE)
    rec = sub.add_parser("record")
    rec.add_argument("--release", required=True)
    rec.add_argument("--reason", required=True)
    rec.add_argument("--baseline", type=pathlib.Path, default=DEFAULT_BASELINE)
    rec.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    card = engine.run()
    if a.cmd == "run":
        text = json.dumps(card, indent=2, sort_keys=True)
        if a.out:
            a.out.write_text(text + "\n", encoding="utf-8")
        else:
            print(text)
        return 0
    baseline = _load(a.baseline)
    res = engine.compare(baseline, card)
    print(_report(res, baseline))
    if a.cmd == "gate":
        return 0 if res["passed"] else 1
    if len(a.reason.strip()) < 10:
        print("Give a reason of at least 10 characters.", file=sys.stderr)
        return 2
    if not res["passed"] and not a.force:
        print("Refused: the scorecard regresses against the baseline. Fix it, or pass --force with the reason the "
              "suite changed.", file=sys.stderr)
        return 1
    card.update({"release": a.release, "reason": a.reason.strip(), "recorded_at": datetime.now(UTC).isoformat(),
                 "previous_release": (baseline or {}).get("release"), "forced": bool(a.force and not res["passed"]),
                 "regressions_accepted": res["regressions"] if a.force else []})
    a.baseline.parent.mkdir(parents=True, exist_ok=True)
    a.baseline.write_text(json.dumps(card, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Recorded {a.release} as the baseline in {a.baseline}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
