"""Version delta engine (E09.F1.S1, E09.F1.S2).

Compares a customer's estate with the target baseline, object by object, and sorts every source object into
one of the specification's four groups:

  unchanged          same type and name in the target, same signature
  renamed_or_moved   same object under another schema (moved), or another name with the same columns or the
                     same code (renamed)
  changed_behaviour  same name, different signature: columns added, removed or retyped, or different code
  removed_in_target  no counterpart in the target

Objects of a type the baseline does not describe are listed as not_in_scope, never guessed. Target objects
with no source counterpart are listed as new_in_target.

Each object also says where it comes from (E09.F1.S2), by comparison with the source product's standard
baseline for the customer's version: standard, customized_standard or customer_specific. Without a standard
baseline, the adapter's customization naming rules decide customer_specific; otherwise the origin is unknown.

Deterministic: inputs are sorted and hashed, so the same inputs always give the same result and digest.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any

GROUPS = ("unchanged", "renamed_or_moved", "changed_behaviour", "removed_in_target")
RENAME_THRESHOLD = 0.8
_COMMENTS = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)


def normalize_code(sql: str) -> str:
    s = _COMMENTS.sub(" ", sql).lower()
    s = re.sub(r"\bcreate\s+or\s+alter\b", "create", s)
    s = re.sub(r"[\[\]]", "", s)
    return re.sub(r"\s+", " ", s).strip().rstrip(";").strip()


def code_hash(sql: str) -> str:
    return hashlib.sha256(normalize_code(sql).encode()).hexdigest()


def body_hash(sql: str, name: str) -> str:
    """Hash of the code with its own name removed, to recognise a renamed object."""
    return hashlib.sha256(re.sub(re.escape(name.lower()), "<name>", normalize_code(sql)).encode()).hexdigest()


def base_type(t: str) -> str:
    return re.sub(r"\(.*\)", "", t or "").strip().lower()


@dataclass(frozen=True)
class Obj:
    type: str
    schema: str
    name: str
    columns: tuple[tuple[str, str], ...] = ()  # (name lower, base type)
    code_hash: str | None = None
    body_hash: str | None = None
    customer_specific: bool = False  # the adapter says every object of its type is a customer extension

    @property
    def key(self) -> str:
        return f"{self.type}:{self.schema.lower()}.{self.name.lower()}"

    @property
    def qualified(self) -> str:
        return f"{self.schema}.{self.name}"

    def signature(self) -> str:
        return self.code_hash or json.dumps(sorted(self.columns))


@dataclass
class Difference:
    group: str
    type: str
    source: str
    target: str | None
    origin: str  # standard | customized_standard | customer_specific | unknown
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class DeltaResult:
    differences: list[Difference]
    not_in_scope: list[str]
    new_in_target: list[str]
    input_digest: str
    result_digest: str
    counts: dict[str, int]
    origin_counts: dict[str, int]
    standard_baseline: bool


def objects_from_baseline(content: dict[str, Any]) -> list[Obj]:
    out = []
    for o in content.get("objects", []):
        cols = tuple(sorted((str(c["name"]).lower(), base_type(str(c.get("type", "")))) for c in o.get("columns", [])))
        out.append(Obj(o["type"], o.get("schema") or "dbo", o["name"], cols, o.get("definition_sha256"),
                       o.get("detail", {}).get("body_sha256")))
    return out


def _jaccard(a: tuple[tuple[str, str], ...], b: tuple[tuple[str, str], ...]) -> float:
    sa, sb = {c for c, _ in a}, {c for c, _ in b}
    return len(sa & sb) / len(sa | sb) if sa | sb else 0.0


def _column_diff(s: Obj, t: Obj) -> dict[str, Any]:
    sc, tc = dict(s.columns), dict(t.columns)
    return {"added_in_target": sorted(set(tc) - set(sc)), "missing_in_target": sorted(set(sc) - set(tc)),
            "type_changed": sorted(f"{c}: {sc[c]} -> {tc[c]}" for c in set(sc) & set(tc) if sc[c] != tc[c])}


def _origin(o: Obj, standard: dict[tuple[str, str], Obj] | None, patterns: list[re.Pattern[str]]) -> str:
    if standard is not None:
        st = standard.get((o.type, o.name.lower()))
        if st is None:
            return "customer_specific"
        return "standard" if st.signature() == o.signature() else "customized_standard"
    if o.customer_specific or any(p.search(o.name) for p in patterns):
        return "customer_specific"
    return "unknown"


def compare(source: list[Obj], target: list[Obj], standard: list[Obj] | None = None,
            customization_patterns: list[str] | None = None) -> DeltaResult:
    src = sorted(source, key=lambda o: o.key)
    tgt = sorted(target, key=lambda o: o.key)
    patterns = [re.compile(p, re.IGNORECASE) for p in customization_patterns or []]
    std = {(o.type, o.name.lower()): o for o in standard} if standard is not None else None
    in_scope_types = {o.type for o in tgt}
    by_name = {(o.type, o.name.lower()): o for o in tgt}
    matched: set[str] = set()
    diffs: list[Difference] = []
    not_in_scope: list[str] = []
    pending: list[Obj] = []

    for s in src:
        if s.type not in in_scope_types:
            not_in_scope.append(f"{s.type}:{s.qualified}")
            continue
        t = by_name.get((s.type, s.name.lower()))
        if t is None:
            pending.append(s)
            continue
        matched.add(t.key)
        origin = _origin(s, std, patterns)
        if t.schema.lower() != s.schema.lower():
            diffs.append(Difference("renamed_or_moved", s.type, s.qualified, t.qualified, origin,
                                    {"how": "moved", "from_schema": s.schema, "to_schema": t.schema}))
        elif s.signature() == t.signature():
            diffs.append(Difference("unchanged", s.type, s.qualified, t.qualified, origin))
        elif s.code_hash or t.code_hash:
            diffs.append(Difference("changed_behaviour", s.type, s.qualified, t.qualified, origin,
                                    {"what": "code differs"}))
        else:
            diffs.append(Difference("changed_behaviour", s.type, s.qualified, t.qualified, origin,
                                    {"what": "columns differ", **_column_diff(s, t)}))

    unmatched = [t for t in tgt if t.key not in matched]
    for s in pending:
        best, score = None, 0.0
        for t in unmatched:
            if t.type != s.type:
                continue
            if s.body_hash and t.body_hash and s.body_hash == t.body_hash:
                best, score = t, 1.0
                break
            if s.columns and t.columns:
                j = _jaccard(s.columns, t.columns)
                if j > score:
                    best, score = t, j
        origin = _origin(s, std, patterns)
        if best is not None and score >= RENAME_THRESHOLD:
            unmatched.remove(best)
            matched.add(best.key)
            details: dict[str, Any] = {"how": "renamed", "similarity": round(score, 3)}
            if s.columns:
                details.update(_column_diff(s, best))
            diffs.append(Difference("renamed_or_moved", s.type, s.qualified, best.qualified, origin, details))
        else:
            diffs.append(Difference("removed_in_target", s.type, s.qualified, None, origin,
                                    {"closest": best.qualified if best else None,
                                     "similarity": round(score, 3) if best else None}))

    diffs.sort(key=lambda d: (GROUPS.index(d.group), d.type, d.source.lower()))
    new_in_target = sorted(f"{t.type}:{t.qualified}" for t in unmatched)
    inputs = json.dumps({"source": [asdict(o) for o in src], "target": [asdict(o) for o in tgt],
                         "standard": [asdict(o) for o in sorted(standard, key=lambda o: o.key)] if standard else None,
                         "patterns": sorted(customization_patterns or [])}, sort_keys=True)
    result = json.dumps([asdict(d) for d in diffs] + [not_in_scope, new_in_target], sort_keys=True)
    counts = {g: sum(1 for d in diffs if d.group == g) for g in GROUPS}
    origins: dict[str, int] = {}
    for d in diffs:
        origins[d.origin] = origins.get(d.origin, 0) + 1
    return DeltaResult(diffs, sorted(not_in_scope), new_in_target, hashlib.sha256(inputs.encode()).hexdigest(),
                       hashlib.sha256(result.encode()).hexdigest(), counts, origins, standard is not None)


# ------------------------------------------------------------------ pattern advice (E09.F2.S1)

PATTERNS = ("cross_product", "same_family_upgrade", "consolidation")


def advise_pattern(chosen: str | None, delta: DeltaResult | None, source_count: int = 1) -> dict[str, Any]:
    """The planner's view on the blueprint's migration pattern, with the evidence behind it."""
    reasons: list[str] = []
    if source_count > 1:
        rec = "consolidation"
        reasons.append(f"{source_count} source estates move into one target.")
    elif delta is None:
        return {"chosen": chosen, "recommended": None, "agrees": None,
                "reasons": ["No version delta has been run yet, so there is no evidence to judge the pattern."]}
    else:
        in_scope = sum(delta.counts.values())
        kept = delta.counts["unchanged"] + delta.counts["renamed_or_moved"]
        share = kept / in_scope if in_scope else 0.0
        reasons.append(f"{kept} of {in_scope} comparable source objects ({share:.0%}) exist in the target unchanged, "
                       "renamed or moved.")
        reasons.append(f"{delta.counts['changed_behaviour']} changed and {delta.counts['removed_in_target']} have no "
                       "counterpart in the target.")
        if share >= 0.6:
            rec = "same_family_upgrade"
            reasons.append("Most of the estate keeps its shape, so a delta-driven same-family upgrade needs design "
                           "work only for the differences.")
        else:
            rec = "cross_product"
            reasons.append("Most of the estate has no direct counterpart, so element-by-element mapping through the "
                           "ontology (cross-product) fits better.")
    return {"chosen": chosen, "recommended": rec, "agrees": chosen == rec if chosen else None, "reasons": reasons}
