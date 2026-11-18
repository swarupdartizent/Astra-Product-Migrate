"""Document checks after a load (E13.F2.S2).

Every document of the run's extract is checked: its link must resolve at source and the record it belongs to must
have been accepted by the target in this or an earlier run. A random sample (size from the blueprint's
`documents.retrieval_sample_size`, seeded by the run, so it is repeatable) is read back from the target and compared
byte for byte by SHA-256 with the source. Reading back needs the target adapter's `documents.read_path` and a target
connection; without them the sample is reported as blocked, never assumed.
"""

from __future__ import annotations

import hashlib
import random
import uuid
from typing import Any

import psycopg

from astra_migrate.adapters.contract import TargetAdapterContent
from astra_migrate.adapters.target import TargetClient, TargetError

ACCEPTED = ("loaded", "unchanged", "rehearsed")


def check(tc: psycopg.Connection[Any], run_id: uuid.UUID, extract_run_id: uuid.UUID, earlier_and_this: list[uuid.UUID],
          entity_tables: dict[str, str], sample_size: int,
          client: TargetClient | None, tcontent: TargetAdapterContent | None) -> dict[str, Any]:
    accepted: dict[str, set[str]] = {}
    for table, key in tc.execute("SELECT target_table, source_key FROM estate.load_records WHERE run_id = ANY(%s) "
                                 "AND status = ANY(%s)", (earlier_and_this, list(ACCEPTED))).fetchall():
        accepted.setdefault(table, set()).add(str(key))
    docs = tc.execute("SELECT doc_key, link_entity, link_key, link_resolved, sha256 FROM estate.documents "
                      "WHERE run_id = %s ORDER BY doc_key", (extract_run_id,)).fetchall()
    rows: list[tuple[str, str | None, str | None, str, str | None]] = []
    broken = 0
    for key, ent, lk, resolved, _sha in docs:
        table = entity_tables.get(str(ent)) if ent else None
        if not resolved or not ent:
            rows.append((key, ent, lk, "broken", "The link does not resolve at source."))
        elif table is None:
            rows.append((key, ent, lk, "broken", f"No transformation loads {ent} records."))
        elif str(lk) not in accepted.get(table, set()):
            rows.append((key, ent, lk, "broken", f"The {ent} record {lk} has not been accepted by the target."))
        else:
            rows.append((key, ent, lk, "linked", None))
            continue
        broken += 1
    rng = random.Random(run_id.int)  # noqa: S311 - a repeatable sample, not a secret
    candidates = [d for d in docs if d[4]]
    sample = rng.sample(candidates, min(sample_size, len(candidates)))
    sample_status: dict[str, int] = {}
    blocked = None
    if not sample:
        blocked = None
    elif tcontent is None or tcontent.documents is None:
        blocked = "The target adapter records no way to read documents back (documents.read_path)."
    elif client is None:
        blocked = "A rehearsal has no target connection to read documents from."
    for key, ent, lk, _r, sha in sample:
        if blocked:
            rows.append((key, ent, lk, "blocked", blocked))
            sample_status["blocked"] = sample_status.get("blocked", 0) + 1
            continue
        assert client is not None and tcontent is not None and tcontent.documents is not None
        path = tcontent.documents.read_path.replace("{key}", str(key))
        try:
            status, data, err = client.get_bytes(path, "documents")
        except TargetError as e:
            status, data, err = None, None, str(e)
        if data is None:
            rows.append((key, ent, lk, "missing", err or f"HTTP {status}"))
            sample_status["missing"] = sample_status.get("missing", 0) + 1
        elif hashlib.sha256(data).hexdigest() == sha:
            rows.append((key, ent, lk, "match", None))
            sample_status["match"] = sample_status.get("match", 0) + 1
        else:
            rows.append((key, ent, lk, "mismatch", "The bytes differ from the source document."))
            sample_status["mismatch"] = sample_status.get("mismatch", 0) + 1
    with tc.transaction(), tc.cursor() as cur:
        cur.execute("DELETE FROM estate.document_checks WHERE run_id = %s", (run_id,))
        cur.executemany("INSERT INTO estate.document_checks(run_id, doc_key, link_entity, link_key, status, detail) "
                        "VALUES (%s,%s,%s,%s,%s,%s)", [(run_id, *r) for r in rows])
    return {"documents": len(docs), "broken_links": broken, "sample_size": len(sample),
            "sample": sample_status, "blocked": blocked,
            "passed": broken == 0 and not blocked and sample_status.get("match", 0) == len(sample)}
