"""Genericity guard: fail when a reference-case term appears in platform code.

    py -3.13 tools/genericity/check.py

Scans every text file under the platform folders. Customer, vendor and product names may appear
only in packs/, programmes/ and docs/. Exit code 1 lists every hit with file and line.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCANNED = ["platform", "apps", "infra", "tools", "testkit", ".github"]
SKIP_DIRS = {"node_modules", ".venv", "dist", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
             "coverage", "playwright-report", "test-results"}
SKIP_FILES = {ROOT / "tools" / "genericity" / "denylist.txt"}
TEXT_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".toml", ".md", ".sql",
                 ".html", ".css", ".txt", ".hcl", ".ini", ".mako", ".env", ".example", ".bicep", ".sh", ".ps1"}


def load_patterns() -> list[re.Pattern[str]]:
    lines = (ROOT / "tools" / "genericity" / "denylist.txt").read_text(encoding="utf-8").splitlines()
    return [re.compile(x.strip(), re.IGNORECASE) for x in lines if x.strip() and not x.startswith("#")]


def scan() -> list[str]:
    patterns = load_patterns()
    hits: list[str] = []
    for top in SCANNED:
        base = ROOT / top
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if any(part in SKIP_DIRS for part in path.parts) or not path.is_file() or path in SKIP_FILES:
                continue
            if path.suffix.lower() not in TEXT_SUFFIXES and path.name not in {"Dockerfile"}:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for n, line in enumerate(text.splitlines(), 1):
                for p in patterns:
                    if p.search(line):
                        hits.append(f"{path.relative_to(ROOT)}:{n}: '{p.pattern}' in: {line.strip()[:120]}")
    return hits


if __name__ == "__main__":
    found = scan()
    if found:
        print("Genericity check failed. Reference-case terms found in platform code:\n")
        print("\n".join(found))
        print("\nMove this knowledge into packs/ or programmes/.")
        sys.exit(1)
    print("Genericity check passed: no reference-case terms in platform code.")
