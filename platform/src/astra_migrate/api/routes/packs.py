"""Pack registry endpoints (E04.F1.S1, E04.F1.S2, E04.F2.S1, E07.F1.S1)."""

from __future__ import annotations

import base64
import binascii
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from astra_migrate.api.errors import Problem, forbidden, not_found
from astra_migrate.db.control import get_session
from astra_migrate.db.models import Pack, PackFile
from astra_migrate.packs import registry
from astra_migrate.packs.compose import compose, to_json
from astra_migrate.packs.schema import PLACEMENT, ControlType, manifest_json_schema
from astra_migrate.security.principal import CurrentPrincipal
from astra_migrate.security.rbac import P

router = APIRouter(tags=["packs"])
DB = Annotated[Session, Depends(get_session)]
PackStatus = Literal["draft", "published", "deprecated"]


def _err(e: registry.PackError) -> Problem:
    return Problem(422, "pack-invalid", str(e), errors=e.details or None)


class PackSummary(BaseModel):
    id: uuid.UUID
    name: str
    version: str
    type: str
    title: str
    status: PackStatus
    tests_passed: bool | None
    reviewed_by_name: str | None
    published_at: datetime | None
    created_at: datetime


class PackFileOut(BaseModel):
    path: str
    size: int
    sha256: str


class PackDetail(PackSummary):
    manifest: dict[str, Any]
    digest: str
    files: list[PackFileOut]
    test_report: dict[str, Any] | None
    reviewed_by_role: str | None
    reviewed_at: datetime | None
    created_by: str
    published_by: str | None
    other_versions: list[str]


def _summary(p: Pack) -> PackSummary:
    return PackSummary(id=p.id, name=p.name, version=p.version, type=p.type, title=p.title,
                       status=p.status,
                       tests_passed=p.tests_passed, reviewed_by_name=p.reviewed_by_name, published_at=p.published_at,
                       created_at=p.created_at)


def _get(s: Session, name: str, version: str) -> Pack:
    p = s.scalar(select(Pack).where(Pack.name == name, Pack.version == version))
    if p is None:
        raise not_found("Pack")
    return p


def _require(principal: CurrentPrincipal, perm: P) -> None:
    if not principal.has_platform(perm):
        raise forbidden()


@router.get("/packs", response_model=list[PackSummary])
def list_packs(_: CurrentPrincipal, s: DB, type: str | None = None, status: PackStatus | None = None,
               name: str | None = None) -> list[PackSummary]:
    stmt = select(Pack).order_by(Pack.name, Pack.version_sort.desc())
    if type:
        stmt = stmt.where(Pack.type == type)
    if status:
        stmt = stmt.where(Pack.status == status)
    if name:
        stmt = stmt.where(Pack.name == name)
    return [_summary(p) for p in s.scalars(stmt)]


@router.get("/packs/schema")
def pack_schema(_: CurrentPrincipal) -> dict[str, Any]:
    return manifest_json_schema()


class PlacementOut(BaseModel):
    type: str
    area: str
    detail: str


@router.get("/packs/control-types", response_model=list[PlacementOut])
def control_types(_: CurrentPrincipal) -> list[PlacementOut]:
    return [PlacementOut(type=t.value, **PLACEMENT[t]) for t in ControlType]


class ComposeIn(BaseModel):
    packs: list[str] = Field(min_length=1, max_length=50)


@router.post("/packs/compose")
def compose_preview(body: ComposeIn, _: CurrentPrincipal, s: DB) -> dict[str, Any]:
    """Preview what a set of published packs adds together, with conflicts and placements."""
    manifests = []
    for ref in body.packs:
        try:
            p = registry.get_by_ref(s, ref)
        except ValueError as e:
            raise Problem(422, "validation", str(e)) from e
        if p is None:
            raise Problem(422, "validation", f"{ref} is not published")
        manifests.append(registry.manifest_of(p))
    return to_json(compose(manifests))


@router.get("/packs/{name}/diff")
def pack_diff(name: str, from_version: str, to_version: str, _: CurrentPrincipal, s: DB) -> dict[str, Any]:
    a, b = _get(s, name, from_version), _get(s, name, to_version)
    return registry.diff_manifests(registry.manifest_of(a), registry.manifest_of(b))


