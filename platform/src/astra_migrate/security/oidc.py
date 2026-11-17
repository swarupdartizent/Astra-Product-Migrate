"""OpenID Connect access-token validation (E01.F2.S1).

Any standards-compliant issuer works: Keycloak locally, Microsoft Entra ID or Okta in production
(SAML identity providers are brokered to OIDC by the identity provider). Several issuers can be
trusted at once. Signing keys are fetched from each issuer's JWKS and refreshed when an unknown
key id appears, so key rotation needs no restart.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from jwt import PyJWK

ALLOWED_ALGS = ["RS256", "RS384", "RS512", "PS256", "ES256", "ES384"]


class TokenError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Claims:
    issuer: str
    subject: str
    email: str | None
    email_verified: bool
    name: str | None
    amr: tuple[str, ...]
    acr: str | None
    auth_time: int | None
    issued_at: int
    raw: dict[str, Any]


class _IssuerKeys:
    def __init__(self, issuer: str, http: httpx.Client) -> None:
        self.issuer = issuer
        self._http = http
        self._keys: dict[str, PyJWK] = {}
        self._jwks_uri: str | None = None
        self._fetched_at = 0.0
        self._lock = threading.Lock()

    def _refresh(self) -> None:
        if self._jwks_uri is None:
            disc = self._http.get(f"{self.issuer}/.well-known/openid-configuration")
            disc.raise_for_status()
            meta = disc.json()
            if meta.get("issuer", "").rstrip("/") != self.issuer:
                raise TokenError("issuer metadata does not match the configured issuer")
            self._jwks_uri = meta["jwks_uri"]
        r = self._http.get(self._jwks_uri)
        r.raise_for_status()
        keys: dict[str, PyJWK] = {}
        for k in r.json().get("keys", []):
            if k.get("use", "sig") == "sig" and "kid" in k:
                try:
                    keys[k["kid"]] = PyJWK(k)
                except jwt.PyJWTError:
                    continue
        self._keys = keys
        self._fetched_at = time.monotonic()

    def get(self, kid: str) -> PyJWK:
        with self._lock:
            if kid not in self._keys and time.monotonic() - self._fetched_at > 10:
                self._refresh()
            if kid not in self._keys:
                raise TokenError("token signed with an unknown key")
            return self._keys[kid]


class OidcValidator:
    def __init__(self, issuers: list[str], audience: str, http: httpx.Client | None = None,
                 leeway_s: int = 30) -> None:
        self._http = http or httpx.Client(timeout=5.0)
        self._issuers = {i: _IssuerKeys(i, self._http) for i in issuers}
        self._audience = audience
        self._leeway = leeway_s

    def validate(self, token: str) -> Claims:
        try:
            header = jwt.get_unverified_header(token)
            unverified = jwt.decode(token, options={"verify_signature": False})
        except jwt.PyJWTError as e:
            raise TokenError("malformed token") from e
        iss = str(unverified.get("iss", "")).rstrip("/")
        if iss not in self._issuers:
            raise TokenError("token issuer is not trusted")
        if header.get("alg") not in ALLOWED_ALGS:
            raise TokenError("token algorithm is not allowed")
        key = self._issuers[iss].get(str(header.get("kid", "")))
        try:
            claims: dict[str, Any] = jwt.decode(
                token, key=key, algorithms=ALLOWED_ALGS, audience=self._audience, issuer=unverified["iss"],
                leeway=self._leeway, options={"require": ["exp", "iat", "sub", "iss", "aud"]},
            )
        except jwt.ExpiredSignatureError as e:
            raise TokenError("token expired") from e
        except jwt.PyJWTError as e:
            raise TokenError(f"token rejected: {e}") from e
        amr = claims.get("amr") or []
        email = claims.get("email")
        if not email and "@" in str(claims.get("preferred_username", "")):
            email = claims["preferred_username"]  # Entra ID puts the UPN here
        return Claims(
            issuer=iss,
            subject=str(claims["sub"]),
            email=str(email).lower() if email else None,
            email_verified=bool(claims.get("email_verified", False)),
            name=claims.get("name") or claims.get("preferred_username"),
            amr=tuple(str(a) for a in (amr if isinstance(amr, list) else [amr])),
            acr=str(claims["acr"]) if claims.get("acr") is not None else None,
            auth_time=int(claims["auth_time"]) if claims.get("auth_time") else None,
            issued_at=int(claims["iat"]),
            raw=claims,
        )
