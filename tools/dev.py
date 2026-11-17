"""Astra Migrate developer tool.

    py -3.13 tools/dev.py up        start the local stack and bootstrap it (idempotent)
    py -3.13 tools/dev.py down      stop the stack (data volumes are kept)
    py -3.13 tools/dev.py reset     stop the stack and delete all local data and secrets
    py -3.13 tools/dev.py status    show service state
    py -3.13 tools/dev.py api       migrate the control database and run the API on :8000 (auto-reload)

All generated secrets live in .local/ (gitignored). Nothing secret is written to the repository.
Uses only the standard library so it runs before any dependency is installed.
"""

from __future__ import annotations

import json
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local"
SECRETS = LOCAL / "secrets"
COMPOSE_FILE = ROOT / "infra" / "local" / "compose.yaml"
COMPOSE_ENV = LOCAL / "compose.env"
API_ENV = LOCAL / "api.env"
BAO_INIT = LOCAL / "openbao-init.json"
BAO_URL = "http://127.0.0.1:18200"
KC_URL = "http://127.0.0.1:18080"

PG_PORTS = {"pg-a": 15432, "pg-b": 15433}


def log(msg: str) -> None:
    print(f"[dev] {msg}", flush=True)


def secret(name: str, nbytes: int = 24) -> str:
    """Return a persistent random secret, creating it on first use."""
    SECRETS.mkdir(parents=True, exist_ok=True)
    path = SECRETS / name
    if not path.exists():
        path.write_text(secrets.token_urlsafe(nbytes), encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()


def compose(*args: str, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess[str]:
    cmd = ["docker", "compose", "-f", str(COMPOSE_FILE), "--env-file", str(COMPOSE_ENV), *args]
    return subprocess.run(cmd, check=check, text=True, capture_output=capture)


def psql(service: str, sql: str, db: str = "postgres") -> str:
    out = compose(
        "exec", "-T", service, "psql", "-v", "ON_ERROR_STOP=1", "-U", "astra_root", "-d", db, "-tAc", sql,
        capture=True,
    )
    return out.stdout.strip()


def wait_for(desc: str, fn, timeout: float = 180.0) -> None:
    start = time.time()
    while True:
        try:
            if fn():
                log(f"{desc}: ready")
                return
        except Exception:  # noqa: BLE001 - polling until ready
            pass
        if time.time() - start > timeout:
            raise SystemExit(f"{desc} did not become ready within {timeout:.0f}s")
        time.sleep(2)


def http(method: str, url: str, body: dict | None = None, token: str | None = None,
         headers: dict | None = None, form: bool = False) -> tuple[int, dict | str]:
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        if form:
            from urllib.parse import urlencode
            data = urlencode(body).encode()
            hdrs["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
    if token:
        hdrs["X-Vault-Token" if url.startswith(BAO_URL) else "Authorization"] = (
            token if url.startswith(BAO_URL) else f"Bearer {token}"
        )
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode() or "{}"
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return e.code, raw


# ---------------------------------------------------------------- bootstrap steps

def write_env_files() -> None:
    LOCAL.mkdir(exist_ok=True)
    secret("pg_root_password")
    COMPOSE_ENV.write_text(
        f"KEYCLOAK_DB_PASSWORD={secret('keycloak_db_password')}\n"
        f"KEYCLOAK_ADMIN_PASSWORD={secret('keycloak_admin_password')}\n",
        encoding="utf-8",
    )


def bootstrap_postgres() -> None:
    root_pw = secret("pg_root_password")
    for svc in PG_PORTS:
        wait_for(f"postgres {svc}", lambda s=svc: psql(s, "select 1") == "1")
    # Keycloak role (created by init-a.sql) gets its password from .local/secrets
    psql("pg-a", f"ALTER ROLE keycloak PASSWORD '{secret('keycloak_db_password')}'")

    # Control plane: owner role runs migrations; app role has least privilege (granted by migrations).
    owner_pw, app_pw = secret("pg_control_owner_password"), secret("pg_control_app_password")
    for role, pw in (("astra_control_owner", owner_pw), ("astra_control_app", app_pw)):
        exists = psql("pg-a", f"select 1 from pg_roles where rolname='{role}'")
        verb = "ALTER" if exists else "CREATE"
        psql("pg-a", f"{verb} ROLE {role} LOGIN PASSWORD '{pw}'")
    # astra_control serves the running platform; astra_control_test is used only by the test suite.
    for dbname in ("astra_control", "astra_control_test"):
        if not psql("pg-a", f"select 1 from pg_database where datname='{dbname}'"):
            psql("pg-a", f"CREATE DATABASE {dbname} OWNER astra_control_owner")
        psql("pg-a", f"REVOKE ALL ON DATABASE {dbname} FROM PUBLIC", db="postgres")
        psql("pg-a", f"GRANT CONNECT ON DATABASE {dbname} TO astra_control_app", db="postgres")

    # Tenant provisioner: may create databases and roles on each regional server, nothing else.
    prov_pw = secret("pg_provisioner_password")
    for svc in PG_PORTS:
        exists = psql(svc, "select 1 from pg_roles where rolname='astra_provisioner'")
        verb = "ALTER" if exists else "CREATE"
        psql(svc, f"{verb} ROLE astra_provisioner LOGIN CREATEDB CREATEROLE PASSWORD '{prov_pw}'")
        psql(svc, "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC")
        psql(svc, "GRANT CONNECT ON DATABASE postgres TO astra_provisioner")
        psql(svc, "GRANT pg_signal_backend TO astra_provisioner")  # DROP DATABASE ... WITH (FORCE)
    _ = root_pw


def bootstrap_openbao() -> str:
    wait_for("openbao", lambda: http("GET", f"{BAO_URL}/v1/sys/seal-status")[0] == 200)
    _, status = http("GET", f"{BAO_URL}/v1/sys/seal-status")
    assert isinstance(status, dict)
    if not status.get("initialized"):
        code, init = http("PUT", f"{BAO_URL}/v1/sys/init", {"secret_shares": 1, "secret_threshold": 1})
        if code != 200:
            raise SystemExit(f"openbao init failed: {init}")
        BAO_INIT.write_text(json.dumps(init), encoding="utf-8")
        log("openbao: initialised (unseal key and root token saved in .local/openbao-init.json)")
    init = json.loads(BAO_INIT.read_text(encoding="utf-8"))
    _, status = http("GET", f"{BAO_URL}/v1/sys/seal-status")
    if isinstance(status, dict) and status.get("sealed"):
        http("PUT", f"{BAO_URL}/v1/sys/unseal", {"key": init["keys"][0]})
    root = init["root_token"]

    _, mounts = http("GET", f"{BAO_URL}/v1/sys/mounts", token=root)
    mounts = mounts if isinstance(mounts, dict) else {}
    if "transit/" not in mounts.get("data", mounts):
        http("POST", f"{BAO_URL}/v1/sys/mounts/transit", {"type": "transit"}, token=root)
    if "astra-kv/" not in mounts.get("data", mounts):
        http("POST", f"{BAO_URL}/v1/sys/mounts/astra-kv", {"type": "kv", "options": {"version": "2"}}, token=root)

    # Least-privilege policy for the platform API.
    policy = """
path "transit/keys/tenant-*"          { capabilities = ["create", "read", "update", "delete"] }
path "transit/keys/tenant-*/config"   { capabilities = ["update"] }
path "transit/keys/tenant-*/rotate"   { capabilities = ["update"] }
path "transit/encrypt/tenant-*"       { capabilities = ["update"] }
path "transit/decrypt/tenant-*"       { capabilities = ["update"] }
path "transit/datakey/plaintext/tenant-*" { capabilities = ["update"] }
path "transit/keys/platform-*"        { capabilities = ["create", "read", "update"] }
path "transit/sign/platform-*"        { capabilities = ["update"] }
path "transit/verify/platform-*"      { capabilities = ["update"] }
path "astra-kv/data/*"                { capabilities = ["create", "read", "update", "delete"] }
path "astra-kv/metadata/*"            { capabilities = ["read", "list", "delete"] }
path "astra-kv/destroy/*"             { capabilities = ["update"] }
"""
    http("PUT", f"{BAO_URL}/v1/sys/policies/acl/astra-api", {"policy": policy}, token=root)
    token_file = SECRETS / "openbao_api_token"
    valid = False
    if token_file.exists():
        code, _ = http("GET", f"{BAO_URL}/v1/auth/token/lookup-self", token=token_file.read_text().strip())
        valid = code == 200
    if not valid:
        code, tok = http("POST", f"{BAO_URL}/v1/auth/token/create",
                         {"policies": ["astra-api"], "period": "768h", "no_parent": True,
                          "display_name": "astra-api-local"}, token=root)
        if code != 200:
            raise SystemExit(f"openbao token create failed: {tok}")
        token_file.write_text(tok["auth"]["client_token"], encoding="utf-8")  # type: ignore[index]
    log("openbao: transit + kv mounted, astra-api policy and token ready")
    return root


def kc_admin_token() -> str:
    code, body = http("POST", f"{KC_URL}/realms/master/protocol/openid-connect/token",
                      {"grant_type": "password", "client_id": "admin-cli", "username": "kcadmin",
                       "password": secret("keycloak_admin_password")}, form=True)
    if code != 200:
        raise RuntimeError(f"keycloak admin login failed: {body}")
    return body["access_token"]  # type: ignore[index]


def bootstrap_keycloak() -> None:
    wait_for("keycloak", lambda: http("GET", f"{KC_URL}/realms/astra/.well-known/openid-configuration")[0] == 200,
             timeout=300)
    tok = kc_admin_token()
    base = f"{KC_URL}/admin/realms/astra"

    # AMR claim so the API can see how the user signed in (pwd, otp) and enforce tenant MFA policy.
    _, scopes = http("GET", f"{base}/client-scopes", token=tok)
    if not any(s.get("name") == "astra-amr" for s in scopes):  # type: ignore[union-attr]
        http("POST", f"{base}/client-scopes", {
            "name": "astra-amr", "protocol": "openid-connect",
            "attributes": {"include.in.token.scope": "false"},
            "protocolMappers": [{
                "name": "amr", "protocol": "openid-connect", "protocolMapper": "oidc-amr-mapper",
                "config": {"access.token.claim": "true", "id.token.claim": "true",
                           "introspection.token.claim": "true"},
            }],
        }, token=tok)
        _, scopes = http("GET", f"{base}/client-scopes", token=tok)
    amr_id = next(s["id"] for s in scopes if s["name"] == "astra-amr")  # type: ignore[index,union-attr]
    _, clients = http("GET", f"{base}/clients?clientId=astra-web", token=tok)
    web_id = clients[0]["id"]  # type: ignore[index]
    # Keep redirect URIs and origins in line with the realm file (the import only runs on first start).
    realm = json.loads((ROOT / "infra" / "local" / "keycloak" / "realm-astra.json").read_text(encoding="utf-8"))
    spec = next(c for c in realm["clients"] if c["clientId"] == "astra-web")
    current = clients[0]  # type: ignore[index]
    current.update({"redirectUris": spec["redirectUris"], "webOrigins": spec["webOrigins"]})
    current.setdefault("attributes", {}).update(spec["attributes"])
    http("PUT", f"{base}/clients/{web_id}", current, token=tok)
    http("PUT", f"{base}/clients/{web_id}/default-client-scopes/{amr_id}", token=tok)

    # The AMR mapper reports the reference value of each authenticator the user passed.
    refs = {"auth-username-password-form": "pwd", "auth-otp-form": "otp"}
    _, execs = http("GET", f"{base}/authentication/flows/browser/executions", token=tok)
    for ex in execs:  # type: ignore[union-attr]
        ref = refs.get(ex.get("providerId", ""))
        if ref and not ex.get("authenticationConfig"):
            http("POST", f"{base}/authentication/executions/{ex['id']}/config", {
                "alias": f"amr-{ref}", "config": {"default.reference.value": ref, "default.reference.maxAge": "0"},
            }, token=tok)

    # Bootstrap platform administrator for local use. Password lives only in .local/secrets.
    email = "admin@astra.local"
    _, users = http("GET", f"{base}/users?email={email}&exact=true", token=tok)
    if not users:
        http("POST", f"{base}/users", {
            "username": "platform.admin", "email": email, "emailVerified": True, "enabled": True,
            "firstName": "Platform", "lastName": "Administrator",
            "requiredActions": ["CONFIGURE_TOTP"],  # first sign-in enrols an authenticator app (MFA)
            "credentials": [{"type": "password", "value": secret("local_admin_password", 12),
                             "temporary": False}],
        }, token=tok)
    else:
        uid = users[0]["id"]  # type: ignore[index]
        _, creds = http("GET", f"{base}/users/{uid}/credentials", token=tok)
        if not any(c.get("type") == "otp" for c in creds):  # type: ignore[union-attr]
            http("PUT", f"{base}/users/{uid}", {"requiredActions": ["CONFIGURE_TOTP"]}, token=tok)
    log(f"keycloak: realm 'astra' ready; local admin user {email} (password in .local/secrets/local_admin_password)")


def write_api_env() -> None:
    API_ENV.write_text("\n".join([
        f"ASTRA_CONTROL_DB_URL=postgresql+psycopg://astra_control_app:{secret('pg_control_app_password')}@127.0.0.1:15432/astra_control",
        f"ASTRA_CONTROL_DB_OWNER_URL=postgresql+psycopg://astra_control_owner:{secret('pg_control_owner_password')}@127.0.0.1:15432/astra_control",
        f"ASTRA_PROVISIONER_PASSWORD={secret('pg_provisioner_password')}",
        f"ASTRA_VAULT_URL={BAO_URL}",
        f"ASTRA_VAULT_TOKEN={(SECRETS / 'openbao_api_token').read_text().strip()}",
        # Must match the "iss" Keycloak writes into tokens, which follows the hostname the browser uses.
        "ASTRA_OIDC_ISSUERS=http://localhost:18080/realms/astra",
        "ASTRA_OIDC_AUDIENCE=astra-api",
        "ASTRA_BOOTSTRAP_ADMIN_EMAILS=admin@astra.local",
        "ASTRA_OTLP_ENDPOINT=http://127.0.0.1:14318",
        "ASTRA_REGIONS_FILE=infra/local/regions.yaml",
        "",
    ]), encoding="utf-8")
    # Test-only settings: a separate control database, and the database superuser for tamper tests.
    (LOCAL / "test.env").write_text("\n".join([
        f"ASTRA_CONTROL_DB_URL=postgresql+psycopg://astra_control_app:{secret('pg_control_app_password')}@127.0.0.1:15432/astra_control_test",
        f"ASTRA_CONTROL_DB_OWNER_URL=postgresql+psycopg://astra_control_owner:{secret('pg_control_owner_password')}@127.0.0.1:15432/astra_control_test",
        f"ASTRA_TEST_ROOT_DB_URL=postgresql+psycopg://astra_root:{secret('pg_root_password')}@127.0.0.1:15432/astra_control_test",
        "",
    ]), encoding="utf-8")
    log("wrote .local/api.env and .local/test.env")


def cmd_up() -> None:
    if not shutil.which("docker"):
        raise SystemExit("docker is required")
    write_env_files()
    compose("up", "-d", "pg-a", "pg-b", "openbao", "jaeger")
    bootstrap_postgres()
    bootstrap_openbao()
    compose("up", "-d", "keycloak")
    bootstrap_keycloak()
    write_api_env()
    log("stack is up. Jaeger UI: http://localhost:16686  Keycloak: http://localhost:18080")


def cmd_down() -> None:
    compose("down")


def cmd_reset() -> None:
    compose("down", "-v", check=False)
    if LOCAL.exists():
        shutil.rmtree(LOCAL)
    log("removed all local data and secrets")


def cmd_status() -> None:
    compose("ps")


def cmd_api() -> None:
    """Run the API with auto-reload, using the platform's virtual environment."""
    venv_python = ROOT / "platform" / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if not venv_python.exists():
        raise SystemExit("Install the API first: cd platform && py -3.13 -m uv sync")
    subprocess.run([str(venv_python), "-m", "alembic", "upgrade", "head"], cwd=ROOT / "platform", check=True)
    raise SystemExit(subprocess.call(
        [str(venv_python), "-m", "uvicorn", "astra_migrate.api.app:app", "--port", "8000", "--reload",
         "--reload-dir", "src"], cwd=ROOT / "platform"))


if __name__ == "__main__":
    commands = {"up": cmd_up, "down": cmd_down, "reset": cmd_reset, "status": cmd_status, "api": cmd_api}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        print(__doc__)
        raise SystemExit(2)
    if sys.argv[1] != "reset" and not COMPOSE_ENV.exists():
        write_env_files()
    commands[sys.argv[1]]()
