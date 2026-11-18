"""Exports to Jira and Azure DevOps, and actual effort flowing back (E11.F5.S2).

Both exports are the tools' own CSV import formats. Every row carries the platform's stable task key, so a
re-export updates the same work items and an export of logged time from either tool maps back to the tasks.
"""

from __future__ import annotations

import csv
import io
from typing import Any

ID_COLUMNS = ("Astra ID", "astra_id", "External ID", "Custom field (Astra ID)", "task_key")
HOURS_COLUMNS = (("Completed Work", 1.0), ("hours", 1.0), ("Hours", 1.0), ("Time Spent", 1 / 3600),
                 ("Σ Time Spent", 1 / 3600))
MAX_IMPORT_ROWS = 200_000


class ImportError_(ValueError):
    pass


def _deps(t: dict[str, Any]) -> str:
    return " ".join(t.get("depends_on") or [])


def jira_csv(tasks: dict[str, dict[str, Any]], project_key: str) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Issue Type", "Summary", "Description", "Original Estimate", "Labels", "Labels", "Astra ID",
                "Astra Depends On", "Project Key"])
    for k in sorted(tasks):
        t = tasks[k]
        desc = (f"{t['activity']} for {t['element']} ({t['stream']}, {t['disposition']}). Owner role: {t['role']}. "
                f"Estimate {t.get('low')}-{t.get('high')} h (likely {t.get('likely')} h).")
        w.writerow(["Task", t["title"][:250], desc, int(round(float(t.get("likely") or 0) * 3600)),
                    f"astra-{t['stream']}", f"astra-{t['disposition']}", k, _deps(t), project_key])
    return buf.getvalue()


def ado_csv(tasks: dict[str, dict[str, Any]], area_path: str) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Work Item Type", "Title", "Description", "Original Estimate", "Remaining Work", "Tags",
                "Area Path", "Astra ID", "Astra Depends On"])
    for k in sorted(tasks):
        t = tasks[k]
        likely = float(t.get("likely") or 0)
        w.writerow(["Task", t["title"][:255], f"{t['activity']} for {t['element']}. Owner role: {t['role']}. "
                    f"Range {t.get('low')}-{t.get('high')} h.", likely, likely,
                    f"astra; {t['stream']}; {t['disposition']}; {t['role']}", area_path, k, _deps(t)])
    return buf.getvalue()


def parse_actuals(data: bytes) -> list[tuple[str, float]]:
    """Rows of (task key, hours) from a Jira or Azure DevOps CSV export (or a plain key,hours file)."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise ImportError_("The file is not UTF-8 text.") from e
    reader = csv.DictReader(io.StringIO(text))
    cols = reader.fieldnames or []
    idc = next((c for c in ID_COLUMNS if c in cols), None)
    hc = next(((c, f) for c, f in HOURS_COLUMNS if c in cols), None)
    if idc is None or hc is None:
        raise ImportError_(f"The file needs a task id column ({', '.join(ID_COLUMNS)}) and an effort column "
                           f"({', '.join(c for c, _ in HOURS_COLUMNS)}). Found: {', '.join(cols)[:300]}")
    out: dict[str, float] = {}
    for n, row in enumerate(reader):
        if n >= MAX_IMPORT_ROWS:
            raise ImportError_(f"Imports are limited to {MAX_IMPORT_ROWS} rows.")
        key = (row.get(idc) or "").strip()
        raw = (row.get(hc[0]) or "").strip()
        if not key or not raw:
            continue
        try:
            hours = float(raw) * hc[1]
        except ValueError as e:
            raise ImportError_(f"Row {n + 2}: '{raw}' is not a number.") from e
        if hours < 0:
            raise ImportError_(f"Row {n + 2}: effort cannot be negative.")
        out[key] = out.get(key, 0.0) + hours
    return sorted(out.items())
