"""Pack registry (E04.F1.S1, E04.F1.S2, E07.F2.S1 review rule).

Lifecycle: register a draft (from a folder bundle) -> run tests -> (compliance packs: record the named
specialist review) -> publish. A pack cannot be published if any test fails. Published versions are
immutable; the database rejects changes. Packs are shared platform assets and hold no customer data.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import yaml
from packaging.specifiers import SpecifierSet
from packaging.version import Version
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate import audit
from astra_migrate.db.models import Pack, PackFile
from astra_migrate.packs.compose import compose
from astra_migrate.packs.schema import Manifest, PackType, parse_ref

MAX_FILES = 500
MAX_BUNDLE_BYTES = 20 * 1024 * 1024


class PackError(ValueError):
    def __init__(self, message: str, details: list[dict[str, str]] | None = None) -> None:
        super().__init__(message)
        self.details = details or []


def _friendly(e: ValidationError) -> list[dict[str, str]]:
    return [{"field": ".".join(str(p) for p in err["loc"]), "message": err["msg"].removeprefix("Value error, ")}
            for err in e.errors()]


def parse_manifest(text: str | bytes) -> Manifest:
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise PackError(f"pack.yaml is not valid YAML: {e}") from e
    if not isinstance(raw, dict):
        raise PackError("pack.yaml must be a mapping")
    try:
        return Manifest.model_validate(raw)
    except ValidationError as e:
        raise PackError("pack.yaml does not match the pack schema", _friendly(e)) from e


def bundle_digest(files: dict[str, bytes]) -> str:
    h = hashlib.sha256()
    for path in sorted(files):
        h.update(path.encode() + b"\0" + hashlib.sha256(files[path]).hexdigest().encode() + b"\n")
    return h.hexdigest()


def _check_paths(files: dict[str, bytes]) -> None:
    if "pack.yaml" not in files:
        raise PackError("The bundle has no pack.yaml at its root")
    if len(files) > MAX_FILES:
        raise PackError(f"A pack can hold at most {MAX_FILES} files")
    if sum(len(b) for b in files.values()) > MAX_BUNDLE_BYTES:
        raise PackError("The pack is larger than 20 MB")
    for p in files:
        if p.startswith(("/", "\\")) or ".." in p.split("/") or "\\" in p or ":" in p:
            raise PackError(f"Unsafe file path in bundle: {p}")


def version_key(v: str) -> list[int]:
    return [int(x) for x in v.split(".")]


def register_draft(session: Session, files: dict[str, bytes], actor: audit.Actor) -> Pack:
    _check_paths(files)
    m = parse_manifest(files["pack.yaml"])
    digest = bundle_digest(files)
    existing = session.scalar(select(Pack).where(Pack.name == m.name, Pack.version == m.version))
    if existing is not None:
        if existing.status != "draft":
            if existing.digest == digest:
                return existing
            raise PackError(f"{m.ref} is already published and cannot change. Publish a new version.")
        if existing.digest == digest:
            return existing
        session.delete(existing)
        session.flush()
    pack = Pack(name=m.name, version=m.version, version_sort=version_key(m.version), type=m.type.value,
                title=m.title, status="draft", manifest=m.model_dump(mode="json", by_alias=True), digest=digest,
                created_by=actor.name)
    session.add(pack)
    session.flush()
    for path, data in sorted(files.items()):
        session.add(PackFile(pack_id=pack.id, path=path, sha256=hashlib.sha256(data).hexdigest(), size=len(data),
                             content=data))
    session.flush()
    audit.record(session, actor, "pack.draft_registered", target_type="pack", target_id=str(pack.id),
                 details={"ref": m.ref, "type": m.type.value, "digest": digest, "files": len(files)})
    return pack


def manifest_of(pack: Pack) -> Manifest:
    return Manifest.model_validate(pack.manifest)


def get_by_ref(session: Session, ref: str, *, published_only: bool = True) -> Pack | None:
    name, version = parse_ref(ref)
    stmt = select(Pack).where(Pack.name == name, Pack.version == version)
    if published_only:
        stmt = stmt.where(Pack.status.in_(("published", "deprecated")))
    return session.scalar(stmt)


def latest_published(session: Session, name: str, spec: str = ">=0") -> Pack | None:
    rows = session.scalars(select(Pack).where(Pack.name == name, Pack.status == "published"))
    ok = sorted((p for p in rows if Version(p.version) in SpecifierSet(spec)), key=lambda p: p.version_sort)
    return ok[-1] if ok else None


# ----------------------------------------------------------------------------- tests

@dataclass
class Check:
    name: str
    passed: bool
    message: str


def run_tests(session: Session, pack: Pack) -> dict[str, Any]:
    """Built-in checks plus the pack's own declarative tests. Deterministic for the same registry state."""
    m = manifest_of(pack)
    checks: list[Check] = [Check("Manifest matches the pack schema", True, f"{m.ref} is valid")]

    for req in m.requires:
        dep = latest_published(session, req.name, req.versions)
        checks.append(Check(f"Dependency {req.name} {req.versions} is published", dep is not None,
                            f"Found {dep.name}@{dep.version}" if dep else
                            f"No published version of {req.name} matches {req.versions}"))

    if m.type == PackType.COMPLIANCE:
        crit = [c.id for c in m.adds.controls if c.compliance_critical and not c.two_person_approval
                and c.type.value == "approval"]
        checks.append(Check("Compliance-critical approval controls require two people", not crit,
                            "OK" if not crit else f"Set two_person_approval on: {', '.join(crit)}"))

    controls = {c.id: c for c in m.adds.controls}
    settings = {s.key: s for s in m.adds.settings}
    for t in m.tests:
        match t.kind:
            case "contains_control":
                ok = t.id in controls
                checks.append(Check(t.name, ok, "OK" if ok else f"Control {t.id} is missing"))
            case "control_type":
                c = controls.get(t.id or "")
                ok = c is not None and c.type.value == t.expect
                checks.append(Check(t.name, ok, "OK" if ok else
                                    f"Control {t.id} has type {c.type.value if c else 'none'}, expected {t.expect}"))
            case "setting_value":
                st = settings.get(t.key or "")
                ok = st is not None and st.value == t.expect
                checks.append(Check(t.name, ok, "OK" if ok else
                                    f"Setting {t.key} is {st.value if st else 'missing'}, expected {t.expect}"))
            case "composes_with":
                others: list[Manifest] = []
                missing = []
                for ref in t.packs:
                    p = get_by_ref(session, ref)
                    if p is None:
                        missing.append(ref)
                    else:
                        others.append(manifest_of(p))
                if missing:
                    checks.append(Check(t.name, False, f"Not published: {', '.join(missing)}"))
                    continue
                comp = compose([m, *others])
                blocking = [p for p in comp.problems if p.severity == "blocking"]
                n = len(comp.conflicts)
                ok = not blocking and (t.expect_conflicts is None or n == t.expect_conflicts)
                checks.append(Check(t.name, ok, "OK" if ok else
                                    f"{len(blocking)} blocking problem(s); {n} conflict(s)"
                                    + (f", expected {t.expect_conflicts}" if t.expect_conflicts is not None else "")))
    passed = all(c.passed for c in checks)
    return {"passed": passed, "ran_at": datetime.now(UTC).isoformat(), "digest": pack.digest,
            "checks": [c.__dict__ for c in checks]}


