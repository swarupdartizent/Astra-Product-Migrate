"""Test fixtures.

Integration tests run against the real local stack (`py -3.13 tools/dev.py up`): real Postgres
servers per region, the real vault and real per-tenant keys. They use a separate control database
(`astra_control_test`) so development data is untouched.

Tokens are issued by an in-process OIDC issuer with its own RSA key, served over HTTP with real
discovery and JWKS documents, so the API validates them exactly as it validates production tokens.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

REPO = Path(__file__).resolve().parents[2]
TEST_ENV = REPO / ".local" / "test.env"
if not TEST_ENV.exists():
    raise RuntimeError("Local stack not bootstrapped. Run: py -3.13 tools/dev.py up")
for line in TEST_ENV.read_text(encoding="utf-8").splitlines():
    if "=" in line:
        k, v = line.split("=", 1)
        os.environ[k] = v

# ------------------------------------------------------------------ in-process OIDC issuer
_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_KID = "test-" + uuid.uuid4().hex[:8]
_PUB = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(_KEY.public_key()))
_PUB.update({"kid": _KID, "use": "sig", "alg": "RS256"})


class _Issuer(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        base = f"http://127.0.0.1:{self.server.server_port}"  # type: ignore[attr-defined]
        if self.path == "/.well-known/openid-configuration":
            body = {"issuer": base, "jwks_uri": f"{base}/jwks"}
        elif self.path == "/jwks":
            body = {"keys": [_PUB]}
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args: Any) -> None:
        pass


_server = ThreadingHTTPServer(("127.0.0.1", 0), _Issuer)
threading.Thread(target=_server.serve_forever, daemon=True).start()
ISSUER = f"http://127.0.0.1:{_server.server_port}"
ADMIN_EMAIL = f"test.admin+{uuid.uuid4().hex[:8]}@example.com"  # issuer URL changes per run
os.environ["ASTRA_OIDC_ISSUERS"] = ISSUER
os.environ["ASTRA_BOOTSTRAP_ADMIN_EMAILS"] = ADMIN_EMAIL
os.environ.pop("ASTRA_OTLP_ENDPOINT", None)


def make_token(email: str, *, name: str | None = None, mfa: bool = True, auth_age_s: int = 0,
               audience: str = "astra-api", issuer: str | None = None, key: Any = None, expires_in: int = 300,
               email_verified: bool = True, sub: str | None = None) -> str:
    now = int(time.time())
    claims = {"iss": issuer or ISSUER, "sub": sub or "sub-" + email, "aud": audience, "iat": now,
              "exp": now + expires_in, "auth_time": now - auth_age_s, "email": email,
              "email_verified": email_verified, "name": name or email.split("@")[0].replace(".", " ").title(),
              "amr": ["pwd", "otp"] if mfa else ["pwd"]}
    return jwt.encode(claims, key or _KEY, algorithm="RS256", headers={"kid": _KID})


# ------------------------------------------------------------------ database and app

@pytest.fixture(scope="session", autouse=True)
def _migrated() -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(REPO / "platform" / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO / "platform" / "src" / "astra_migrate" / "migrations"))
    command.upgrade(cfg, "head")


@pytest.fixture(scope="session")
def client(_migrated: None) -> Iterator[Any]:
    from fastapi.testclient import TestClient

    from astra_migrate.api.app import app

    with TestClient(app) as c:
        yield c


Headers = dict[str, str]


def wait_job(client: Any, headers: Headers, job_id: str, timeout_s: float = 90) -> dict[str, Any]:
    """Wait for a background job (run by the API's own worker threads) to finish."""
    deadline = time.time() + timeout_s
    while True:
        j = client.get(f"/api/v1/jobs/{job_id}", headers=headers)
        assert j.status_code == 200, j.text
        if j.json()["status"] in ("succeeded", "failed", "cancelled"):
            return dict(j.json())
        if time.time() > deadline:
            raise AssertionError(f"job {job_id} still {j.json()['status']} after {timeout_s}s: {j.json()}")
        time.sleep(0.2)


class _FreshBearer(dict[str, str]):
    """Session-wide headers whose short-lived token is re-minted before it expires, so a slow full run (a loaded
    machine) does not fail late with 401s. Each token still lives five minutes, as a real one would."""

    def __init__(self, email: str, name: str) -> None:
        super().__init__()
        self._email, self._name, self._expires = email, name, 0.0
        self._refresh()

    def _refresh(self) -> None:
        if time.time() > self._expires - 60:
            super().__setitem__("Authorization", f"Bearer {make_token(self._email, name=self._name)}")
            self._expires = time.time() + 300

    def __getitem__(self, key: str) -> str:
        self._refresh()
        return super().__getitem__(key)

    def items(self) -> Any:
        self._refresh()
        return super().items()

    def keys(self) -> Any:
        self._refresh()
        return super().keys()

    def __iter__(self) -> Any:
        self._refresh()
        return super().__iter__()


@pytest.fixture(scope="session")
def admin(client: Any) -> Headers:
    h = _FreshBearer(ADMIN_EMAIL, "Test Admin")
    assert client.get("/api/v1/me", headers=h).status_code == 200
    return h


@pytest.fixture
def user_factory(client: Any, admin: Headers) -> Callable[..., tuple[Headers, str]]:
    """Create a signed-in person with the given grants. Returns (headers, user_id)."""

    def make(*grants: tuple[str, str, str | None], mfa: bool = True, auth_age_s: int = 0) -> tuple[Headers, str]:
        email = f"user-{uuid.uuid4().hex[:10]}@example.com"
        h = {"Authorization": f"Bearer {make_token(email, mfa=mfa, auth_age_s=auth_age_s)}"}
        me = client.get("/api/v1/me", headers=h)
        assert me.status_code == 200, me.text
        uid = me.json()["id"]
        for role, scope_type, scope_id in grants:
            r = client.post("/api/v1/role-assignments", headers=admin,
                            json={"user_id": uid, "role": role, "scope_type": scope_type, "scope_id": scope_id})
            assert r.status_code == 201, r.text
        return h, uid

    return make


@pytest.fixture
def tenant_factory(client: Any, admin: Headers) -> Iterator[Callable[..., dict[str, Any]]]:
    created: list[dict[str, Any]] = []

    def make(region: str = "local-a", **kw: Any) -> dict[str, Any]:
        slug = "t-" + uuid.uuid4().hex[:10]
        body = {"slug": slug, "name": f"Test estate {slug}", "region_code": region, **kw}
        r = client.post("/api/v1/tenants", headers=admin, json=body)
        assert r.status_code == 201, r.text
        assert r.json()["status"] == "provisioning" and r.json()["active_job"] is not None, r.json()
        job = wait_job(client, admin, r.json()["active_job"]["id"])
        assert job["status"] == "succeeded", job
        t = client.get(f"/api/v1/tenants/{r.json()['id']}", headers=admin).json()
        assert t["status"] == "active", t
        created.append(t)
        return dict(t)

    yield make
    for t in created:
        client.post(f"/api/v1/tenants/{t['id']}/delete", headers=admin,
                    json={"confirm_slug": t["slug"], "reason": "test teardown cleanup"})
