"""Pack command line (E04.F3.S1, first part).

    python -m astra_migrate.packs.cli validate <pack-folder> [<pack-folder> ...]
    python -m astra_migrate.packs.cli bundle <pack-folder> -o bundle.json
    python -m astra_migrate.packs.cli upload <pack-folder> [--api http://localhost:8000] (token in ASTRA_API_TOKEN)

`validate` runs the same schema and contract checks as the registry, offline. `upload` registers a draft through
the API, so every permission and audit rule applies; testing, review and publishing happen in the registry.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path

import httpx

from astra_migrate.packs.content import content_problems
from astra_migrate.packs.registry import PackError, parse_manifest

SKIP = {"__pycache__", ".DS_Store"}


def read_folder(folder: Path) -> dict[str, bytes]:
    if not (folder / "pack.yaml").exists():
        raise SystemExit(f"{folder} has no pack.yaml")
    return {str(f.relative_to(folder)).replace("\\", "/"): f.read_bytes()
            for f in sorted(folder.rglob("*")) if f.is_file() and not (set(f.parts) & SKIP)}


def validate(folder: Path) -> bool:
    files = read_folder(folder)
    try:
        m = parse_manifest(files["pack.yaml"])
    except PackError as e:
        print(f"FAIL {folder}: {e}")
        for d in e.details:
            print(f"     {d['field']}: {d['message']}")
        return False
    problems = content_problems(m, files)
    if problems:
        print(f"FAIL {folder} ({m.ref}): content does not match the {m.type.value} contract")
        for p in problems:
            print(f"     {p['field']}: {p['message']}")
        return False
    print(f"OK   {m.ref} ({m.type.value}, {len(files)} file(s))")
    return True


def bundle(folder: Path) -> dict[str, dict[str, str]]:
    return {"files": {p: base64.b64encode(b).decode() for p, b in read_folder(folder).items()}}


def load_drafts(folders: list[Path]) -> int:
    """Register drafts without the API, for a local environment. Testing, golden runs, review and publishing
    still happen in the registry, by people."""
    from astra_migrate import audit
    from astra_migrate.config import get_settings
    from astra_migrate.db.control import session_scope
    from astra_migrate.packs.registry import register_draft

    if get_settings().environment != "local":
        print("load-drafts runs only in a local environment. Use upload.", file=sys.stderr)
        return 2
    ok = True
    for folder in folders:
        if not validate(folder):
            ok = False
            continue
        try:
            with session_scope() as s:
                p = register_draft(s, read_folder(folder), audit.Actor.system("pack-loader"))
                print(f"     {p.name}@{p.version} is {p.status}")
        except PackError as e:
            ok = False
            print(f"FAIL {folder}: {e}")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="astra-packs", description="Validate, bundle and upload packs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate")
    v.add_argument("folders", nargs="+", type=Path)
    b = sub.add_parser("bundle")
    b.add_argument("folder", type=Path)
    b.add_argument("-o", "--out", type=Path, required=True)
    u = sub.add_parser("upload")
    u.add_argument("folder", type=Path)
    u.add_argument("--api", default="http://localhost:8000")
    ld = sub.add_parser("load-drafts", help="Local environments only: register folders as drafts directly in the "
                                            "registry, recorded in the audit log as the system pack loader")
    ld.add_argument("folders", nargs="+", type=Path)
    args = ap.parse_args(argv)

    if args.cmd == "load-drafts":
        return load_drafts(args.folders)

    if args.cmd == "validate":
        return 0 if all([validate(f) for f in args.folders]) else 1
    if args.cmd == "bundle":
        if not validate(args.folder):
            return 1
        args.out.write_text(json.dumps(bundle(args.folder)), encoding="utf-8")
        print(f"wrote {args.out}")
        return 0
    token = os.environ.get("ASTRA_API_TOKEN")
    if not token:
        print("Set ASTRA_API_TOKEN to a bearer token for a user who may publish packs.", file=sys.stderr)
        return 2
    if not validate(args.folder):
        return 1
    r = httpx.post(f"{args.api.rstrip('/')}/api/v1/packs", json=bundle(args.folder),
                   headers={"Authorization": f"Bearer {token}"}, timeout=120)
    if r.status_code != 201:
        print(f"Upload refused (HTTP {r.status_code}): {r.text[:2000]}", file=sys.stderr)
        return 1
    body = r.json()
    print(f"Registered {body.get('name')}@{body.get('version')} as {body.get('status')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
