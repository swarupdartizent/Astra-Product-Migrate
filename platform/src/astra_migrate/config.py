"""Runtime settings. Values come from the environment (prefix ASTRA_) or a dotenv file.

Locally `tools/dev.py up` writes `.local/api.env`; in Azure the same names are set by the
container app from Key Vault references. No secret has a default value.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ASTRA_",
        env_file=(REPO_ROOT / ".local" / "api.env",),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: str = "local"
    version: str = "0.1.0"

    control_db_url: SecretStr
    control_db_owner_url: SecretStr | None = None
    provisioner_user: str = "astra_provisioner"
    provisioner_password: SecretStr

    vault_url: str
    vault_token: SecretStr

    oidc_issuers: str = Field(description="Comma-separated list of trusted OIDC issuer URLs")
    oidc_audience: str = "astra-api"
    # amr values that count as multi-factor sign-in. Entra ID uses "mfa"; Keycloak reports "otp".
    oidc_mfa_amr_values: str = "mfa,otp,hwk,swk,fido"
    bootstrap_admin_emails: str = ""

    regions_file: str = "infra/local/regions.yaml"
    data_dir: str = ".local/data"  # tenant file storage (blueprint git repositories); Azure: file share
    otlp_endpoint: str | None = None
    cors_origins: str = "http://localhost:5273"
    # Job worker threads in the API process. Azure runs workers in their own container and sets this to 0.
    job_workers: int = 2
    # Test environments only: "user:password@host:port" of a SQL Server administrator used to build
    # synthetic golden estates. Never set where customer data lives.
    golden_sqlserver_admin: SecretStr | None = None

    @property
    def issuers(self) -> list[str]:
        return [i.strip().rstrip("/") for i in self.oidc_issuers.split(",") if i.strip()]

    @property
    def mfa_amr_values(self) -> set[str]:
        return {v.strip() for v in self.oidc_mfa_amr_values.split(",") if v.strip()}

    @property
    def bootstrap_admins(self) -> set[str]:
        return {e.strip().lower() for e in self.bootstrap_admin_emails.split(",") if e.strip()}

    @property
    def regions_path(self) -> Path:
        p = Path(self.regions_file)
        return p if p.is_absolute() else REPO_ROOT / p


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