@router.get("/packs/{name}/{version}", response_model=PackDetail)
def get_pack(name: str, version: str, _: CurrentPrincipal, s: DB) -> PackDetail:
    p = _get(s, name, version)
    files = s.scalars(select(PackFile).where(PackFile.pack_id == p.id).order_by(PackFile.path))
    others = [v for v in s.scalars(select(Pack.version).where(Pack.name == name).order_by(Pack.version_sort.desc()))]
    return PackDetail(**_summary(p).model_dump(), manifest=p.manifest, digest=p.digest,
                      files=[PackFileOut(path=f.path, size=f.size, sha256=f.sha256) for f in files],
                      test_report=p.test_report, reviewed_by_role=p.reviewed_by_role, reviewed_at=p.reviewed_at,
                      created_by=p.created_by, published_by=p.published_by, other_versions=others)


class FileContent(BaseModel):
    path: str
    text: str | None
    size: int
    binary: bool


@router.get("/packs/{name}/{version}/file", response_model=FileContent)
def get_pack_file(name: str, version: str, path: str, _: CurrentPrincipal, s: DB) -> FileContent:
    p = _get(s, name, version)
    f = s.get(PackFile, (p.id, path))
    if f is None:
        raise not_found("File")
    try:
        return FileContent(path=f.path, text=f.content.decode("utf-8"), size=f.size, binary=False)
    except UnicodeDecodeError:
        return FileContent(path=f.path, text=None, size=f.size, binary=True)


class BundleIn(BaseModel):
    files: dict[str, str] = Field(description="path -> base64 content; must include pack.yaml")


@router.post("/packs", response_model=PackSummary, status_code=201)
def register(body: BundleIn, principal: CurrentPrincipal, s: DB) -> PackSummary:
    _require(principal, P.PACK_PUBLISH)
    try:
        files = {k: base64.b64decode(v, validate=True) for k, v in body.files.items()}
    except (binascii.Error, ValueError) as e:
        raise Problem(422, "validation", "File contents must be base64-encoded") from e
    try:
        return _summary(registry.register_draft(s, files, principal.actor))
    except registry.PackError as e:
        raise _err(e) from e


@router.post("/packs/{name}/{version}/test")
def test(name: str, version: str, principal: CurrentPrincipal, s: DB) -> dict[str, Any]:
    _require(principal, P.PACK_PUBLISH)
    try:
        return registry.test_pack(s, _get(s, name, version), principal.actor)
    except registry.PackError as e:
        raise _err(e) from e


class ReviewIn(BaseModel):
    reviewer_name: str = Field(min_length=3, max_length=200)
    reviewer_role: str = Field(min_length=3, max_length=200, description="e.g. 'SOX specialist, external auditor'")


@router.post("/packs/{name}/{version}/review", response_model=PackSummary)
def review(name: str, version: str, body: ReviewIn, principal: CurrentPrincipal, s: DB) -> PackSummary:
    _require(principal, P.PACK_REVIEW)
    try:
        return _summary(registry.record_review(s, _get(s, name, version), principal.actor, body.reviewer_name,
                                               body.reviewer_role))
    except registry.PackError as e:
        raise _err(e) from e


@router.post("/packs/{name}/{version}/publish", response_model=PackSummary)
def publish(name: str, version: str, principal: CurrentPrincipal, s: DB) -> PackSummary:
    _require(principal, P.PACK_PUBLISH)
    try:
        return _summary(registry.publish(s, _get(s, name, version), principal.actor))
    except registry.PackError as e:
        raise _err(e) from e


class DeprecateIn(BaseModel):
    reason: str = Field(min_length=10, max_length=1000)


@router.post("/packs/{name}/{version}/deprecate", response_model=PackSummary)
def deprecate(name: str, version: str, body: DeprecateIn, principal: CurrentPrincipal, s: DB) -> PackSummary:
    _require(principal, P.PACK_PUBLISH)
    try:
        return _summary(registry.deprecate(s, _get(s, name, version), principal.actor, body.reason))
    except registry.PackError as e:
        raise _err(e) from e
