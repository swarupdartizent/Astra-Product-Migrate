"""Reuse the platform test fixtures (real stack, in-process identity provider, test control database).

Run from the platform folder:
    .venv/Scripts/python -m pytest -c pyproject.toml ../programmes/conceptone-prosuite/tests
"""

from tests.conftest import _migrated, admin, client, tenant_factory, user_factory  # noqa: F401
