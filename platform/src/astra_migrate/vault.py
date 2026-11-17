"""Secret store and key service over a Vault-compatible API (OpenBao locally).

Two interfaces are used by the rest of the platform:
- `SecretStore`: versioned secrets (connector credentials, tenant database passwords).
- `KeyService`: one non-exportable encryption key per tenant, plus platform signing keys.

The Azure implementation (Key Vault) provides the same interface; nothing outside this module
talks to the vault directly.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import httpx

from astra_migrate.config import get_settings
from astra_migrate.logging import register_secret

KV_MOUNT = "astra-kv"


class VaultError(RuntimeError):
    pass


@dataclass(frozen=True)
class SecretVersion:
    value: str
    version: int


class VaultClient:
    def __init__(self, url: str, token: str, timeout: float = 10.0) -> None:
        register_secret(token)
        self._http = httpx.Client(base_url=url.rstrip("/") + "/v1/", headers={"X-Vault-Token": token}, timeout=timeout)

    def _call(self, method: str, path: str, json: dict[str, Any] | None = None, ok: tuple[int, ...] = (200, 204)
              ) -> dict[str, Any]:
        r = self._http.request(method, path, json=json)
        if r.status_code not in ok:
            # Never include request bodies in errors: they may hold secrets.
            raise VaultError(f"vault {method} {path} failed with HTTP {r.status_code}: {r.text[:300]}")
        return r.json() if r.content else {}

    def health(self) -> bool:
        r = self._http.get("sys/health")
        return r.status_code == 200

    # ------------------------------------------------------------------ secrets (KV v2)
    def put_secret(self, path: str, value: str) -> int:
        register_secret(value)
        body = self._call("POST", f"{KV_MOUNT}/data/{path}", {"data": {"value": value}})
        return int(body["data"]["version"])

    def get_secret(self, path: str, version: int | None = None) -> SecretVersion:
        q = f"?version={version}" if version else ""
        body = self._call("GET", f"{KV_MOUNT}/data/{path}{q}")
        value = str(body["data"]["data"]["value"])
        register_secret(value)
        return SecretVersion(value=value, version=int(body["data"]["metadata"]["version"]))

    def delete_secret(self, path: str) -> None:
        """Permanently delete one secret with all its versions."""
        self._call("DELETE", f"{KV_MOUNT}/metadata/{path}")

    def delete_secret_tree(self, prefix: str) -> None:
        """Permanently delete every secret under a prefix (all versions)."""
        r = self._http.request("LIST", f"{KV_MOUNT}/metadata/{prefix}")
        if r.status_code == 404:
            return
        if r.status_code != 200:
            raise VaultError(f"vault list {prefix} failed with HTTP {r.status_code}")
        for key in r.json()["data"]["keys"]:
            child = f"{prefix.rstrip('/')}/{key}"
            if key.endswith("/"):
                self.delete_secret_tree(child)
            else:
                self._call("DELETE", f"{KV_MOUNT}/metadata/{child}")

    # ------------------------------------------------------------------ keys (transit)
    def create_key(self, name: str, key_type: str = "aes256-gcm96") -> None:
        self._call("POST", f"transit/keys/{name}", {"type": key_type, "exportable": False})

    def key_info(self, name: str) -> dict[str, Any] | None:
        r = self._http.get(f"transit/keys/{name}")
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise VaultError(f"vault key read failed with HTTP {r.status_code}")
        return dict(r.json()["data"])

    def destroy_key(self, name: str) -> None:
        """Crypto-shred: once deleted, data encrypted under this key cannot be recovered."""
        if self.key_info(name) is None:
            return
        self._call("POST", f"transit/keys/{name}/config", {"deletion_allowed": True})
        self._call("DELETE", f"transit/keys/{name}")

    def encrypt(self, key: str, plaintext: bytes, context: bytes | None = None) -> str:
        body: dict[str, Any] = {"plaintext": base64.b64encode(plaintext).decode()}
        if context:
            body["context"] = base64.b64encode(context).decode()
        return str(self._call("POST", f"transit/encrypt/{key}", body)["data"]["ciphertext"])

    def decrypt(self, key: str, ciphertext: str, context: bytes | None = None) -> bytes:
        body: dict[str, Any] = {"ciphertext": ciphertext}
        if context:
            body["context"] = base64.b64encode(context).decode()
        return base64.b64decode(self._call("POST", f"transit/decrypt/{key}", body)["data"]["plaintext"])

    def ensure_signing_key(self, name: str) -> None:
        if self.key_info(name) is None:
            self.create_key(name, key_type="ed25519")

    def sign(self, key: str, message: bytes) -> tuple[str, int]:
        body = self._call("POST", f"transit/sign/{key}", {"input": base64.b64encode(message).decode()})
        sig = str(body["data"]["signature"])
        return sig, int(sig.split(":")[1].lstrip("v"))

    def verify(self, key: str, message: bytes, signature: str) -> bool:
        body = self._call("POST", f"transit/verify/{key}",
                          {"input": base64.b64encode(message).decode(), "signature": signature})
        return bool(body["data"]["valid"])


@lru_cache(maxsize=1)
def get_vault() -> VaultClient:
    s = get_settings()
    return VaultClient(s.vault_url, s.vault_token.get_secret_value())
