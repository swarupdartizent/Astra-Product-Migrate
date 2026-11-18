"""Form parity (E12.F2.S2): a converted PDF form is compared with its approved golden copy.

The comparison is structural and textual: page count, page sizes, the form fields (names and types) and the text of
each page (whitespace-normalised). It passes only when all of them match. A form that merges data is compared on
its template, before data is merged.
"""

from __future__ import annotations

import difflib
import io
import re
from typing import Any

from pypdf import PdfReader
from pypdf.errors import PdfReadError

MAX_BYTES = 20 * 1024 * 1024


class ParityError(ValueError):
    pass


def read(content: bytes) -> dict[str, Any]:
    if not content.startswith(b"%PDF-"):
        raise ParityError("The file is not a PDF.")
    if len(content) > MAX_BYTES:
        raise ParityError("The file is larger than 20 MB.")
    try:
        r = PdfReader(io.BytesIO(content))
        if r.is_encrypted:
            raise ParityError("Encrypted PDFs cannot be compared.")
        pages = [{"size": [round(float(p.mediabox.width)), round(float(p.mediabox.height))],
                  "text": re.sub(r"\s+", " ", p.extract_text() or "").strip()} for p in r.pages]
        fields = {name: str(f.get("/FT", "")) for name, f in (r.get_fields() or {}).items()}
    except PdfReadError as e:
        raise ParityError(f"The PDF cannot be read: {e}") from e
    return {"pages": pages, "fields": fields}


def compare(converted: bytes, golden: bytes) -> dict[str, Any]:
    a, b = read(converted), read(golden)
    diffs: list[str] = []
    if len(a["pages"]) != len(b["pages"]):
        diffs.append(f"pages: converted has {len(a['pages'])}, golden copy has {len(b['pages'])}")
    for n, (pa, pb) in enumerate(zip(a["pages"], b["pages"], strict=False), start=1):
        if pa["size"] != pb["size"]:
            diffs.append(f"page {n} size: {pa['size']} vs {pb['size']}")
        if pa["text"] != pb["text"]:
            ratio = difflib.SequenceMatcher(None, pa["text"], pb["text"]).ratio()
            sample = next((d for d in difflib.ndiff(pb["text"].split(" "), pa["text"].split(" "))
                           if d[:1] in "+-"), "")
            diffs.append(f"page {n} text differs (similarity {ratio:.2f}; first difference: {sample.strip()!r})")
    missing = sorted(set(b["fields"]) - set(a["fields"]))
    extra = sorted(set(a["fields"]) - set(b["fields"]))
    typed = sorted(k for k in set(a["fields"]) & set(b["fields"]) if a["fields"][k] != b["fields"][k])
    if missing:
        diffs.append(f"fields missing from the converted form: {', '.join(missing[:20])}")
    if extra:
        diffs.append(f"fields not in the golden copy: {', '.join(extra[:20])}")
    if typed:
        diffs.append(f"fields with a different type: {', '.join(typed[:20])}")
    return {"passed": not diffs, "differences": diffs, "pages": len(a["pages"]), "golden_pages": len(b["pages"]),
            "fields": len(a["fields"]), "golden_fields": len(b["fields"])}
