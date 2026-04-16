from pathlib import Path

from sqlalchemy import inspect

from mriqc_aggregator.database import create_database_engine, create_database_schema


def test_create_database_engine_accepts_explicit_url() -> None:
    engine = create_database_engine("sqlite+pysqlite:///:memory:")
    assert str(engine.url) == "sqlite+pysqlite:///:memory:"


def test_create_database_schema_creates_expected_tables() -> None:
    database_path = Path("test-schema.db")
    database_url = f"sqlite+pysqlite:///{database_path}"
    create_database_schema(database_url)

    engine = create_database_engine(database_url)
    inspector = inspect(engine)
    assert set(inspector.get_table_names()) == {"bold", "t1w", "t2w"}
    database_path.unlink()
