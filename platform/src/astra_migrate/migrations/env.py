"""Alembic environment for the control-plane database. Runs as the owner role."""

from alembic import context
from sqlalchemy import create_engine

from astra_migrate.config import get_settings
from astra_migrate.db.models import Base

settings = get_settings()
url = (settings.control_db_owner_url or settings.control_db_url).get_secret_value()

RAW_SQL_TABLES = {"onto_concepts", "onto_relations", "onto_code_lists", "onto_bindings", "onto_precedents"}


def include_object(obj: object, name: str | None, type_: str, reflected: bool, compare_to: object) -> bool:
    """Tables managed in raw SQL (vector columns) are not compared by autogenerate."""
    table = getattr(obj, "table", None)
    table_name = name if type_ == "table" else getattr(table, "name", None)
    return table_name not in RAW_SQL_TABLES


connectable = create_engine(url)
with connectable.connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True,
                      include_object=include_object)
    with context.begin_transaction():
        context.run_migrations()
