"""Alembic environment for the control-plane database. Runs as the owner role."""

from alembic import context
from sqlalchemy import create_engine

from astra_migrate.config import get_settings
from astra_migrate.db.models import Base

settings = get_settings()
url = (settings.control_db_owner_url or settings.control_db_url).get_secret_value()

connectable = create_engine(url)
with connectable.connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()
