# mypy: disable-error-code="no-untyped-call"
"""Blueprint history in git (E03.F1.S1: "Blueprints are stored in Git with full history").

One repository per tenant, kept in the tenant's own storage area; one folder per project. Every saved
version is a commit whose author is the person who saved it and whose message is their reason.
Locally the repositories live under `.local/data`; in Azure under the tenant's file share.
"""

from __future__ import annotations

import shutil
import threading
import uuid
from pathlib import Path

from dulwich import porcelain
from dulwich.object_store import tree_lookup_path
from dulwich.objects import Blob, Commit
from dulwich.repo import Repo

from astra_migrate.config import REPO_ROOT, get_settings

_locks: dict[uuid.UUID, threading.Lock] = {}
_guard = threading.Lock()


def _lock(tenant_id: uuid.UUID) -> threading.Lock:
    with _guard:
        return _locks.setdefault(tenant_id, threading.Lock())


def data_root() -> Path:
    p = Path(get_settings().data_dir)
    return p if p.is_absolute() else REPO_ROOT / p


def repo_path(tenant_id: uuid.UUID) -> Path:
    return data_root() / "tenants" / str(tenant_id) / "blueprints"


def _open(tenant_id: uuid.UUID) -> Repo:
    path = repo_path(tenant_id)
    if (path / ".git").exists():
        return Repo(str(path))
    path.mkdir(parents=True, exist_ok=True)
    return Repo.init(str(path))


def commit_blueprint(tenant_id: uuid.UUID, project_id: uuid.UUID, text: str, author_name: str, author_email: str,
                     message: str) -> str:
    rel = f"projects/{project_id}/blueprint.yaml"
    with _lock(tenant_id):
        repo = _open(tenant_id)
        try:
            target = Path(repo.path) / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")
            porcelain.add(repo, paths=[str(target)])
            identity = f"{author_name} <{author_email}>".encode()
            sha = porcelain.commit(repo, message=message.encode(), author=identity, committer=identity,
                                   commit_timezone=0, author_timezone=0)
            return sha.decode() if isinstance(sha, bytes) else str(sha)
        finally:
            repo.close()


def read_at(tenant_id: uuid.UUID, project_id: uuid.UUID, sha: str) -> str:
    """Read the blueprint as committed, to prove the stored copy matches git history."""
    rel = f"projects/{project_id}/blueprint.yaml".encode()
    with _lock(tenant_id):
        repo = _open(tenant_id)
        try:
            commit = repo[sha.encode()]
            assert isinstance(commit, Commit)
            _, oid = tree_lookup_path(repo.__getitem__, commit.tree, rel)
            blob = repo[oid]
            assert isinstance(blob, Blob)
            return str(blob.data.decode("utf-8"))
        finally:
            repo.close()


def history(tenant_id: uuid.UUID, project_id: uuid.UUID) -> list[dict[str, str]]:
    rel = f"projects/{project_id}/blueprint.yaml".encode()
    with _lock(tenant_id):
        repo = _open(tenant_id)
        try:
            out = []
            for entry in repo.get_walker(paths=[rel]):
                c = entry.commit
                out.append({"sha": c.id.decode(), "author": c.author.decode(), "message": c.message.decode().strip(),
                            "time": str(c.commit_time)})
            return out
        finally:
            repo.close()


def delete_tenant_repo(tenant_id: uuid.UUID) -> None:
    with _lock(tenant_id):
        shutil.rmtree(repo_path(tenant_id).parent, ignore_errors=True)