def test_pack(session: Session, pack: Pack, actor: audit.Actor) -> dict[str, Any]:
    if pack.status != "draft":
        raise PackError("Only draft packs are tested here; published packs keep their release test report.")
    report = run_tests(session, pack)
    pack.test_report, pack.tests_passed = report, report["passed"]
    audit.record(session, actor, "pack.tested", outcome="success" if report["passed"] else "failure",
                 target_type="pack", target_id=str(pack.id),
                 details={"ref": f"{pack.name}@{pack.version}", "passed": report["passed"],
                          "failed": [c["name"] for c in report["checks"] if not c["passed"]]})
    return report


def record_review(session: Session, pack: Pack, actor: audit.Actor, reviewer_name: str, reviewer_role: str) -> Pack:
    if pack.status != "draft":
        raise PackError("Reviews are recorded before publishing.")
    pack.reviewed_by_name, pack.reviewed_by_role = reviewer_name.strip(), reviewer_role.strip()
    pack.reviewed_at = datetime.now(UTC)
    audit.record(session, actor, "pack.review_recorded", target_type="pack", target_id=str(pack.id),
                 details={"ref": f"{pack.name}@{pack.version}", "reviewer": pack.reviewed_by_name,
                          "reviewer_role": pack.reviewed_by_role, "digest": pack.digest})
    return pack


def publish(session: Session, pack: Pack, actor: audit.Actor) -> Pack:
    if pack.status != "draft":
        raise PackError(f"{pack.name}@{pack.version} is already {pack.status}.")
    report = run_tests(session, pack)  # always re-run: the registry may have changed since the last test
    pack.test_report, pack.tests_passed = report, report["passed"]
    if not report["passed"]:
        audit.record(session, actor, "pack.publish_refused", outcome="denied", target_type="pack",
                     target_id=str(pack.id), details={"ref": f"{pack.name}@{pack.version}", "reason": "tests failed"})
        session.commit()
        raise PackError("The pack cannot be published because its tests fail.",
                        [{"field": c["name"], "message": c["message"]} for c in report["checks"] if not c["passed"]])
    if pack.type == PackType.COMPLIANCE.value and not pack.reviewed_by_name:
        raise PackError("A compliance pack must be reviewed by a named compliance specialist before it is published.")
    pack.status, pack.published_by, pack.published_at = "published", actor.name, datetime.now(UTC)
    audit.record(session, actor, "pack.published", target_type="pack", target_id=str(pack.id),
                 details={"ref": f"{pack.name}@{pack.version}", "digest": pack.digest,
                          "reviewer": pack.reviewed_by_name})
    return pack


def deprecate(session: Session, pack: Pack, actor: audit.Actor, reason: str) -> Pack:
    if pack.status != "published":
        raise PackError("Only published packs can be deprecated.")
    pack.status = "deprecated"
    audit.record(session, actor, "pack.deprecated", target_type="pack", target_id=str(pack.id),
                 details={"ref": f"{pack.name}@{pack.version}", "reason": reason})
    return pack


# ----------------------------------------------------------------------------- comparing versions

def diff_manifests(a: Manifest, b: Manifest) -> dict[str, Any]:
    """What changes when a project moves from pack version a to b (E04.F1.S2)."""

    def by_id(items: list[Any], key: str) -> dict[str, dict[str, Any]]:
        return {getattr(i, key): i.model_dump(mode="json") for i in items}

    out: dict[str, Any] = {"from": a.ref, "to": b.ref}
    for section, items_a, items_b, key in (
        ("controls", a.adds.controls, b.adds.controls, "id"),
        ("rules", a.adds.rules, b.adds.rules, "id"),
        ("settings", a.adds.settings, b.adds.settings, "key"),
    ):
        da, db = by_id(items_a, key), by_id(items_b, key)
        out[section] = {
            "added": [db[k] for k in sorted(db.keys() - da.keys())],
            "removed": [da[k] for k in sorted(da.keys() - db.keys())],
            "changed": [{"id": k, "before": da[k], "after": db[k]} for k in sorted(da.keys() & db.keys())
                        if json.dumps(da[k], sort_keys=True) != json.dumps(db[k], sort_keys=True)],
        }
    out["requires"] = {"before": [r.model_dump() for r in a.requires], "after": [r.model_dump() for r in b.requires]}
    return out
